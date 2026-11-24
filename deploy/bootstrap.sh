#!/usr/bin/env bash
# CodeLens 服务器端一键部署脚本
# 适用：Alibaba Cloud Linux 3 / Anolis / CentOS Stream / Ubuntu 22.04+
# 用法：sudo bash /tmp/bootstrap.sh /tmp/codelens-src.tar.gz
# 幂等：可重复执行，用于升级代码后重启服务
set -euo pipefail

APP_DIR=/opt/codelens/app
VENV_DIR=/opt/codelens/venv
RUN_USER=codelens
API_PORT=18766
WEB_PORT=8080
SRC_TGZ=${1:-/tmp/codelens-src.tar.gz}

log()  { printf '\n\033[1;36m[%s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\n\033[1;33m[WARN] %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m[FAIL] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash /tmp/bootstrap.sh $SRC_TGZ"
[ -f "$SRC_TGZ" ] || die "找不到源码包 $SRC_TGZ，请先在本机执行 deploy/pack.ps1 上传"

# ---------------------------------------------------------------- 1. 系统信息
. /etc/os-release
log "操作系统：$PRETTY_NAME"
MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
log "内存：${MEM_MB} MB　CPU：$(nproc) 核"

# ---------------------------------------------------------------- 2. 基础软件
install_base() {
  case "${ID,,}" in
    ubuntu|debian)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y -qq
      apt-get install -y -qq python3 python3-venv python3-pip nginx curl ca-certificates software-properties-common >/dev/null
      if ! command -v python3.11 >/dev/null 2>&1; then
        log "安装 Python 3.11（deadsnakes PPA）"
        add-apt-repository -y ppa:deadsnakes/ppa >/dev/null
        apt-get update -y -qq
        apt-get install -y -qq python3.11 python3.11-venv python3.11-dev >/dev/null
      fi
      ;;
    *)
      log "安装基础软件（dnf）"
      dnf install -y -q nginx curl ca-certificates tar >/dev/null
      if ! command -v python3.11 >/dev/null 2>&1; then
        log "安装 Python 3.11"
        dnf install -y -q python3.11 python3.11-pip python3.11-devel >/dev/null \
          || die "python3.11 安装失败。请执行 dnf module list python3.11 检查源，或改用 Ubuntu 镜像"
      fi
      ;;
  esac
}

need_install=0
for bin in nginx curl; do command -v "$bin" >/dev/null 2>&1 || need_install=1; done
command -v python3.11 >/dev/null 2>&1 || need_install=1
[ "$need_install" -eq 1 ] && install_base || log "基础软件已就绪"

PY_BIN=$(command -v python3.11) || die "未找到 python3.11"
"$PY_BIN" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3,11) else 1)' \
  || die "Python 版本低于 3.11，请检查 $PY_BIN"

# ---------------------------------------------------------------- 3. Swap 兜底
if [ "$MEM_MB" -lt 3000 ] && ! swapon --show 2>/dev/null | grep -q .; then
  log "内存 ${MEM_MB}MB 偏小，创建 2GB swap 防止 OOM"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- 4. 运行用户
id -u "$RUN_USER" >/dev/null 2>&1 || useradd -r -m -s /sbin/nologin "$RUN_USER"
log "运行用户：$RUN_USER"

# ---------------------------------------------------------------- 5. 解压代码
log "解压源码到 $APP_DIR"
mkdir -p "$APP_DIR"
tar -xzf "$SRC_TGZ" -C "$APP_DIR"

# 源码包可能经过 Windows 打包，统一去掉 CRLF，避免 systemd / nginx 解析失败
for f in "$APP_DIR/deploy/codelens.service" "$APP_DIR/deploy/nginx-codelens.conf"; do
  [ -f "$f" ] && sed -i 's/\r$//' "$f"
done

mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
[ -d "$APP_DIR/code/backend" ] || die "源码包结构异常，缺少 code/backend"
[ -f "$APP_DIR/codelens-prototype/dist/index.html" ] \
  || die "源码包缺少 codelens-prototype/dist，请先在本机 npm run build 后再打包"

# ---------------------------------------------------------------- 6. 依赖安装
if [ ! -x "$VENV_DIR/bin/python" ]; then
  log "创建虚拟环境"
  "$PY_BIN" -m venv "$VENV_DIR"
fi
log "安装 Python 依赖（首次约 2-4 分钟）"
"$VENV_DIR/bin/pip" install -q --upgrade pip >/dev/null
"$VENV_DIR/bin/pip" install -q -r "$APP_DIR/requirements-backend.txt"
"$VENV_DIR/bin/python" -c 'import fastapi, uvicorn, langgraph' \
  || die "依赖导入失败，请检查 pip 输出与 Python 版本"

# ---------------------------------------------------------------- 7. systemd
log "注册 systemd 服务"
install -m 644 "$APP_DIR/deploy/codelens.service" /etc/systemd/system/codelens.service
systemctl daemon-reload
systemctl enable codelens >/dev/null 2>&1 || true
systemctl restart codelens

# ---------------------------------------------------------------- 8. Nginx
log "配置 Nginx（监听 ${WEB_PORT}）"
install -m 644 "$APP_DIR/deploy/nginx-codelens.conf" /etc/nginx/conf.d/codelens.conf
nginx -t 2>&1 | sed 's/^/    /'
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

# ---------------------------------------------------------------- 9. 防火墙/SELinux
if systemctl is-active --quiet firewalld 2>/dev/null; then
  log "放行防火墙 ${WEB_PORT}/tcp"
  firewall-cmd --add-port="${WEB_PORT}/tcp" --permanent >/dev/null || true
  firewall-cmd --reload >/dev/null || true
fi
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  log "SELinux 处于 Enforcing，放行 Nginx 反代权限"
  setsebool -P httpd_can_network_connect 1 || warn "setsebool 失败，若出现 502 请手动处理"
fi

# ---------------------------------------------------------------- 10. 权限与自检
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR" "$VENV_DIR"

log "等待服务启动"
ok_api=0; ok_web=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:${API_PORT}/api/status" 2>/dev/null; then ok_api=1; fi
  if [ "$ok_web" -eq 0 ] && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null)" = "200" ]; then ok_web=1; fi
  [ "$ok_api" -eq 1 ] && [ "$ok_web" -eq 1 ] && break
  sleep 1
done

PUBIP=$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || echo "<公网IP>")
echo
echo "============================================================"
if [ "$ok_api" -eq 1 ] && [ "$ok_web" -eq 1 ]; then
  echo "  部署成功"
else
  echo "  部署完成但自检未全部通过，请执行排查命令："
  echo "    journalctl -u codelens -n 60 --no-pager"
  echo "    tail -n 40 $APP_DIR/logs/codelens.log"
  echo "    curl -v http://127.0.0.1:${API_PORT}/api/status"
fi
echo "  访问地址 : http://${PUBIP}:${WEB_PORT}/"
echo "  后端接口 : 127.0.0.1:${API_PORT}（仅本机，由 Nginx 反代）"
echo "  代码目录 : ${APP_DIR}"
echo "  历史数据 : ${APP_DIR}/data/*.sqlite3"
echo "------------------------------------------------------------"
echo "  提醒：请确认 ECS 安全组入方向已放行 TCP ${WEB_PORT}"
echo "============================================================"
