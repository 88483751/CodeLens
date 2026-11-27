"""Verify local PostgreSQL startup and import of both legacy SQLite stores."""

from contextlib import closing, redirect_stdout
import io
import os
from pathlib import Path
import runpy
import sqlite3
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from psycopg import OperationalError

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "code"))
from _local_postgres import isolated_local_dsn
from ai.review_store import ReviewStore
from backend.history import HistoryStore
from backend import local_database as database, migrate_local_sqlite as migration


def _legacy_history(path):
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript("""
            CREATE TABLE project(id TEXT PRIMARY KEY, name TEXT, created TEXT);
            CREATE TABLE version(project_id TEXT, digest TEXT, files TEXT);
            CREATE TABLE analysis(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, version TEXT,
                created TEXT, report TEXT, changes TEXT, issues TEXT, ai TEXT, ai_status TEXT);
            CREATE TABLE project_checkpoint(project_id TEXT, fingerprint TEXT, data TEXT, updated REAL);
            INSERT INTO project VALUES ('project', '旧项目', '2026-11-24 00:00:00');
            INSERT INTO version VALUES ('project', 'digest', '{}');
            INSERT INTO analysis VALUES (7, 'project', 'digest', '2026-11-24 00:00:00',
                '{"files":[]}', '{"baseline":null}', '{}', '{"sections":{}}', 'done');
            UPDATE sqlite_sequence SET seq=12 WHERE name='analysis';
            INSERT INTO project_checkpoint VALUES ('project', 'read', '{"notes":["旧批次"]}', 1);
        """)


def _legacy_review(path):
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript("""
            CREATE TABLE review_checkpoint(fingerprint TEXT, payload TEXT, updated REAL);
            INSERT INTO review_checkpoint VALUES ('cached', '{"result":{"status":"done"}}', 2);
        """)


class LocalPostgresTests(unittest.TestCase):
    def test_startup_errors_do_not_expose_connection_config(self):
        with patch.dict(os.environ, {database.DSN_ENV: ""}):
            with self.assertRaisesRegex(SystemExit, database.DSN_ENV):
                database.start_database()
        with patch.dict(os.environ, {database.DSN_ENV: "private-dsn"}), \
                patch.object(database, "initialize", side_effect=OperationalError("private-dsn")):
            with self.assertRaisesRegex(SystemExit, "无法初始化本机 PostgreSQL") as error:
                database.start_database()
        self.assertNotIn("private-dsn", str(error.exception))

    def test_import_reopens_history_and_checkpoints_and_preserves_next_id(self):
        dsn = isolated_local_dsn(self)
        folder = Path(self.enterContext(TemporaryDirectory()))
        history_path, review_path = folder / "history.sqlite3", folder / "review.sqlite3"
        _legacy_history(history_path)
        _legacy_review(review_path)
        originals = [path.read_bytes() for path in (history_path, review_path)]
        argv = ["migrate_local_sqlite.py", "--data-dir", str(folder)]
        with patch.dict(os.environ, {database.DSN_ENV: dsn}), patch.object(sys, "argv", argv), \
                redirect_stdout(io.StringIO()) as output:
            runpy.run_path(migration.__file__, run_name="__main__")
        self.assertIn("analysis: 1", output.getvalue())
        self.assertIn("review_checkpoint: 1", output.getvalue())
        history = HistoryStore(dsn)
        detail = history.detail("project", 7)
        self.assertEqual((detail["ai_status"], detail["ai"]), ("done", {"sections": {}}))
        self.assertEqual(history.runs("project")[0]["created"], "2026-11-24 00:00:00")
        self.assertEqual(history.checkpoints("project").load("read"), {"notes": ["旧批次"]})
        self.assertEqual(ReviewStore(dsn).load("cached"), {"result": {"status": "done"}})
        with database.connect(dsn, write=True) as db:
            row = db.execute("""INSERT INTO analysis(project_id, version, report, changes, issues)
                                 VALUES ('project', 'digest', '{}', '{}', '{}') RETURNING id""").fetchone()
        self.assertEqual(row["id"], 13)
        self.assertEqual([path.read_bytes() for path in (history_path, review_path)], originals)
        with self.assertRaisesRegex(ValueError, "已包含本机记录"):
            migration.migrate(dsn, history_path, review_path)

    def test_invalid_second_file_rolls_back_the_first_and_allows_retry(self):
        dsn = isolated_local_dsn(self)
        folder = Path(self.enterContext(TemporaryDirectory()))
        history_path, review_path = folder / "history.sqlite3", folder / "reviews.sqlite3"
        _legacy_history(history_path)
        with self.assertRaises(sqlite3.OperationalError):
            migration.migrate(dsn, history_path, review_path)
        self.assertEqual(HistoryStore(dsn).projects(), [])
        _legacy_review(review_path)
        self.assertEqual(migration.migrate(dsn, history_path, review_path)["analysis"], 1)

    def test_migration_cli_reports_missing_ambiguous_and_invalid_files(self):
        folder = Path(self.enterContext(TemporaryDirectory()))
        history, review = folder / "history.sqlite3", folder / "reviews.sqlite3"
        argv = ["migrate_local_sqlite.py", "--data-dir", str(folder)]
        with patch.object(sys, "argv", argv), patch.object(migration, "start_database", return_value="unused"), \
                patch.object(sys, "stderr", new_callable=io.StringIO) as output:
            with self.assertRaises(SystemExit):
                migration.main()
            self.assertIn("没有找到旧版 SQLite 文件", output.getvalue())
            _legacy_review(review)
            _legacy_review(folder / "review.sqlite3")
            with self.assertRaises(SystemExit):
                migration.main()
            self.assertIn("发现两份旧版审查数据库", output.getvalue())
            argv.extend(["--history", str(history), "--reviews", str(review)])
            with patch.object(migration, "migrate", side_effect=OperationalError):
                with self.assertRaises(SystemExit):
                    migration.main()
            self.assertIn("导入 PostgreSQL 失败", output.getvalue())

    def test_review_file_can_be_imported_on_its_own(self):
        dsn = isolated_local_dsn(self)
        folder = Path(self.enterContext(TemporaryDirectory()))
        review = folder / "reviews.sqlite3"
        _legacy_review(review)
        self.assertEqual(migration.migrate(dsn, review_path=review), {"review_checkpoint": 1})
