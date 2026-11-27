# CodeLens 云端审查历史版 · Linux 云服务器部署指南

本文适用于 CodeLens 的远程历史同步版，覆盖打包、上线验收、证书续期、PostgreSQL 备份和发布回滚。以下步骤面向阿里云 ECS、CentOS 7、Docker、Nginx 和公网 IPv4 证书。Linux 命令以 Workbench 中的 root 会话执行，PowerShell 命令在构建电脑执行。

> 本次部署地址使用 `https://121.41.29.215/`。中国内地服务器以 IP 对外提供网站也需要办理 ICP 备案。阿里云代备案系统受理域名备案，直接使用 IP 的网站按当地通信管理局流程办理。 [阿里云备案要求](https://help.aliyun.com/zh/icp-filing/basic-icp-service/product-overview/limits)

---

## 一、部署架构

```text
浏览器 ── HTTPS ──> Nginx
                       ├── /、/engine/      /var/www/codelens/current
                       └── /api/sync/       127.0.0.1:18767
                                            └── Docker · FastAPI
                                                └── 127.0.0.1:5432 · PostgreSQL

浏览器 ── HTTPS ──> 用户配置的模型服务（启用模型功能时）
```

| 项目 | 部署方式 |
|---|---|
| 前端 | 在构建电脑生成同步版静态产物，随发布包上传。Nginx 负责提供首页和 Pyodide/WebAssembly 引擎 |
| 后端 | `codelens-history.service` 由 systemd 托管，运行 `codelens-history:local` 容器 |
| 数据库 | PostgreSQL 16 通过回环地址连接，数据保存在 Docker 持久卷 `codelens-postgres` |
| 账号与历史 | 登录会话、审查历史和续跑检查点在后端按账号管理 |
| 模型与源码 | 审查在浏览器中运行，配置模型时由浏览器直接请求模型服务。同步记录中可包含文件路径、报告和模型生成的内容 |
| 服务地址 | Nginx 提供 TCP 443，HTTP 80 用于跳转及证书验证；FastAPI 绑定回环地址 TCP 18767 |
| 健康接口 | `GET /api/sync/health` 返回 `{"ready":true}`，用于检查服务和转发能否响应 |

## 二、服务器规格与容量

| 项目 | 本次记录与容量检查 |
|---|---|
| 宿主机 | 阿里云 ECS，CentOS 7，`x86_64` |
| 内存与交换空间 | 部署时记录为 4 GB RAM，启用约 4 GB swap。并发容量需按实际使用情况测量 |
| 磁盘 | 启用 swap 前日志显示约 33 GB 可用。为 Docker 镜像、网页发布目录、PostgreSQL、日志及备份分别预留空间 |
| 发布包 | 本次本地文件为 5,906,009 字节，约 5.6 MiB。重新打包后以生成文件为准 |

```bash
free -h
df -h / /var/lib/codelens /var/www/codelens
du -sh /var/lib/codelens /var/www/codelens/releases
docker system df
```

## 三、服务器环境准备

### 1. 检查运行环境

```bash
cat /etc/os-release
uname -m
nginx -v
docker version
systemctl is-active docker
systemctl is-active firewalld
```

若 Docker 和 Nginx 尚未安装，本次 CentOS 7 实例使用以下命令和镜像源。若 Yum 返回 404，先核对 CentOS 7 归档源和 Docker CE 仓库的可用性。CentOS 7 已结束官方维护，长期运营需要安排宿主机安全更新或系统迁移。 [CentOS 生命周期](https://www.centos.org/centos-linux/) · [阿里云 Docker 安装指南](https://help.aliyun.com/zh/ecs/user-guide/install-and-use-docker)

```bash
yum install -y yum-utils nginx &&
yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo &&
yum makecache fast &&
yum install -y docker-ce docker-ce-cli containerd.io &&
systemctl enable --now docker
```

### 2. 核对网络与目录

- ECS 安全组应对预期访问来源开放 TCP 443。使用 HTTP 跳转或 HTTP-01 证书验证时按对应来源开放 TCP 80。检查实例实际绑定的安全组和服务器防火墙区域。 [阿里云 ECS 安全组指南](https://help.aliyun.com/zh/ecs/user-guide/start-using-security-groups)
- 本次 `eth0` 使用 `public` 区域。重新部署到其他实例时，用 `ip route show default` 和 `firewall-cmd --get-active-zones` 核对。
- 约定发布包位于 `/root/codelens-sync.tar.gz`。如果 Workbench 将文件上传到 `/`，先复制到 `/root` 后再解包。

---

## 四、部署步骤

### 1. 构建并上传

在项目根目录打开 Windows PowerShell。生成的压缩包内含 `site/` 和 `server/`。

```powershell
npm --prefix codelens-prototype ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\sync\pack.ps1
Get-FileHash .\tmp\codelens-sync.tar.gz -Algorithm SHA256
```

通过阿里云 Workbench 文件管理将 `tmp/codelens-sync.tar.gz` 上传到 ECS 的 `/root`。在 Linux 终端核对哈希并解包。

```bash
archive=/root/codelens-sync.tar.gz
public_host=121.41.29.215
release="/opt/codelens-releases/$(date +%Y%m%d-%H%M%S)"

sha256sum "$archive" &&
install -d -m 0755 "$release" &&
tar -xzf "$archive" -C "$release" &&
test -s "$release/site/index.html" &&
test -s "$release/server/nginx-tls.conf"
```

后续命令沿用 `$release` 和 `$public_host`。如果 Workbench 断连，在新窗口重新设置这两个变量。用 `ls -dt /opt/codelens-releases/*/` 找到已核对的发布版本。

### 2. 构建并启动历史服务

如果旧站点的网页历史仍在 SQLite，先按 [旧库迁移步骤](../deploy/sync/README.md#从旧网页-sqlite-迁移) 备份、构建镜像并导入，再回到下方安装服务的命令。后续镜像更新先按第六章备份当前 PostgreSQL。

如果正在更新现有站点，先按第六章备份。构建新镜像前记录旧网页目录，并为旧镜像保留标签，供第九章回滚使用。

```bash
readlink -f /var/www/codelens/current
docker image inspect codelens-history:local --format '{{.Id}}'
docker tag codelens-history:local "codelens-history:rollback-$(basename "$release")"
```

从 Docker Hub 构建时，如果报连接超时，改用本次实测可拉取的 Amazon ECR Public 官方 Python 镜像。用临时 Dockerfile 传给构建器即可。 [Docker 官方 Python 镜像](https://gallery.ecr.aws/docker/library/python)

```bash
docker build -t codelens-history:local "$release/server"

# 仅在上面的 Docker Hub 拉取超时时执行
docker pull public.ecr.aws/docker/library/python:3.12-slim-bookworm
sed '1c\FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm' \
    "$release/server/Dockerfile" |
    docker build -f - -t codelens-history:local "$release/server"
```

全新部署运行 `bash "$release/server/prepare-postgres.sh" "$public_host"`。迁移或常规更新沿用已经生成的连接配置。

```bash
install -m 0644 "$release/server/codelens-history.service" /etc/systemd/system/codelens-history.service &&
systemctl daemon-reload &&
systemctl enable codelens-history &&
systemctl restart codelens-history

curl -fsS --max-time 5 http://127.0.0.1:18767/api/sync/health
```

服务启动时会创建 PostgreSQL 表。健康检查会验证数据库连接。看到 `{"ready":true}` 后，可按第七章创建验收账号。

### 3. 签发并安装 IP 证书

如果下列证书源文件已存在且仍有效，直接执行本节末尾的安装命令。首次签发使用 Certbot 的 standalone 模式，确保 TCP 80 空闲且外部验证服务器可达。Let’s Encrypt 的公网 IP 短期证书有效期为 160 小时，持续运行的站点需配置续期。 [Let’s Encrypt IP 证书与 Certbot](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) · [短期证书有效期](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)

```bash
ss -ltnp 'sport = :80'
docker build -t codelens-certbot:local - <<'DOCKERFILE'
FROM public.ecr.aws/docker/library/python:3.12-slim-bookworm
RUN pip install --no-cache-dir certbot==5.10.0
ENTRYPOINT ["certbot"]
DOCKERFILE
```

替换邮箱后执行申请命令。先结束占用 80 端口的部署测试容器。若已有正式 Nginx 服务在使用该端口，按第六章配置 webroot 验证路径，申请时把 `--standalone` 换成 `--webroot -w /var/www/codelens/acme`，并把该目录挂载到容器内同名路径。

```bash
cert_email='YOUR_EMAIL'
install -d -m 0700 /var/lib/codelens-certbot &&
docker run --rm --network host \
  -v /var/lib/codelens-certbot:/etc/letsencrypt:Z \
  codelens-certbot:local certonly --standalone --preferred-profile shortlived \
  --ip-address "$public_host" --cert-name "$public_host" \
  --non-interactive --agree-tos --email "$cert_email"
```

```bash
cert_dir="/var/lib/codelens-certbot/live/$public_host"
install -d -m 0755 /etc/nginx/codelens-tls &&
install -m 0644 "$cert_dir/fullchain.pem" /etc/nginx/codelens-tls/fullchain.pem &&
install -m 0600 "$cert_dir/privkey.pem" /etc/nginx/codelens-tls/codelens.key &&
openssl x509 -in /etc/nginx/codelens-tls/fullchain.pem -noout -dates
```

### 4. 发布网页并启动 Nginx

更新前备份现有 CodeLens 站点配置。如果同一地址的配置使用其他文件名，先用 `nginx -T` 查找对应配置，处理重复的 `server_name`。

```bash
web_release="/var/www/codelens/releases/$(basename "$release")"
nginx_site=/etc/nginx/conf.d/codelens-sync.conf
if [ -f "$nginx_site" ]; then
    cp -a "$nginx_site" "$release/nginx-previous.conf"
fi

install -d -m 0755 "$web_release" &&
cp -a "$release/site/." "$web_release/" &&
chmod -R u=rwX,go=rX "$web_release" &&
sed "s/__CODELENS_HOST__/$public_host/g" "$release/server/nginx-tls.conf" \
    > "$nginx_site" &&
restorecon -RF /var/www/codelens /etc/nginx/codelens-tls &&
nginx -t &&
ln -sfnT "$web_release" /var/www/codelens/current &&
systemctl enable --now nginx &&
systemctl reload nginx
```

在本机测试后，对具备开放条件的站点放行 443。以下是本次 ECS 的 `public` 区域命令，阿里云安全组的 TCP 443 入方向规则需单独核对。

```bash
firewall-cmd --zone=public --add-port=443/tcp
firewall-cmd --permanent --zone=public --add-port=443/tcp
firewall-cmd --zone=public --query-port=443/tcp
```

---

## 五、发布检查单

### A. 发布前

- [ ] 记录发布包 SHA-256、当前发布目录、后端镜像 ID 和操作时间。
- [ ] 有现网数据时已备份当前数据库，并保留旧镜像、旧网页和上一版 Nginx 配置。
- [ ] 确认公网访问地址与 `CODELENS_SYNC_ORIGIN` 一致，证书覆盖实际访问地址。

### B. 发布中

```bash
nginx -t
ss -ltnp 'sport = :443'
curl -ksSI --max-time 5 -H 'Host: 121.41.29.215' https://127.0.0.1/
curl -kfsS --max-time 5 -H 'Host: 121.41.29.215' https://127.0.0.1/api/sync/health
```

- [x] 本次 ECS 上 Nginx 已监听 443，首页返回 `200 OK`。
- [x] 本次通过 Nginx 代理访问后端，返回 `{"ready":true}`。
- [x] 本次宿主机防火墙查询 TCP 443 返回 `yes`。

### C. 发布后

以下步骤使用服务器以外的浏览器或 Windows PowerShell，证书有效性以正常 TLS 校验结果为准。

```powershell
curl.exe -fsSI --max-time 10 https://121.41.29.215/
curl.exe -fsS --max-time 10 https://121.41.29.215/api/sync/health
curl.exe -fsSI --max-time 10 https://121.41.29.215/engine/pyodide.asm.wasm
```

- [ ] 浏览器打开登录页，公网证书校验通过。
- [ ] WebAssembly 返回 `200`，`Content-Type` 为 `application/wasm`。
- [ ] 用测试账号登录，导入样例项目，执行审查，确认界面显示「历史已同步」。
- [ ] 换浏览器用同一账号打开历史，另用独立测试账号验证历史隔离。
- [ ] 暂停审查后，重新导入同一版本的文件夹并使用相同模型配置，验证检查点续跑。
- [ ] 记录证书到期时间，并验证续期命令及 Nginx 重载。

---

## 六、运维手册

### 1. 状态与日志

健康接口用于检查 HTTP 响应链路。使用账号完成一次实际写入和读取，才能验收历史功能。

```bash
systemctl status codelens-history nginx --no-pager
journalctl -u codelens-history -n 80 --no-pager
tail -n 80 /var/log/nginx/error.log
curl -fsS --max-time 5 http://127.0.0.1:18767/api/sync/health
```

### 2. PostgreSQL 备份

使用 PostgreSQL 的 pg_dump 生成一致的备份，完成后将备份存入实例之外的受控存储。 [PostgreSQL pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)

```bash
umask 077
install -d -m 0700 /var/backups/codelens
backup="/var/backups/codelens/history-$(date +%Y%m%d-%H%M%S).dump"
docker exec codelens-postgres pg_dump -U postgres -Fc codelens > "$backup.part" &&
docker exec -i codelens-postgres pg_restore --list < "$backup.part" >/dev/null &&
mv -- "$backup.part" "$backup" &&
ls -lh "$backup"
```

### 3. IP 证书续期

让 Nginx 在 80 端口提供验证文件。在 `codelens-sync.conf` 的 HTTP `server` 块，将原来位于 `server` 层的 HTTPS 跳转移动到 `location /`，并加入验证路径。

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /var/www/codelens/acme;
    try_files $uri =404;
}

location / {
    return 301 https://121.41.29.215$request_uri;
}
```

创建该目录后检查并重载 Nginx。现有 standalone 证书可用 `reconfigure` 测试并保存 webroot 设置。下面的两条 Certbot 命令仅挂载证书存储和验证目录，使用 `--security-opt label=disable` 保留验证目录供宿主机 Nginx 读取的 SELinux 标签。部署更新时应同步保留 HTTP 验证配置。 [Certbot 续期配置说明](https://eff-certbot.readthedocs.io/en/stable/using.html#modifying-the-renewal-configuration-of-existing-certificates)

```bash
install -d -m 0755 /var/www/codelens/acme &&
restorecon -RF /var/www/codelens/acme &&
nginx -t &&
systemctl reload nginx

docker run --rm --security-opt label=disable \
  -v /var/lib/codelens-certbot:/etc/letsencrypt \
  -v /var/www/codelens/acme:/var/www/codelens/acme \
  codelens-certbot:local reconfigure --cert-name 121.41.29.215 \
  --webroot -w /var/www/codelens/acme
```

持续运行时，将下列续期和证书同步命令设为每日定时任务，并检查退出状态。首次启用时先手工验证，证书临近到期时核对续期后 Nginx 实际提供的证书日期。

```bash
docker run --rm --security-opt label=disable \
  -v /var/lib/codelens-certbot:/etc/letsencrypt \
  -v /var/www/codelens/acme:/var/www/codelens/acme \
  codelens-certbot:local renew --cert-name 121.41.29.215 &&
if ! cmp -s /var/lib/codelens-certbot/live/121.41.29.215/fullchain.pem \
            /etc/nginx/codelens-tls/fullchain.pem; then
    install -m 0644 /var/lib/codelens-certbot/live/121.41.29.215/fullchain.pem \
        /etc/nginx/codelens-tls/fullchain.pem &&
    install -m 0600 /var/lib/codelens-certbot/live/121.41.29.215/privkey.pem \
        /etc/nginx/codelens-tls/codelens.key &&
    restorecon -RF /etc/nginx/codelens-tls &&
    nginx -t && systemctl reload nginx
fi
```

## 七、上线前的账号与数据处理

在历史服务启动后，用容器内命令创建各自的账号。按提示输入两次密码，长度至少 12 个字符。

```bash
docker exec -it codelens-history python /app/service.py add-user alice
```

- 浏览器旧历史通过界面上的「同步此浏览器的旧历史」导入。使用存有数据的浏览器和原来的访问地址进行操作。
- 旧 Python 版 SQLite 与原生审查检查点使用独立存储，迁移时需要专门处理。
- 将原公网 IP 改为域名时，一并更新 Nginx、证书和 `CODELENS_SYNC_ORIGIN`，重启历史服务。切换地址后重点验收登录及浏览器旧历史。

## 八、内网与离线部署

前端运行资源随发布包上传，由 Nginx 托管。启用模型能力时，浏览器需要能访问用户配置的 HTTPS 接口，并允许来自当前站点的跨域请求。

如果服务器无法出网，可以在能访问镜像仓库和 Python 包源的 Linux 环境提前构建匹配目标架构的后端镜像，再把镜像包和应用发布包传入服务器。

```bash
# 在构建节点导出已经构建完成的镜像
docker save -o codelens-history-image.tar codelens-history:local

# 将文件传入目标 ECS 后导入
docker load -i codelens-history-image.tar
```

## 九、回滚方案

发布后若出现首页错误、同步异常或登录失败，优先用上线前记录的版本回滚网页和服务。若发布修改了数据库结构，先评估旧版兼容性。确认恢复数据库前，备份当前库并评估上线后新增记录的影响。

```bash
previous_web='/var/www/codelens/releases/替换为上一版本'
previous_image='sha256:替换为发布前记录的镜像ID'

test -s "$previous_web/index.html" &&
docker image inspect "$previous_image" >/dev/null &&
docker tag "$previous_image" codelens-history:local &&
ln -sfnT "$previous_web" /var/www/codelens/current &&
systemctl restart codelens-history &&
nginx -t && systemctl reload nginx
```

从 PostgreSQL 回滚到旧 SQLite 时，还需恢复旧 service 和 env 配置并执行 systemctl daemon-reload。若切换后已有新记录，回滚前先备份 PostgreSQL 并核对差异。

如果调整过 Nginx 配置，先恢复已备份的配置，再执行 `nginx -t` 和重载。最后按第五章重新验证。

## 十、常见问题

| 现象 | 排查与处理 |
|---|---|
| 切换 Workbench 窗口后找不到发布文件 | 在当前窗口重新设置 `$release` 和 `$public_host`，用 `ls -l` 核对发布路径 |
| 构建时报 Docker Hub 连接超时 | 按第四章改用 Amazon ECR Public 的官方 Python 镜像 |
| Certbot 显示 `Timeout during connect` | 检查 ECS 绑定的公网 IP、安全组 TCP 80、服务器防火墙及验证路径能否从外网读取 |
| `nginx -t` 通过，访问 443 返回 `Connection refused` | 运行 `ss -ltnp 'sport = :443'` 和 `systemctl status nginx`，确认 HTTPS 配置已加载且服务已启动 |
| ECS 本机 HTTPS 正常，公网超时 | 核对实例实际绑定的安全组和宿主机防火墙 TCP 443，使用独立网络复测 |
| 首页正常，`/api/sync/health` 返回 `502` | 测试回环地址 18767，并查看 systemd 和 Nginx 日志。若日志显示 SELinux 拒绝连接，评估后启用 `httpd_can_network_connect` |
| 浏览器报证书不可信或过期 | 检查证书是否覆盖公网 IP、证书链是否完整，以及续期后的证书是否已被 Nginx 加载 |
| 登录请求返回 `403` | 核对浏览器地址的协议、主机、端口与 `CODELENS_SYNC_ORIGIN` |
| 创建账号时提示密码长度错误或两次密码不一致 | 重新执行 `add-user`。两次输入均隐藏，确认两次内容一致并达到长度要求 |

## 十一、最终发布检查卡

- [ ] 发布前已记录版本、发布包哈希和回滚目标，旧数据已备份。
- [ ] 发布中已确认服务状态、HTTPS 监听、首页和后端接口。
- [ ] 发布后已验证外网 TLS、登录、历史同步和账号隔离。
- [ ] 已记录证书续期结果、备份位置和实际验收时间。
