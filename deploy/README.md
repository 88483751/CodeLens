# CodeLens 阿里云 ECS 部署手册

面向当前这台实例的实际状态编写，按顺序执行即可。整套流程约 20 分钟，其中人工操作 3 步。

| 项 | 当前值 | 目标值 |
|---|---|---|
| 实例规格 | `ecs.e-c1m1.large` 2 vCPU / 2 GiB | 不变（无需升配） |
| 操作系统 | Windows Server 2022 数据中心版 | **Alibaba Cloud Linux 3.2104 LTS 64位** |
| 公网 IP | 121.41.29.215 | 不变 |
| 地域 | 华东1（杭州） | 不变 |
| 访问方式 | — | `http://121.41.29.215:8080/` |

---

## 第 1 步：更换操作系统（唯一有风险的操作，约 5 分钟）

2 GiB 内存无法同时承载 Windows Server 2022 与 Python/Node 运行时，必须换成 Linux。当前实例是 09:39 新建的，系统盘上没有业务数据，**重置零损失，公网 IP 与计费方式都不受影响**。

1. ECS 控制台 → 左侧「实例」→ 找到 `i-bp155gymcmb2lf4z` → 右侧「**停止**」→ 确认（选「**节省模式**」或普通停止均可）。
2. 等待状态变为「**已停止**」。
3. 该实例行 → 「**更多**」（或详情页右上「⋯」）→ 「**云盘和镜像**」→ 「**更换操作系统**」。
4. 弹窗中设置：
   - **镜像**：公共镜像 → `Alibaba Cloud Linux` → `Alibaba Cloud Linux 3.2104 LTS 64位`
   - **系统盘**：保持 40 GiB ESSD Entry，勾选「**更换系统盘**」（重置）
   - **登录凭证**：选「**自定义密码**」，设置一个强 root 密码（后面 scp/ssh 要用）
5. 确认 → 等待 1–3 分钟 → 状态回到「运行中」。

> 若控制台提示「更换操作系统会使原系统盘数据丢失」，属正常提示，确认即可。
> 若找不到「更换操作系统」入口，改为：实例列表勾选该实例 → 底部「更多」→「云盘和镜像」→「更换操作系统」。

**验证**：详情页「镜像」应显示 `Alibaba Cloud Linux 3.2104 LTS 64位`，「操作系统」不再是 Windows。

---

## 第 2 步：放行安全组 8080 端口（约 2 分钟）

1. 实例详情 → 「**安全组**」标签 → 点安全组 ID 进入规则页 → 「**手动添加**」入方向规则：

| 字段 | 填写 |
|---|---|
| 规则方向 | 入方向 |
| 授权策略 | 允许 |
| 协议类型 | 自定义 TCP |
| 端口范围 | `8080/8080` |
| 授权对象 | `0.0.0.0/0` |
| 描述 | CodeLens Web |

2. 建议顺手收紧 SSH：找到 `22/22` 那条规则，把授权对象改成「我的 IP」（控制台可一键填充）。

> 不要用 80 端口。杭州属内地节点，未备案域名/裸 IP 走 80/443 会被拦截；8080 这类非标端口不受备案限制。

---

## 第 3 步：本机一条命令完成部署

在 Windows 上打开 PowerShell，进入项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\pack.ps1
```

脚本会自动完成 5 件事：

1. `codelens-prototype` 里执行 `npm run build`（本地构建，避免 2 GiB 服务器 OOM）
2. 打包 `code/` + `codelens-prototype/dist/` + `deploy/` + `requirements-backend.txt`（约 1–2 MB）
3. 上传 `bootstrap.sh` 与源码包到 `/tmp`
4. 远程执行 `bootstrap.sh`：装 Python 3.11、Nginx、建 2 GB swap、建 venv、装依赖、注册 systemd、写 Nginx 配置、放行防火墙
5. 自检并打印访问地址

全程会提示输入 root 密码（第 1 步设置的那个），首次约 2–4 分钟。

**常见参数**：

```powershell
# 服务器 IP 不同
powershell -ExecutionPolicy Bypass -File deploy\pack.ps1 -ServerIp 121.41.29.215

