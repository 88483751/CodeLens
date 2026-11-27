"""Local PostgreSQL storage for completed reviews and resumable reading notes."""

import json
from backend.local_database import connect


MAX_CHECKPOINTS = 256


class ReviewStore:
    def __init__(self, dsn):
        self.dsn = dsn

    def load(self, fingerprint):
        with connect(self.dsn) as db:
            row = db.execute("SELECT payload FROM review_checkpoint WHERE fingerprint = %s", (fingerprint,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def save(self, fingerprint, checkpoint, updated):
        payload = json.dumps(checkpoint, ensure_ascii=True, separators=(",", ":"))
        with connect(self.dsn, write=True) as db:
            db.execute(
                """INSERT INTO review_checkpoint (fingerprint, payload, updated) VALUES (%s, %s, %s)
                   ON CONFLICT(fingerprint) DO UPDATE SET payload = excluded.payload, updated = excluded.updated""",
                (fingerprint, payload, updated),
            )
            db.execute(
                """DELETE FROM review_checkpoint WHERE fingerprint IN (
                       SELECT fingerprint FROM review_checkpoint
                       ORDER BY updated DESC, fingerprint OFFSET %s
                   )""",
                (MAX_CHECKPOINTS,),
            )
