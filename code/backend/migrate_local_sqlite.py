"""Import the old workstation SQLite files into an empty local PostgreSQL database."""

import argparse
from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3
import sys

from psycopg import Error, sql

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.local_database import connect, start_database


_HISTORY = {
    "project": ("id", "name", "created"),
    "version": ("project_id", "digest", "files"),
    "analysis": ("id", "project_id", "version", "created", "report", "changes", "issues", "ai", "ai_status"),
    "project_checkpoint": ("project_id", "fingerprint", "data", "updated"),
}
_REVIEWS = {"review_checkpoint": ("fingerprint", "payload", "updated")}


@contextmanager
def _snapshot(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as source:
        source.execute("BEGIN")
        yield source


def _copy_tables(source, target, tables):
    counts = {}
    for table, columns in tables.items():
        select = "SELECT " + ", ".join(columns) + " FROM " + table
        insert = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
            sql.Identifier(table), sql.SQL(", ").join(map(sql.Identifier, columns)),
            sql.SQL(", ").join(sql.Placeholder() for _ in columns),
        )
        with target.cursor() as cursor:
            cursor.executemany(insert, source.execute(select))
            counts[table] = cursor.rowcount
    return counts


def _import_history(path, target):
    with _snapshot(path) as source:
        counts = _copy_tables(source, target, _HISTORY)
        next_id = source.execute("""
            SELECT max(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'analysis'), 0),
                       COALESCE((SELECT max(id) FROM analysis), 0)) + 1
        """).fetchone()[0]
        target.execute(sql.SQL("ALTER TABLE analysis ALTER COLUMN id RESTART WITH {}").format(sql.Literal(next_id)))
    return counts


def migrate(dsn, history_path=None, review_path=None):
    if history_path is None and review_path is None:
        raise ValueError("没有找到旧版 SQLite 文件。")
    with connect(dsn, write=True) as target:
        tables = (*_HISTORY, *_REVIEWS)
        for table in tables:
            if target.execute(sql.SQL("SELECT 1 FROM {} LIMIT 1").format(sql.Identifier(table))).fetchone():
                raise ValueError("目标 PostgreSQL 已包含本机记录，请用空数据库进行迁移。")
        counts = _import_history(history_path, target) if history_path is not None else {}
        if review_path is not None:
            with _snapshot(review_path) as source:
                counts.update(_copy_tables(source, target, _REVIEWS))
    return counts


def _find_reviews(directory):
    review_names = ("reviews.sqlite3", "review.sqlite3")
    candidates = [directory / name for name in review_names if (directory / name).is_file()]
    if len(candidates) > 1:
        raise ValueError("发现两份旧版审查数据库，请用 --reviews 指定要导入的文件。")
    return next(iter(candidates), None)


def _legacy_files(args):
    history = args.history or args.data_dir / "history.sqlite3"
    if args.history is None and not history.is_file():
        history = None
    return history, args.reviews or _find_reviews(args.data_dir)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[2] / "data")
    parser.add_argument("--history", type=Path, help="指定旧项目历史 SQLite 文件")
    parser.add_argument("--reviews", type=Path, help="指定旧审查缓存 SQLite 文件")
    args = parser.parse_args()
    try:
        history, reviews = _legacy_files(args)
        result = migrate(start_database(), history, reviews)
    except (ValueError, sqlite3.Error) as exc:
        parser.error(str(exc))
    except Error as exc:
        parser.error(f"导入 PostgreSQL 失败，已回滚本次导入（{type(exc).__name__}）。")
    for table, count in result.items():
        print(f"{table}: {count}")


if __name__ == "__main__":
    main()
