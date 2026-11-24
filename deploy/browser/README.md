# CodeLens 纯网页版部署

在 Windows 本机构建，把静态文件上传到阿里云 ECS。Nginx 提供 HTML、JS 和 WebAssembly，源码分析在访问者的浏览器中运行。

## 1. 在 Windows PowerShell 构建

在项目根目录执行。每条命令成功后再执行下一条。

```powershell
npm --prefix codelens-prototype ci
npm --prefix codelens-prototype run build:web
npm --prefix codelens-prototype run preview:web -- --host 127.0.0.1 --port 4173 --strictPort
```

在浏览器打开 [本机预览](http://127.0.0.1:4173/)。选择一个包含源码的文件夹。查看项目结构、质量体检和报告导出。刷新页面后，在「分析历史」打开同一条记录。首次静态分析会下载该网站同源的 WebAssembly 引擎。

## 2. 在 Windows PowerShell 打包并上传

预览完成后按 Ctrl+C。将下面的公网 IP 和 SSH 账号换成控制台显示的值。

```powershell
$server = 'root@121.41.29.215'
New-Item -ItemType Directory -Path .\tmp -Force | Out-Null
tar.exe -czf .\tmp\codelens-web.tar.gz -C .\codelens-prototype\dist-web .
scp .\tmp\codelens-web.tar.gz .\deploy\browser\nginx.conf "${server}:"
ssh $server
```

如果通过阿里云 Workbench 登录，先把两个文件上传至登录用户的主目录，再执行下一节。下列 Linux 命令以 root 登录为例。

## 3. 在 CentOS 7 终端安装并验证

```bash
nginx -v
```

如果提示找不到 Nginx，执行 `yum install -y nginx`。如果 Yum 提示镜像 404 或找不到软件包，先按阿里云文档检查 CentOS 7 的归档源和 Nginx 软件包来源。CentOS Linux 7 已于 2024 年 6 月停止维护。长期公开服务需要持续获得系统和 Nginx 安全更新。 [阿里云 Yum 故障说明](https://help.aliyun.com/zh/ecs/support/the-yum-command-fails-with-the-http-error-404-not-found-trying-other-mirror-prompt) · [CentOS 生命周期](https://www.centos.org/centos-linux/)

把 `host` 改成正式域名，例如 `codelens.example.com`。只在服务器内验证时，可先填当前 ECS 的公网 IP，并用下面带 `Host` 的命令测试。

```bash
host='codelens.example.com'
site='/var/www/codelens'
release="$site/releases/$(date +%Y%m%d-%H%M%S)"
install -d -m 0755 "$release"
tar -xzf "$HOME/codelens-web.tar.gz" -C "$release"
test -s "$release/index.html" && test -s "$release/engine/pyodide.asm.wasm"
```

上一条检查成功后执行以下命令。若服务器已有同域名的 Nginx 配置，先通过 `nginx -T` 找到对应虚拟主机并合并配置，避免重复的 `server_name`。

```bash
chmod -R a+rX "$release"
if command -v restorecon >/dev/null; then restorecon -RF "$site"; fi
ln -s "$release" "$site/current.next"
mv -Tf "$site/current.next" "$site/current"
sed "s/__CODELENS_HOST__/$host/g" "$HOME/nginx.conf" > /etc/nginx/conf.d/codelens-browser.conf
nginx -t && systemctl enable --now nginx && systemctl reload nginx
```

```bash
curl -sSI -H "Host: $host" http://127.0.0.1/
curl -sSI -H "Host: $host" http://127.0.0.1/engine/pyodide.asm.wasm
curl -sSI -H "Host: $host" http://127.0.0.1/api/status
```

预期依次为 `200`、`200`（`Content-Type: application/wasm`）、`404`。旧的 CodeLens 下载包和包含云端 Python 服务的部署脚本适用于其他部署方式。

## 4. 绑定域名和 HTTPS

1. 把域名的 DNS A 记录指向 ECS 公网 IP。杭州实例公开域名按阿里云要求完成 ICP 备案。安全组公网入方向放行 TCP 80、443，SSH 22 限定为管理来源。 [阿里云 ECS 建站指南](https://help.aliyun.com/zh/ecs/user-guide/build-a-website/)
2. 准备匹配该域名的证书链文件和私钥。在 Windows 上从证书所在的目录上传。以下文件名分别对应 Nginx 证书文件和私钥文件。 [阿里云下载证书](https://help.aliyun.com/zh/ssl-certificate/download-an-ssl-certificate)

```powershell
$server = 'root@121.41.29.215'
scp .\fullchain.pem .\codelens.key "${server}:"
```

3. 在 CentOS 终端执行。再次将 `host` 替换成证书对应的域名。若 `nginx -t` 失败，先按错误提示检查证书路径和 Nginx 的 SSL 支持。 [阿里云 Nginx 证书配置](https://help.aliyun.com/zh/ssl-certificate/install-ssl-certificates-on-nginx-servers-or-tengine-servers)

```bash
host='codelens.example.com'
install -d -m 0755 /etc/nginx/codelens-tls
install -m 0644 "$HOME/fullchain.pem" /etc/nginx/codelens-tls/fullchain.pem
install -m 0600 "$HOME/codelens.key" /etc/nginx/codelens-tls/codelens.key
site_config='/etc/nginx/conf.d/codelens-browser.conf'
sed -i -e 's/^    listen 80;/    listen 443 ssl;/' \
  -e '/listen 443 ssl;/a\    ssl_certificate /etc/nginx/codelens-tls/fullchain.pem;\n    ssl_certificate_key /etc/nginx/codelens-tls/codelens.key;\n    ssl_protocols TLSv1.2;' "$site_config"
cat > /etc/nginx/conf.d/codelens-browser-redirect.conf <<EOF
server {
    listen 80;
    server_name $host;
    return 301 https://$host\$request_uri;
}
EOF
nginx -t && systemctl reload nginx
```

如果 `systemctl is-active firewalld` 输出 `active`，在对公网的网卡所属 zone 放行 HTTP 和 HTTPS。例如网卡属于 `public` zone 时执行：

```bash
firewall-cmd --get-active-zones
firewall-cmd --permanent --zone=public --add-service=http --add-service=https
firewall-cmd --reload
```

最后在 Windows 验证公网域名，替换示例域名。

```powershell
curl.exe -I https://codelens.example.com/
curl.exe -I https://codelens.example.com/engine/pyodide.asm.wasm
curl.exe -I https://codelens.example.com/api/status
```

打开 HTTPS 网址，用测试代码验收静态分析。AI 审查需要每位用户自行配置一个允许本站跨域（CORS）的 HTTPS Chat Completions 接口。模型地址与名称保存在浏览器，密钥保存在当前标签页会话，历史与审查进度保存在该网址对应的 IndexedDB。导入时只做静态分析，用户主动启动 AI 审查时，浏览器将本次审查所需的源码和密钥发送给该模型服务商。

## 后续更新

在 Windows 重新构建、打包并上传。在 ECS 重复第 3 步的解包、校验与切换 `current`，已有 HTTPS 时保留服务器端 Nginx 配置和证书。切换期间如有浏览器仍打开旧版本，刷新即可加载新构建。已部署域名保持一致时，浏览器本地历史保留在原站点。
