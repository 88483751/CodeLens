"""Integration checks for the account-scoped review service."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import time
import unittest
from uuid import uuid4

from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo

from deploy.sync.service import COOKIE, create_app, database, migrate_sqlite, password_hash, token_hash


ORIGIN = "https://codelens.example"
DIGEST = "a" * 64
PREFIX = "/api/sync"
TEST_DSN = os.environ.get("CODELENS_TEST_POSTGRES_DSN")


@unittest.skipUnless(TEST_DSN, "set CODELENS_TEST_POSTGRES_DSN to run PostgreSQL integration tests")
class BrowserSyncTests(unittest.TestCase):
    def setUp(self):
        name = "test_sync_" + uuid4().hex
        schema = sql.Identifier(name)
        with database(TEST_DSN) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
        self.addCleanup(self.drop_schema, schema)
        self.dsn = make_conninfo(TEST_DSN, options="-c search_path=" + name)
        self.app = create_app(self.dsn, ORIGIN)

    @staticmethod
    def drop_schema(schema):
        with database(TEST_DSN) as db:
            db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(schema))

    def seed_accounts(self):
        with database(self.dsn) as db:
            for name in ("alice", "bob"):
                salt = name.encode()
                db.execute("INSERT INTO accounts(username,salt,password) VALUES(%s,%s,%s)",
                           (name, salt, password_hash("long-test-password", salt)))

    def client(self, user):
        client = TestClient(self.app, base_url=ORIGIN,
                            headers={"Origin": ORIGIN, "X-CodeLens-Account": user})
        self.addCleanup(client.close)
        reply = client.post(PREFIX + "/login", json={"username": user, "password": "long-test-password"})
        self.assertEqual(reply.status_code, 200)
        self.assertIn("HttpOnly", reply.headers["set-cookie"])
        self.assertIn("Secure", reply.headers["set-cookie"])
        return client

    @staticmethod
    def snapshot():
        return {"id": 42, "fingerprint": DIGEST, "project": "Test",
                "report": {"project": "Test", "summary": {"parsed": 1}, "files": [{"path": "a.py"}],
                           "graph": {"dependencies": [{"source": "a", "target": "b"}]}}}

    def test_account_isolation_and_restart(self):
        self.seed_accounts()
        alice = self.client("alice")
        bob = self.client("bob")
        runs = PREFIX + "/runs"
        self.assertEqual(alice.put(runs, json=self.snapshot()).status_code, 200)
        checkpoint = runs + "/42/checkpoint/" + DIGEST + "/source-0"
        self.assertEqual(alice.put(checkpoint, json={"text": "Note", "limited": False}).status_code, 200)
        self.assertEqual(alice.get(PREFIX + "/resume/" + DIGEST).json(), {"id": 42})
        self.assertEqual(bob.get(runs + "/42").status_code, 404)
        self.assertEqual(bob.get(checkpoint).status_code, 404)
        self.assertEqual(alice.get(runs, headers={"X-CodeLens-Account": "bob"}).status_code, 401)
        self.assertEqual(alice.put(runs, headers={"Origin": "https://other.example"}, json=self.snapshot()).status_code, 403)
        self.assertEqual(alice.put(runs + "/42/review", json={"status": "done", "review": {"sections": {}}}).status_code, 200)
        self.assertEqual(alice.put(runs + "/42/scoped", json={"target": "file:a.py", "review": {"scope": "file"}}).status_code, 200)
        self.app = create_app(self.dsn, ORIGIN)
        reopened = self.client("alice")
        self.assertEqual(reopened.get(checkpoint).json(), {"value": {"text": "Note", "limited": False}})
        self.assertEqual(reopened.get(runs + "/42").json()["ai_status"], "done")
        self.assertEqual(reopened.get(runs + "/42").json()["scoped"], {"file:a.py": {"scope": "file"}})
        self.assertEqual(reopened.delete(runs + "/42").status_code, 200)
        self.assertEqual(reopened.put(runs, json=self.snapshot()).status_code, 410)
        self.assertEqual(reopened.get(runs).json(), [])

    def test_source_and_credentials_rejected(self):
        self.seed_accounts()
        alice = self.client("alice")
        snapshot = self.snapshot()
        snapshot["report"]["files"][0]["source"] = "print('private')"
        self.assertEqual(alice.put(PREFIX + "/runs", json=snapshot).status_code, 422)
        del snapshot["report"]["files"][0]["source"]
        snapshot["report"]["settings"] = {"apiKey": "secret"}
        self.assertEqual(alice.put(PREFIX + "/runs", json=snapshot).status_code, 422)
        self.assertEqual(alice.get(PREFIX + "/runs").json(), [])

    def test_sqlite_migration_preserves_login_history_and_sequence(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "legacy.sqlite3"
            with closing(sqlite3.connect(path)) as source, source:
                source.executescript("""
                    CREATE TABLE accounts(id, username, salt, password);
                    CREATE TABLE sessions(token, owner, expires);
                    CREATE TABLE runs(owner, id, fingerprint, project, created, report, status, review);
                    CREATE TABLE checkpoints(owner, run, fingerprint, step, payload);
                    CREATE TABLE deleted_runs(owner, id);
                    CREATE TABLE scoped_reviews(owner, run, target, payload);
                """)
                salt = b"legacy-salt"
                source.execute("INSERT INTO accounts VALUES (17, 'alice', ?, ?)",
                               (salt, password_hash("long-test-password", salt)))
                source.execute("INSERT INTO sessions VALUES (?, 17, ?)",
                               (token_hash("existing-session"), int(time.time()) + 300))
                source.execute("INSERT INTO runs VALUES (17, 42, ?, 'Test', '2026-01-01T00:00:00Z', ?, 'paused', NULL)",
                               (DIGEST, json.dumps(self.snapshot()["report"])))
                source.execute("INSERT INTO checkpoints VALUES (17, 42, ?, 'source-0', ?)",
                               (DIGEST, '{"text":"saved","limited":false}'))
                source.execute("INSERT INTO deleted_runs VALUES (17, 99)")
                source.execute("INSERT INTO scoped_reviews VALUES (17, 42, 'file:a.py', ?)", ('{"scope":"file"}',))
            original = path.read_bytes()
            self.assertEqual(list(migrate_sqlite(path, self.dsn).values()), [1] * 6)
            self.assertEqual(path.read_bytes(), original)
            with self.assertRaises(ValueError):
                migrate_sqlite(path, self.dsn)
        alice = self.client("alice")
        with TestClient(self.app, base_url=ORIGIN, cookies={COOKIE: "existing-session"}) as existing:
            self.assertEqual(existing.get(PREFIX + "/session").json(), {"username": "alice"})
        self.assertEqual(alice.get(PREFIX + "/resume/" + DIGEST).json(), {"id": 42})
        run = PREFIX + "/runs/42"
        self.assertEqual(alice.get(run).json()["scoped"], {"file:a.py": {"scope": "file"}})
        self.assertEqual(alice.get(run + "/checkpoint/" + DIGEST + "/source-0").json(),
                         {"value": {"text": "saved", "limited": False}})
        deleted = dict(self.snapshot(), id=99)
        self.assertEqual(alice.put(PREFIX + "/runs", json=deleted).status_code, 410)
        with database(self.dsn) as db:
            row = db.execute("INSERT INTO accounts(username,salt,password) VALUES ('next',%s,%s) RETURNING id",
                             (b"salt", b"hash")).fetchone()
        self.assertGreater(row["id"], 17)
