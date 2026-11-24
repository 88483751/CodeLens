"""Integration checks for the account-scoped review service."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from fastapi.testclient import TestClient

from deploy.sync.service import create_app, database, password_hash


ORIGIN = "https://codelens.example"
DIGEST = "a" * 64
PREFIX = "/api/sync"


class BrowserSyncTests(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "test.sqlite3"
        self.app = create_app(self.path, ORIGIN)
        with database(self.path) as db:
            for name in ("alice", "bob"):
                salt = name.encode()
                db.execute("INSERT INTO accounts(username,salt,password) VALUES(?,?,?)",
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
        self.app = create_app(self.path, ORIGIN)
        reopened = self.client("alice")
        self.assertEqual(reopened.get(checkpoint).json(), {"value": {"text": "Note", "limited": False}})
        self.assertEqual(reopened.get(runs + "/42").json()["ai_status"], "done")
        self.assertEqual(reopened.get(runs + "/42").json()["scoped"], {"file:a.py": {"scope": "file"}})
        self.assertEqual(reopened.delete(runs + "/42").status_code, 200)
        self.assertEqual(reopened.put(runs, json=self.snapshot()).status_code, 410)
        self.assertEqual(reopened.get(runs).json(), [])

    def test_source_and_credentials_rejected(self):
        alice = self.client("alice")
        snapshot = self.snapshot()
        snapshot["report"]["files"][0]["source"] = "print('private')"
        self.assertEqual(alice.put(PREFIX + "/runs", json=snapshot).status_code, 422)
        del snapshot["report"]["files"][0]["source"]
        snapshot["report"]["settings"] = {"apiKey": "secret"}
        self.assertEqual(alice.put(PREFIX + "/runs", json=snapshot).status_code, 422)
        self.assertEqual(alice.get(PREFIX + "/runs").json(), [])
