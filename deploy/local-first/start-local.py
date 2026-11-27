"""Start the downloaded CodeLens workbench on the user's computer."""

import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import venv


def user_data_dir():
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "CodeLens"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "CodeLens"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "codelens"


def prepare_python(data, requirements):
    runtime = data / f"venv-{sys.version_info.major}.{sys.version_info.minor}"
    python = runtime / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        venv.EnvBuilder(with_pip=True).create(runtime)
    stamp = runtime / "requirements.sha256"
    expected = hashlib.sha256(requirements.read_bytes()).hexdigest()
    if not stamp.is_file() or stamp.read_text(encoding="ascii") != expected:
        print("正在安装 CodeLens 本机依赖…", flush=True)
        subprocess.run([str(python), "-m", "pip", "install", "-r", str(requirements)], check=True)
        stamp.write_text(expected, encoding="ascii")
    return python


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--migrate-sqlite", action="store_true", help="导入旧版本机历史和审查检查点")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        raise SystemExit("请安装 Python 3.11 或以上版本。")
    if not os.environ.get("CODELENS_LOCAL_DATABASE_URL"):
        raise SystemExit("请先设置 CODELENS_LOCAL_DATABASE_URL，指向本机版的 PostgreSQL 数据库。")
    root = Path(__file__).resolve().parent
    web = root / "codelens-prototype" / "dist"
    if not (web / "index.html").is_file():
        raise SystemExit("前端文件缺失，请完整解压 CodeLens 发布包。")
    data = user_data_dir()
    data.mkdir(parents=True, exist_ok=True)
    python = prepare_python(data, root / "requirements-backend.txt")
    if args.migrate_sqlite:
        return subprocess.call([str(python), "-B", str(root / "code" / "backend" / "migrate_local_sqlite.py"),
                                "--data-dir", str(data)], cwd=root)
    print("请在浏览器打开 http://127.0.0.1:18766/ ，使用期间保持此窗口打开。", flush=True)
    return subprocess.call([str(python), "-B", str(root / "code" / "backend" / "asgi.py"),
                            "--web-dir", str(web), "--log-file", str(data / "codelens.log")],
                           cwd=root)


if __name__ == "__main__":
    raise SystemExit(main())