# 前端已构建过，跳过 npm run build（省 1 分钟）
powershell -ExecutionPolicy Bypass -File deploy\pack.ps1 -SkipBuild
```

**失败时的手工等价流程**（网络受限或 scp 不可用时）：

```bash
# 本机 Git Bash
cd codelens-prototype && npm run build && cd ..
tar -czf /tmp/codelens-src.tar.gz code codelens-prototype/dist deploy requirements-backend.txt
scp deploy/bootstrap.sh root@121.41.29.215:/tmp/
scp /tmp/codelens-src.tar.gz root@121.41.29.215:/tmp/
ssh root@121.41.29.215 "bash /tmp/bootstrap.sh /tmp/codelens-src.tar.gz"
```

---

## 第 4 步：验收

浏览器打开 `http://121.41.29.215:8080/`，逐项确认：

| 检查项 | 预期 | 失败含义 |
|---|---|---|
| 首页加载 | 出现 CodeLens 界面 | Nginx 或 dist 未就位 |
| `/api/status` | 返回 JSON（含 token） | 后端未起或反代异常 |
| 导入一个源码文件夹 | 静态分析出结果 | 请求体被 413（Nginx 上限） |
| 开启 AI 审查 | 结果**逐条流式**出现 | Nginx 未关闭代理缓冲 |
| 刷新页面 | 历史记录仍在 | `data/` 权限或路径问题 |

服务器端自检命令（ssh 登录后）：

```bash
systemctl status codelens --no-pager      # 应为 active (running)
curl -s http://127.0.0.1:18766/api/status | head -c 200
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
free -h                                    # 看 swap 是否生效
```

---

## 第 5 步：日常运维

```bash
# 改完代码后重新发布（本机执行）
powershell -ExecutionPolicy Bypass -File deploy\pack.ps1

# 服务管理（服务器）
systemctl restart codelens
systemctl stop codelens
journalctl -u codelens -n 80 --no-pager
tail -f /opt/codelens/app/logs/codelens.log

# 备份历史数据
tar -czf /tmp/codelens-data-$(date +%F).tar.gz /opt/codelens/app/data
```

**服务端固定 AI 端点**（可选，让所有人共用一套模型配置，无需每次手填页面）：

```bash
cat > /etc/codelens.env <<'EOF'
CODELENS_AI_ENDPOINT=https://your-endpoint/v1/chat/completions
CODELENS_AI_MODEL=your-model
CODELENS_AI_KEY=sk-xxxx
EOF
chmod 600 /etc/codelens.env
systemctl restart codelens
```

---

## 故障对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 浏览器打不开、连接超时 | 安全组未放行 8080 | 回到第 2 步 |
| 页面 502 | Nginx 连不上后端 | `systemctl status codelens`；若 SELinux 报 AVC，执行 `setsebool -P httpd_can_network_connect 1` |
| 页面能开，操作报 403「只允许本机访问」 | 反代未改写 Host/Origin | 检查 `/etc/nginx/conf.d/codelens.conf` 里两条 `proxy_set_header`，确认与仓库版本一致 |
| 上传项目报 413 | `client_max_body_size` 太小 | 已设 16m；若改过代码调大了 `MAX_BODY`，同步调大 |
| AI 审查长时间无输出、最后一次性刷出 | 代理缓冲未关闭 | 确认 `proxy_buffering off;` 生效 |
| 服务反复重启 | 内存超限被 `MemoryMax` 回收 | `free -h` 看 swap；必要时把 `MemoryMax` 提到 1800M |
| `npm run build` 在服务器上 OOM | 在 2 GiB 机器上构建 | 改在本机构建（本方案默认如此） |

---

## 额度与下线

- 免费权益：300 元总额、每小时抵扣上限 0.833 元、有效期 3 个月。当前配置 Linux 2核2G 经济型 e 约 0.123 元/小时，两周约 41 元，可覆盖到 3 个月租期结束。
- **停机不等于停止计费**：停止实例后系统盘仍按量计费。彻底停止只有一条路 —— 释放实例并勾选释放系统盘。
- 演示结束务必：先 `tar` 备份 `/opt/codelens/app/data`，再「释放实例」，否则额度会用完后自动转为余额扣费。
- 建议在「费用中心 → 可用额度」设一条 50 元余额预警。

---

## 附录：路径 B —— 保留 Windows Server 2022（必须升到 2核4G）

