# 本地分析工作台（当前实现）

后端使用 Python 3.11+ 与 FastAPI，在 `127.0.0.1:18766` 提供 JSON API、NDJSON 进度流和 `/docs` 接口文档。界面由 `codelens-prototype/` 使用 Vite 和 React 在 `localhost:5173` 提供。启动方式见仓库根 README。修改后端后需停止旧进程并重启。

## 本机数据库

在自己的电脑安装并启动 PostgreSQL，然后用管理员角色连接：

```text
psql -h 127.0.0.1 -U postgres -d postgres -W
```

在 `psql` 中创建本机版专用角色和数据库。输入 `\password` 时按提示设置数据库密码。

```sql
CREATE ROLE codelens_local LOGIN;
\password codelens_local
CREATE DATABASE codelens_local OWNER codelens_local;
\q
```

在启动 CodeLens 的 PowerShell 中设置连接信息：

```powershell
$dbPassword = Read-Host '输入本机 PostgreSQL 的 codelens_local 密码' -AsSecureString
$dbCredential = [PSCredential]::new('codelens_local', $dbPassword)
$env:CODELENS_LOCAL_DATABASE_URL = 'postgresql://codelens_local:{0}@127.0.0.1:5432/codelens_local' -f [Uri]::EscapeDataString($dbCredential.GetNetworkCredential().Password)
Remove-Variable dbPassword, dbCredential
```

macOS/Linux 可在启动终端用 `export CODELENS_LOCAL_DATABASE_URL='postgresql://codelens_local:<编码后的密码>@127.0.0.1:5432/codelens_local'` 设置。CodeLens 启动时创建表。本机项目历史、审查结果和检查点保存在该数据库。网页版历史服务独立配置。

## 迁移旧版记录

关闭旧版 CodeLens，备份旧 SQLite 文件，并在**打开新版之前**把它们导入空的本机 PostgreSQL 数据库。在仓库根目录安装依赖后运行：

```powershell
python -m pip install -r requirements-backend.txt
python -B code/backend/migrate_local_sqlite.py --data-dir .\data
```

命令读取 `history.sqlite3` 和 `review.sqlite3` 或 `reviews.sqlite3`。如果旧版使用自定义路径，可用 `--history` 和 `--reviews` 指定文件。下载版用户在解压目录运行 `py -3 start-local.py --migrate-sqlite`，命令会从系统的数据目录找旧文件。

迁移保留项目、分析 ID、报告和两种检查点，完成后输出各表的导入行数。旧文件以只读方式打开。目标库已有记录时，命令会停止。导入后打开「分析历史」抽查旧项目和报告。恢复旧检查点还需与当前审查指纹匹配。

## 架构与数据流

`engine.analyze` 产出 Python AST 基础事实与词法分析结果；`rules` 补充 SOLID 五项及风险规则；`quality` 补充类指标、结构重复与类关系；`health` 与 `sequence` 补充评分及静态调用序列；`backend.server.enrich` 组装工作台结果。AI 项目审查由 `ai.explanation.review` 分批读取全部源码，产出逻辑说明、设计检查、风险评估三段，三页共享同一份结果。

## 当前页面

顶栏六项导航，导出报告并入顶栏按钮（Markdown / JSON / CSV），无独立预览页。

- 总览：真实文件和符号统计、复杂度与健康度，不再显示 Top 10 排行榜。
- 项目结构：文件树、包依赖、符号与源码定位，不再单列解析异常。
- 逻辑说明：全项目 AI 解读，跨文件互为说明，引用行号可跳转核对源码。
- 质量体检：高复杂度、高嵌套、坏味说明，附函数指标、类指标与结构重复组。
- 设计检查：SOLID 五项静态规则、覆盖缺口，以及 AI 审查的设计结论。
- 风险评估：只展示逻辑解读完成后自动生成的 AI 严重危害评估，不重复质量体检中的静态问题列表。

未覆盖的维度显示「未覆盖」及原因，不生成推断条目顶替缺失数据。关系图谱页、旧 `CL.app` 前端与旧导出预览页均已移除。

## 接口

