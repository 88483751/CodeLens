# CodeLens 云端审查历史部署

这个发布包包含浏览器工作台与独立的 FastAPI 历史服务。Nginx 提供网页，并将 `/api/sync/` 转发到同机服务。用户账号、审查报告、摘要和续跑检查点写入 SQLite。原始源码和模型配置继续由浏览器处理。报告会包含文件路径、分析结果及模型生成的内容。

以下命令按 CentOS 7 ECS 和 root 登录编写。每一组成功后再继续。先准备解析至 ECS 公网 IP 的域名和该域名的 Nginx 证书。杭州的公网域名按阿里云要求完成ICP备案。ECS 安全组开放 TCP 80、443，SSH 22 限定管理地址。18767 在回环地址监听。 [ECS 建站指南](https://help.aliyun.com/zh/ecs/user-guide/build-a-website/) · [下载证书](https://help.aliyun.com/zh/ssl-certificate/download-an-ssl-certificate)

CentOS Linux 7 已停止安全维护。如用于长期公网服务，需要先解决宿主机和 Nginx 的安全更新来源。以下步骤使用兼容该系统的 Docker，在容器里运行现代 Python。 [CentOS 生命周期](https://www.centos.org/centos-linux/) · [阿里云 Docker 安装指南](https://help.aliyun.com/zh/ecs/user-guide/install-and-use-docker)

## 1. Windows PowerShell 上传

进入 CodeLens 项目根目录。若已经拿到 `tmp\codelens-sync.tar.gz`，可从设置 `$ecs` 开始。将两个证书路径改成实际文件。旧网页已经用了同域名证书且服务器路径正确时，证书只需留在原处。

```powershell
npm --prefix codelens-prototype ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\sync\pack.ps1
$ecs = 'root@121.41.29.215'
scp .\tmp\codelens-sync.tar.gz "${ecs}:"
scp 'C:\你的证书目录\fullchain.pem' "${ecs}:fullchain.pem"
scp 'C:\你的证书目录\codelens.key' "${ecs}:codelens.key"
ssh $ecs
```

## 2. CentOS 7 安装依赖

```bash
cat /etc/os-release
nginx -v
docker --version
```

若 `nginx -v` 提示命令不存在，运行：

```bash
yum install -y nginx
```

若 `docker --version` 提示命令不存在，执行下面这组。已有 Docker 时跳过安装，保留现有服务、镜像和容器。若 CentOS Yum 报镜像 404，先按阿里云指南处理归档源。 [阿里云 Yum 故障排查](https://help.aliyun.com/zh/ecs/support/the-yum-command-fails-with-the-http-error-404-not-found-trying-other-mirror-prompt)

```bash
yum install -y yum-utils
yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
yum makecache fast
yum install -y docker-ce docker-ce-cli containerd.io
```

```bash
systemctl enable --now docker
docker info
```

## 3. 安装历史服务和数据库目录

替换第一行域名。请在同一个 SSH 窗口执行后续命令，下面的变量会继续用到。

```bash
domain='codelens.example.com'
release="/opt/codelens-releases/$(date +%Y%m%d-%H%M%S)"
install -d -m 0755 "$release"
tar -tzf "$HOME/codelens-sync.tar.gz"
tar -xzf "$HOME/codelens-sync.tar.gz" -C "$release"
test -s "$release/site/index.html" && test -s "$release/server/service.py"
```

```bash
install -d -m 0755 /etc/codelens
install -d -m 0700 -o 10001 -g 10001 /var/lib/codelens
printf 'CODELENS_SYNC_ORIGIN=https://%s\n' "$domain" > /etc/codelens/history.env
chmod 0644 /etc/codelens/history.env
docker build -t codelens-history:local "$release/server"
install -m 0644 "$release/server/codelens-history.service" /etc/systemd/system/codelens-history.service
systemctl daemon-reload
systemctl enable codelens-history
systemctl restart codelens-history
systemctl status codelens-history --no-pager
for attempt in $(seq 1 15); do
    curl -fsS http://127.0.0.1:18767/api/sync/health && break
    sleep 2
done
curl --fail http://127.0.0.1:18767/api/sync/health
```

最后应返回 `{"ready":true}`。如果服务启动失败：

```bash
journalctl -u codelens-history -n 60 --no-pager
```

创建两个验收账号。每条命令会提示输入两次密码，至少 12 个字符。之后给每位用户分配自己的账号。

```bash
docker exec -it codelens-history python /app/service.py add-user alice
docker exec -it codelens-history python /app/service.py add-user bob
```

## 4. 切换网页并配置 HTTPS

已有证书位于目标路径时跳过对应的复制命令。现有静态版的两个配置要备份并从 Nginx 的 `*.conf` 加载范围移出。若你此前使用的是其他配置文件名，先运行 `nginx -T` 查出同域名的文件，按同样方式备份。

```bash
install -d -m 0755 /etc/nginx/codelens-tls /var/www/codelens
install -m 0644 "$HOME/fullchain.pem" /etc/nginx/codelens-tls/fullchain.pem
install -m 0600 "$HOME/codelens.key" /etc/nginx/codelens-tls/codelens.key
chmod -R a+rX "$release/site"
install -d -m 0755 /var/www/codelens/releases
web_release="/var/www/codelens/releases/${release##*/}"
cp -a "$release/site" "$web_release"
if command -v restorecon >/dev/null; then restorecon -RF /var/www/codelens /etc/nginx/codelens-tls; fi
```

```bash
backup_dir="/etc/nginx/codelens-config-backup/${release##*/}"
install -d -m 0700 "$backup_dir"
for name in codelens-browser.conf codelens-browser-redirect.conf codelens-sync.conf; do
    file="/etc/nginx/conf.d/$name"
    if [ -f "$file" ]; then mv "$file" "$backup_dir/$name"; fi
done
sed "s/__CODELENS_HOST__/$domain/g" "$release/server/nginx-tls.conf" > /etc/nginx/conf.d/codelens-sync.conf
nginx -t
```

检查成功再启用。如 SELinux 为 `Enforcing` 且代理连回环服务时被拒绝，可执行 `setsebool -P httpd_can_network_connect 1` 后再验收。

```bash
ln -sfn "$web_release" /var/www/codelens/current.next
mv -Tf /var/www/codelens/current.next /var/www/codelens/current
systemctl enable --now nginx
systemctl reload nginx
curl --fail --resolve "$domain:443:127.0.0.1" "https://$domain/api/sync/health"
curl -sSI --resolve "$domain:443:127.0.0.1" "https://$domain/engine/pyodide.asm.wasm"
curl -sSI --resolve "$domain:443:127.0.0.1" "https://$domain/api/status"
```

`health` 返回 ready，WASM 返回 200 和 `application/wasm`，旧 API 返回 404。如果 `systemctl is-active firewalld` 显示 active，先用 `firewall-cmd --get-active-zones` 确认网卡所属区域。若是 public，执行：

```bash
firewall-cmd --permanent --zone=public --add-service=http --add-service=https
firewall-cmd --reload
```

## 5. 浏览器验收

1. 用 Alice 登录并导入测试项目。配置支持浏览器 CORS 的 HTTPS 模型接口，运行一次审查，等账号栏显示「历史已同步」。
2. 在另一浏览器用 Alice 登录，打开「分析历史」，确认能打开该报告。用 Bob 登录，确认看不到 Alice 的报告。
3. 用 Alice 启动另一次审查，等一批完成且同步后暂停。在另一浏览器用 Alice 登录，配置同一模型接口与模型名称，重新导入同一版本的文件夹再启动审查。已经保存的检查点会复用。
4. 若旧静态版在相同协议、域名和端口下有记录，用原浏览器和账号点击「同步此浏览器的旧历史」。其他地址的浏览器数据与原生 Python 版 SQLite 不会自动迁移。原生 Python 的检查点与浏览器的审查流程格式不同。

## 6. 备份与后续更新

下面用 SQLite 的在线备份接口生成一致的数据库副本。备份文件包含账号及审查数据，权限仅向管理者开放。完成后把备份复制到实例之外的私有存储。

```bash
backup="history-$(date +%Y%m%d-%H%M%S).sqlite3"
docker exec codelens-history python /app/service.py backup "/data/$backup"
chmod 0600 "/var/lib/codelens/$backup"
```

后续更新重新打包上传，重复解包、`docker build`、`systemctl restart codelens-history` 和切换 `current` 的命令。沿用数据库目录、域名和证书，已同步的数据会随服务重新启动恢复。