如果不想换镜像，可以留在 Windows，但 **2 GiB 跑不动**：Windows Server 2022 桌面版空载常驻 1.8–2.2 GiB，再加 FastAPI + langgraph 的 400–600 MB 必然撑爆。先把规格升到 `ecs.e-c1m2.large`（2 vCPU / 4 GiB）。

升配后的内存预算：Windows 约 2.0 GB + Python 后端约 0.5 GB + nginx 约 0.05 GB ≈ 2.6 GB，剩约 1.4 GB 余量，可稳定运行。

**额度测算**（控制台实测参考价 0.225 元/时 + 系统盘约 0.029 元/时 ≈ 0.254 元/时）：

| 指标 | 数值 |
|---|---|
| 两周（336 小时）消耗 | 约 85 元，剩余 215 元 |
| 300 元可支撑 | 约 1181 小时 ≈ 49 天 |
| 每小时抵扣上限 0.833 元 | 远低于上限，不会自付 |
| 结论 | 两周目标完全满足；但不能像 Linux 那样跑满 92 天 |

### 部署步骤

1. 控制台：停止实例 → 「更多 → 升降配 → 更改实例规格」→ 选 `ecs.e-c1m2.large`（2 vCPU / 4 GiB）→ 确认 → 启动实例。**不要选 8C16G**（0.900 元/时已超 0.833 元/时上限，需自付，且约 13 天耗尽额度）。
2. 安全组入方向放行 TCP `8080`（同上文第 2 步）。
3. 本机 PowerShell 执行，生成发布包到桌面：
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\windows\pack.ps1
   ```
   产物：`桌面\codelens-release.zip`（约 0.5 MB，含源码、前端构建产物和安装脚本）。
4. 远程桌面（mstsc）连接服务器，把这个 zip **直接粘贴到 `C:\`**（RDP 剪贴板支持文件复制）。
5. 服务器上以**管理员身份**打开 PowerShell，执行两条命令：
   ```powershell
   Expand-Archive C:\codelens-release.zip C:\codelens-pkg -Force
   powershell -ExecutionPolicy Bypass -File C:\codelens-pkg\deploy\windows\setup.ps1
   ```
6. 脚本自动完成：装 Python 3.11（华为云镜像）→ 建 venv、用阿里云 PyPI 镜像装依赖 → 装 nginx for Windows → 写反代配置 → 注册 `CodeLensAPI` / `CodeLensWeb` 两个开机自启计划任务 → 放行 Windows 防火墙 8080 → 健康检查。
7. 浏览器打开 `http://121.41.29.215:8080/`。

### Windows 下的运维命令

```powershell
# 启停
Stop-ScheduledTask CodeLensAPI ; Start-ScheduledTask CodeLensAPI
Get-Process nginx | Stop-Process -Force ; Start-ScheduledTask CodeLensWeb

# 日志
Get-Content C:\codelens\logs\codelens.log -Tail 50
Get-Content C:\codelens\nginx\logs\error.log -Tail 50

# 手工前台跑后端（排错时最直观）
C:\codelens\venv\Scripts\python.exe -B C:\codelens\app\code\backend\asgi.py --port 18766
```

### Windows 特有故障

| 现象 | 原因 | 处理 |
|---|---|---|
| pip 下载极慢或超时 | 默认 PyPI 源在海外 | 脚本已改用 `mirrors.aliyun.com`，不要改回官方源 |
| Python 下载失败 | python.org 国内不稳定 | 脚本已用 `mirrors.huaweicloud.com` |
| 页面 403「只允许本机访问」 | 反代没改写 Host/Origin | 检查 `C:\codelens\nginx\conf\nginx.conf` 中两条 `proxy_set_header` |
| nginx 启动失败、错误日志 `bind() failed` | 8080 被占用（如 IIS） | `netstat -ano | findstr :8080`，停掉占用进程或换端口 |
| 重启服务器后网站没了 | 计划任务未生效 | `Get-ScheduledTask CodeLensAPI,CodeLensWeb` 检查状态 |
| 部署后系统很卡 | 仍是 2 GiB，或 Defender 全盘扫描 | 确认已升 4 GiB；可把 `C:\codelens` 加入 Defender 排除项 |
