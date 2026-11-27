# CodeLens 多人分发与本机运行

ECS 发布静态下载页和通用程序包。每位用户将程序解压到自己的电脑上运行，浏览器与分析服务通过 `127.0.0.1:18766` 通信。项目分析、报告、历史记录、审查缓存和诊断日志均在本机处理。模型地址和名称保存在本机浏览器，密钥保存在本机操作系统的凭据库。启用 AI 审查时，本机直接与用户配置的模型提供商通信，相关源码和凭据在该调用中会发给提供商。

## 发布到 Windows ECS

1. 在开发机的仓库根目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/local-first/pack.ps1`。首次构建前，在 `codelens-prototype` 目录运行 `npm ci`。
2. 将 `tmp/codelens-cloud` 中的 `index.html` 和 `codelens-local.zip` 上传到 ECS 的 `C:\codelens-site`。程序包只包含后端源码、依赖清单、启动脚本和前端构建文件。
3. 在 ECS 的 Nginx `http` 段加入本目录的 `nginx.conf`，运行 `nginx.exe -t` 检查配置后重载。该站点只提供下载页和 ZIP。已有 CodeLens 云端 API 站点时，正式发布前停用它的反向代理与应用进程。公开域名的 HTTPS 由 ECS 上的 Web 服务终止，试用时可将 `8080` 限定给测试用户。
4. 检查下载页和 ZIP 可访问，访问云端 `/api/status` 返回 `404`。用下载包在一台用户电脑上启动工作台，验证导入、AI 审查及重启后读取本机历史。

## 用户设备

解压后，在终端[配置本机 PostgreSQL](../../docs/software/local-workbench.md#本机数据库)，再运行 `py -3 start-local.py`（Windows）或 `python3 start-local.py`（macOS/Linux）。浏览器访问 `http://127.0.0.1:18766/`。首次启动需要 Python 3.11+ 和可连接的 Python 软件包源。后续解压到新目录时，沿用原数据库连接即可查看历史和审查缓存。

旧下载版的数据目录为 Windows 的 `%LOCALAPPDATA%\CodeLens`、macOS 的 `~/Library/Application Support/CodeLens` 或 Linux 的 `${XDG_DATA_HOME:-$HOME/.local/share}/codelens`。首次升级时，关闭旧版后在启动命令末尾加 `--migrate-sqlite`，将该目录中的旧库导入空 PostgreSQL。旧开发版记录在仓库的 `data/` 目录，按[迁移旧版记录](../../docs/software/local-workbench.md#迁移旧版记录)中的仓库命令处理。保存 API Key 需要该系统账户具备可用的凭据库。
