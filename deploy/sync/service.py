"""Account-scoped storage for the browser workbench."""
import argparse
from contextlib import closing, contextmanager
import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

PREFIX = "/api/sync"
COOKIE = "__Host-codelens"
SESSION_SECONDS = 30 * 24 * 60 * 60
MAX_RUN_ID = 2**53 - 1
Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
RunId = Annotated[int, Field(gt=0, le=MAX_RUN_ID)]
SNAPSHOT_LIMIT = 4 * 1024 * 1024

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    salt BLOB NOT NULL, password BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token BLOB PRIMARY KEY, owner INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
CREATE TABLE IF NOT EXISTS runs (
    owner INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id INTEGER NOT NULL, fingerprint TEXT NOT NULL, project TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    report TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'not_run', review TEXT,
    PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS runs_fingerprint ON runs(owner, fingerprint, created DESC);
CREATE TABLE IF NOT EXISTS checkpoints (
    owner INTEGER NOT NULL, run INTEGER NOT NULL, fingerprint TEXT NOT NULL, step TEXT NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(owner, run, fingerprint, step),
    FOREIGN KEY(owner, run) REFERENCES runs(owner, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS deleted_runs (
    owner INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id INTEGER NOT NULL, PRIMARY KEY(owner, id)
);
CREATE TABLE IF NOT EXISTS scoped_reviews (
    owner INTEGER NOT NULL, run INTEGER NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(owner, run, target),
    FOREIGN KEY(owner, run) REFERENCES runs(owner, id) ON DELETE CASCADE
);
"""


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Credentials(Payload):
    username: Annotated[str, Field(pattern=r"^[a-zA-Z0-9._-]{1,64}$")]
    password: Annotated[str, Field(min_length=1, max_length=256)]


class Snapshot(Payload):
    id: RunId
    fingerprint: Digest
    project: Annotated[str, Field(min_length=1, max_length=120)]
    report: dict


class Review(Payload):
    status: Literal["running", "paused", "failed", "done"]
    review: dict | None = None


class Checkpoint(Payload):
    text: Annotated[str, Field(min_length=1, max_length=24000)]
    limited: bool


class Scoped(Payload):
    target: Annotated[str, Field(pattern=r"^(file|folder):.{1,2000}$")]
    review: dict


@contextmanager
def database(path):
    with closing(sqlite3.connect(path, timeout=10)) as db, db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        yield db


def initialize(path):
    with database(path) as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.executescript(SCHEMA)


def password_hash(password, salt):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=32768, r=8, p=1, maxmem=64 * 1024 * 1024)


def token_hash(token):
    return hashlib.sha256(token.encode()).digest()


def public_json(value, limit=SNAPSHOT_LIMIT):
    # Enforce the storage boundary even if a client bypasses frontend filtering.
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            forbidden = {"content", "content_base64", "apikey", "api_key", "baseurl",
                         "base_url", "authorization", "provider", "password", "token"}
            if forbidden.intersection(key.lower() for key in item):
                raise HTTPException(422, "记录包含不可同步的字段")
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (ValueError, RecursionError):
        raise HTTPException(422, "记录格式无效") from None
    if len(encoded.encode("utf-8")) > limit:
        raise HTTPException(413, "记录超出同步大小限制")
    return encoded


def validate_snapshot(snapshot):
    report = snapshot.report
    if report.get("project") != snapshot.project or not isinstance(report.get("summary"), dict):
        raise HTTPException(422, "分析快照格式无效")
    files = report.get("files")
    if not isinstance(files, list) or any(not isinstance(file, dict) or "source" in file for file in files):
        raise HTTPException(422, "分析快照不可包含原始源码")
    return public_json(report)


def serialize_review(payload):
    if (payload.status == "done") != (payload.review is not None):
        raise HTTPException(422, "审查状态与结果不一致")
    return public_json(payload.review, 512 * 1024) if payload.review is not None else None


def account(path, request):
    token = request.cookies.get(COOKIE, "")
    with database(path) as db:
        user = db.execute(
            "SELECT a.id, a.username FROM sessions s JOIN accounts a ON a.id=s.owner "
            "WHERE s.token=? AND s.expires>?", (token_hash(token), int(time.time())),
        ).fetchone()
    if user is None:
        raise HTTPException(401, "请登录后查看和同步审查记录")
    if request.headers.get("x-codelens-account") != user["username"] and request.url.path != PREFIX + "/session":
        raise HTTPException(401, "登录账号已变更，请重新登录")
    return user


def owned_run(db, owner, run_id):
    row = db.execute("SELECT * FROM runs WHERE owner=? AND id=?", (owner, run_id)).fetchone()
    if row is None:
        if db.execute("SELECT 1 FROM deleted_runs WHERE owner=? AND id=?", (owner, run_id)).fetchone():
            raise HTTPException(410, "审查记录已删除")
        raise HTTPException(404, "审查记录不存在")
    return row


def list_row(row):
    return {"id": row["project"], "name": row["project"], "runs": 1, "analysis_id": row["id"],
            "updated": row["created"], "ai_status": row["status"]}


def create_app(path, origin):
    initialize(path)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(RequestValidationError)
    async def invalid_input(_request, _error):
        return JSONResponse({"detail": "请求数据格式无效"}, status_code=422)

    @app.middleware("http")
    async def headers(request, call_next):
        if request.method not in ("GET", "HEAD") and request.headers.get("origin") != origin:
            return Response(status_code=403, headers={"Cache-Control": "no-store"})
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get(PREFIX + "/health")
    def health():
        return {"ready": True}

    @app.get(PREFIX + "/session")
    def session(request: Request):
        return {"username": account(path, request)["username"]}

    @app.post(PREFIX + "/login")
    def login(body: Credentials, response: Response):
        with database(path) as db:
            user = db.execute("SELECT * FROM accounts WHERE username=?", (body.username,)).fetchone()
        digest = password_hash(body.password, user["salt"] if user else b"codelens-dummy-salt")
        if user is None or not hmac.compare_digest(user["password"], digest):
            raise HTTPException(401, "用户名或密码错误")
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with database(path) as db:
            db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token_hash(token), user["id"], now + SESSION_SECONDS))
        response.set_cookie(COOKIE, token, secure=True, httponly=True, samesite="strict", max_age=SESSION_SECONDS)
        return {"username": user["username"]}

    @app.post(PREFIX + "/logout")
    def logout(request: Request, response: Response):
        account(path, request)
        with database(path) as db:
            db.execute("DELETE FROM sessions WHERE token=?", (token_hash(request.cookies.get(COOKIE, "")),))
        response.delete_cookie(COOKIE, secure=True, httponly=True, samesite="strict")
        return {"ok": True}

    @app.get(PREFIX + "/runs")
    def runs(request: Request):
        owner = account(path, request)["id"]
        with database(path) as db:
            rows = db.execute(
                "SELECT id, project, created, status FROM runs WHERE owner=? ORDER BY created DESC, rowid DESC",
                (owner,),
            )
            return [list_row(row) for row in rows]

    @app.get(PREFIX + "/resume/{fingerprint}")
    def resume(fingerprint: Digest, request: Request):
        owner = account(path, request)["id"]
        with database(path) as db:
            row = db.execute(
                "SELECT id FROM runs WHERE owner=? AND fingerprint=? AND (status IN ('paused','failed','running') "
                "OR (status='not_run' AND EXISTS (SELECT 1 FROM checkpoints c WHERE c.owner=runs.owner AND c.run=runs.id))) "
                "ORDER BY created DESC, rowid DESC LIMIT 1", (owner, fingerprint),
            ).fetchone()
        return {"id": row["id"] if row else None}

    @app.put(PREFIX + "/runs")
    def put_run(snapshot: Snapshot, request: Request):
        owner = account(path, request)["id"]
        encoded = validate_snapshot(snapshot)
        with database(path) as db:
            db.execute(
                "INSERT OR IGNORE INTO runs(owner,id,fingerprint,project,report) "
                "SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM deleted_runs WHERE owner=? AND id=?)",
                (owner, snapshot.id, snapshot.fingerprint, snapshot.project, encoded, owner, snapshot.id),
            )
            row = owned_run(db, owner, snapshot.id)
            if row["fingerprint"] != snapshot.fingerprint:
                raise HTTPException(409, "审查记录编号冲突")
        return {"ok": True}

    @app.get(PREFIX + "/runs/{run_id}")
    def detail(run_id: RunId, request: Request):
        owner = account(path, request)["id"]
        with database(path) as db:
            row = owned_run(db, owner, run_id)
            scoped = db.execute("SELECT target,payload FROM scoped_reviews WHERE owner=? AND run=?",
                                (owner, run_id)).fetchall()
        return {"report": json.loads(row["report"]), "ai": json.loads(row["review"] or "null"),
                "ai_status": row["status"], "scoped": {item["target"]: json.loads(item["payload"]) for item in scoped},
                "issues": [],
                "changes": {"baseline": None, "added": [], "modified": [], "missing": []}}

    @app.delete(PREFIX + "/runs/{run_id}")
    def delete(run_id: RunId, request: Request):
        owner = account(path, request)["id"]
        with database(path) as db:
            db.execute("INSERT OR IGNORE INTO deleted_runs VALUES (?, ?)", (owner, run_id))
            db.execute("DELETE FROM runs WHERE owner=? AND id=?", (owner, run_id))
        return {"deleted": True}

    @app.put(PREFIX + "/runs/{run_id}/review")
    def put_review(run_id: RunId, body: Review, request: Request):
        owner = account(path, request)["id"]
        encoded = serialize_review(body)
        with database(path) as db:
            owned_run(db, owner, run_id)
            db.execute("UPDATE runs SET status=?, review=? WHERE owner=? AND id=? AND status <> 'done'",
                       (body.status, encoded, owner, run_id))
        return {"ok": True}

    @app.put(PREFIX + "/runs/{run_id}/scoped")
    def put_scoped(run_id: RunId, body: Scoped, request: Request):
        owner = account(path, request)["id"]
        encoded = public_json(body.review, 128 * 1024)
        with database(path) as db:
            owned_run(db, owner, run_id)
            db.execute(
                "INSERT INTO scoped_reviews VALUES (?,?,?,?) ON CONFLICT(owner,run,target) "
                "DO UPDATE SET payload=excluded.payload", (owner, run_id, body.target, encoded),
            )
        return {"ok": True}

    @app.get(PREFIX + "/runs/{run_id}/checkpoint/{fingerprint}/{step}")
    def read_checkpoint(run_id: RunId, fingerprint: Digest, step: str, request: Request):
        owner = account(path, request)["id"]
        with database(path) as db:
            owned_run(db, owner, run_id)
            row = db.execute("SELECT payload FROM checkpoints WHERE owner=? AND run=? AND fingerprint=? AND step=?",
                             (owner, run_id, fingerprint, step)).fetchone()
        return {"value": json.loads(row["payload"]) if row else None}

    @app.put(PREFIX + "/runs/{run_id}/checkpoint/{fingerprint}/{step}")
    def put_checkpoint(run_id: RunId, fingerprint: Digest, step: str, body: Checkpoint, request: Request):
        owner = account(path, request)["id"]
        if not re.fullmatch(r"(?:source-[0-9]+|compact-[0-9]+-[0-9]+|section-(?:logic|design|risks))", step):
            raise HTTPException(422, "检查点阶段无效")
        with database(path) as db:
            owned_run(db, owner, run_id)
            db.execute("INSERT OR IGNORE INTO checkpoints VALUES (?, ?, ?, ?, ?)",
                       (owner, run_id, fingerprint, step, body.model_dump_json()))
        return {"ok": True}

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve", "add-user", "backup"])
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    path = Path(os.environ.get("CODELENS_SYNC_DB", "/data/history.sqlite3"))
    if args.command == "serve":
        import uvicorn
        origin = os.environ["CODELENS_SYNC_ORIGIN"]
        uvicorn.run(create_app(path, origin), host="127.0.0.1", port=18767, proxy_headers=False, access_log=False)
    elif args.command == "backup":
        if not args.value:
            parser.error("backup 需要指定目标文件")
        with database(path) as source, closing(sqlite3.connect(args.value)) as target:
            source.backup(target)
    else:
        if not args.value or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", args.value):
            parser.error("用户名应为 1–64 位数字、字母、点、下划线或短横线")
        password = getpass.getpass("Password (at least 12 characters): ")
        if not 12 <= len(password) <= 256 or password != getpass.getpass("Confirm password: "):
            parser.error("密码长度错误或两次密码不一致")
        salt = secrets.token_bytes(16)
        initialize(path)
        with database(path) as db:
            db.execute("INSERT INTO accounts(username, salt, password) VALUES (?, ?, ?)",
                       (args.value, salt, password_hash(password, salt)))


if __name__ == "__main__":
    main()
