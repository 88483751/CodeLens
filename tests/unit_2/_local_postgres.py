"""Give each local persistence test its own PostgreSQL schema."""

import os
from uuid import uuid4

from psycopg import sql
from psycopg.conninfo import make_conninfo

from backend.local_database import connect, initialize


def isolated_local_dsn(test):
    dsn = os.environ.get("CODELENS_TEST_POSTGRES_DSN")
    if not dsn:
        test.skipTest("set CODELENS_TEST_POSTGRES_DSN to test local PostgreSQL storage")
    name = "test_local_" + uuid4().hex
    schema = sql.Identifier(name)
    with connect(dsn) as db:
        db.execute(sql.SQL("CREATE SCHEMA {}").format(schema))
    test.addCleanup(_drop_schema, dsn, schema)
    isolated = make_conninfo(dsn, options="-c search_path=" + name)
    initialize(isolated)
    return isolated


def _drop_schema(dsn, schema):
    with connect(dsn) as db:
        db.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(schema))