| 接口 | 用途 |
|---|---|
| GET `/api/status` | 令牌、引擎版本、`api_revision`、`capabilities` |
| GET `/api/ai/status` | AI 能力状态 |
| POST `/api/analyze` | 静态分析及派生质量数据 |
| POST `/api/review` | AI 项目审查，`application/x-ndjson` 流式返回 `progress` / `result` / `error`，支持断点续跑 |
| POST `/api/review/cached` | 读取相同源码和模型配置下已完成的审查结果 |
| POST `/api/explain` | 单文件 / 单函数自然语言解读（兼容保留，当前界面主要使用 `/api/review`） |
| POST `/api/ai` | 旧结构化 AI skill 规则表达层（兼容保留） |

POST 使用本机 Host、Origin 和 `X-CodeLens-Token` 校验。源码接口按设备可用资源处理导入。默认排除测试目录（含本项目的 doc/unit、doc/frontend）、虚拟环境、构建及依赖目录，以及 htmlcov、tmp、.tmp、logs 等报告和临时目录；导入不会执行或导入目标代码。支持扩展名：`py`、`c/h/cc/cpp/cxx/hpp`、`java`、`js/jsx/ts/tsx`、`go`。

启用分析历史时，每次成功的静态分析都会自动创建独立历史项，并按分析 ID 倒序展示。历史项记录当时静态报告、文件清单和后续 AI 审查；页面点击历史项可直接恢复结果，不把同名项目的后续扫描合并为版本序列。

## 规则与口径

| 规则 ID | 检查内容 |
|---|---|
| CC-01 | 函数圈复杂度超过阈值 |
| LEN-01 | 函数有效行数超过阈值 |
| DEPTH-01 | 嵌套深度超过阈值 |
| A4 / A3-IO / CYCLE-01 | 参数与 I/O 线索、模块循环依赖 |
| A5-DEAD / A8-DEFENSIVE / CMT-01 | 死代码、 defensive 写法、注释线索（限 Python） |
| DUP-01 | 结构重复函数体 |
| PRIVACY-01 | 高置信身份证号、手机号、邮箱及常见 API/云令牌形状；报告只保留类型，不回显原值 |
| SOLID 五项 | S/O/L/I/D 静态线索，均为 `inference`，附覆盖缺口 |

规则 ID 为 provisional，以算法文档定稿为准。非 Python 语言走词法与花括号路径，口径与 Python AST 路径不完全等价，报告会标注限制。

## 检测口径与边界

圈复杂度初始 1，条件/循环/异常/布尔等节点按 `engine.py` 的公开定义计数；有效代码行排除空行、纯注释和独立文档字符串。函数健康度依据复杂度、长度与嵌套超出阈值的程度扣分，不代表无缺陷证明。

类指标及重复检测的完整公式由响应 `quality_notes` 提供：WMC 为直接方法 CC 之和；DIT 遇未知父类返回 null；CBO 只计算已解析类关系；LCOM1 根据实例字段共享计算。重复检测保留变量名/字面量，仅检测至少四条语句的相同函数体 AST，不宣称覆盖语义重复。

类关系由已解析继承、构造与注解提供证据，动态类型无法完整还原。SOLID 是静态复核线索，不判断完整行为契约；详细范围见 [SOLID 分析](solid-analysis.md)。AI 审查范围与引用见 [AI 项目审查](ai-logic-explanation.md)，评估与验收见 [评估说明](quality-evaluation.md)，前端结构见 [前端现状说明](frontend-redesign.md)。

## 安全与数据

导入只执行本机静态分析。用户发起 AI 解读并确认模型地址和文件范围后，才会向所选的 `chat/completions` 服务分批发送处理过的源码。服务会排除凭据路径并遮蔽常见敏感字面量。未配置模型或审查失败时，静态结果照常可用。本机 API Key 可保存到操作系统凭据库，不写入报告或项目文件。「导出报告」面板可分别选择并预览逻辑说明、设计检查和风险评估，导出默认剔除源码。

## 验证

```sh
python -B -m unittest discover -s tests/unit_1 -v
python -B -m unittest discover -s tests/unit_2 -v
python -B -m unittest discover -s tests/integration -v
python -B tests/evaluate_solid.py
cd codelens-prototype && npm ci && npm run build
```
