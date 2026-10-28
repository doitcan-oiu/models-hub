# PulseGate 部署与迁移

Go + Vue 3，支持 SQLite、MySQL 和 PostgreSQL，使用 Docker Compose 部署。Go 进程同时提供控制台、模型 API、余额定时刷新和恢复探测；运行不依赖 Cloudflare Workers、D1、Durable Objects 或 Cron。

保留渠道与密钥池管理、API Key 授权策略、模型映射、五种路由策略、SSE、请求追踪、用量统计、模型发现，以及 NewAPI / Sub2API / BBDevLab 余额集成。客户端请求沿原生协议转发：OpenAI Chat Completions / Responses、Anthropic Messages 和 Gemini；不会自动转换供应商协议。

## 首次部署

需要 Docker Engine / Docker Desktop 和 Docker Compose。默认不需要创建 `.env`：

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f gateway
```

打开 [http://localhost:8787](http://localhost:8787)，页面会进入初始化向导：

1. 设置管理员密码并再次确认，至少 7 个字符，支持纯数字。
2. 选择 SQLite、MySQL 或 PostgreSQL，填写数据库信息，可先测试连接。
3. 确认浏览器访问地址并初始化。程序自动建表、生成加密密钥，同源地址下自动登录。

页面预览：[数据库初始化表单](setup-wizard.png)。

SQLite 默认路径为 `/app/data/pulsegate.db`，直接保留即可。MySQL / PostgreSQL 需要预先创建数据库，并为用户授予该数据库的建表及读写权限。向导填写的是 Go 服务所处网络中的地址；容器内 `127.0.0.1` 指向网关自身。

初始化配置保存在 `pulsegate_data` 命名卷中的 `/app/data/config.json`；管理员密码保存为 bcrypt 哈希。重建容器保留配置，不会再次开放初始化。配置损坏或数据库无法连接时，程序报错退出，避免误将已有实例当成新实例覆盖。初始化成功后数据库类型固定，后续更换数据库应另行迁移数据。

向导会拒绝已有 PulseGate 业务数据的数据库，避免新生成的加密密钥覆盖原实例的关联配置。恢复已有实例时，应恢复其原 `config.json` 或使用原环境变量配置启动。

Dockerfile 分阶段构建 Vue 资源和 Go 二进制，运行容器使用非 root 用户和只读根文件系统，数据目录单独持久化。`/health/live` 检查进程（安装阶段也可通过），`/health/ready` 和 `/health` 检查配置及数据库，安装前返回 503。

## 使用独立数据库服务

SQLite 适合单实例、轻量部署。大量并发写入及日志场景建议使用 PostgreSQL 或 MySQL，并按真实请求负载测试。三种数据库都使用事务维护额度与限流，SQLite 开启 WAL 和有限等待；其写事务仍由 SQLite 串行执行。

可使用已有数据库，也可启动仓库附带的数据库服务。先生成可选数据库服务的随机密码（已有 `.env` 不会覆盖）：

```sh
docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/local-env.mjs
# 本机已有 Node.js 时也可使用 npm run setup:local
```

PostgreSQL：

```sh
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build
```

向导选择 PostgreSQL，主机 `postgres`、端口 `5432`、数据库及用户名 `pulsegate`，密码填写 `.env` 的 `POSTGRES_PASSWORD`。

MySQL：

```sh
docker compose -f compose.yaml -f compose.mysql.yaml up -d --build
```

向导选择 MySQL，主机 `mysql`、端口 `3306`、数据库及用户名 `pulsegate`，密码填写 `.env` 的 `MYSQL_PASSWORD`。等待数据库健康后测试连接。附带数据库不向宿主机公开端口，在 Compose 私有网络内连接时 TLS 可选择关闭；连接外部数据库时按其要求配置 TLS。

使用附加 Compose 文件后，后续查看状态、升级及停止也应带上相同的 `-f` 参数。数据分别保存在 `postgres_data` / `mysql_data` 命名卷中。

## 域名与反向代理

向导中的访问地址填写浏览器使用的 Origin，例如 `https://ai.example.com`，不包含子路径。部署在域名下时，建议直接通过该域名完成初始化。可在 `.env` 用 `PUBLIC_URL` 覆盖持久化的访问地址，重建网关容器后生效。向导填写另一访问地址时，初始化成功后页面会提供前往该地址的登录链接。

管理员登录按连接来源 IP 限制为每分钟 10 次尝试，成功后清除计数；反向代理后的请求共用代理 IP 计数，失败过多时等待一分钟再登录。

反向代理需要保留 Host、关闭 SSE 缓冲，并让读取超时覆盖最长生成时间。访问地址用于 Origin 校验和 HTTPS Cookie；应用不会盲目信任客户端传入的 `X-Forwarded-*`。Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1250s;
    proxy_send_timeout 1250s;
}
```

## 渠道隔离和高并发

旧实现所有额度、轮询和健康写入都经过同一个 `idFromName('gateway')` 串行队列。故障 A 的高频请求会增加共享状态队列与 D1 的压力，存在拖累 B 的风险；仅凭代码无法确认它就是原故障的唯一根因。

Go 实现针对这条故障传播路径做了以下处理：

- 每个渠道独立并发槽位、HTTP Transport、连接池和熔断状态。渠道繁忙或熔断时立即跳过，避免无界排队。获取槽位后才查询凭据和扣减额度，减少被拒绝流量对数据库的压力。
- 连接、TLS、响应头、有效首 Token、非流式完整响应、流式空闲、流式总时长和客户端写入均有有限超时。界面中首字/完整响应超时设为 0 时，仍保留服务端的保护上限。
- 达到连续失败阈值后快速熔断，冷却后限制恢复试探。配置化健康窗口与快速熔断分别工作。
- SSE 首个有效内容前允许重试；输出后断流结束当前请求并记录错误，避免重复回复。客户端取消会关闭上游响应并释放容量。
- 配置快照和凭据短缓存减少数据库压力，缓存锁不包围网络请求。额度与渠道 RPM/TPM 通过数据库事务维护，并发额度不会超发。
- 日志使用有界队列和固定写入协程。队列满时丢弃遥测并计数，推理不等待日志队列；异常关闭可能丢失尚未写入的日志。管理员可查询 `/api/runtime` 的 `droppedLogs` 和数据库池等待指标。
- 余额任务与推理连接池分离；恢复探测和定时任务限制并发，账户/密钥刷新使用数据库租约，单项失败不会停止整个网关。

当前建议部署 **一个 Go 实例**，再根据上游限额和实测调整并发。额度和数据库限流可跨进程共享，但并发槽位、快速熔断、健康采样窗口、轮询和会话粘性位于单进程内；直接扩容多个副本会将每渠道并发上限叠加，并改变粘性行为。回归测试不代表生产 QPS 承诺。

PostgreSQL 统计使用数据库聚合；SQLite / MySQL 统计逐行聚合，限制内存中的分组数和延迟样本数。超过采样或分组上限时统计页会显示提示，延迟百分位可能为近似值。

## 配置

完整环境变量样例见 [.env.example](../.env.example)。独立运行时进程环境变量优先于 `.env`；数据库和密码由持久化配置优先决定。界面中的首字超时、非流式超时、重试次数和健康窗口仍可配置。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PORT` | `8787` | Compose 对外映射端口 |
| `DATA_DIR` | 独立运行 `data`；容器 `/app/data` | 初始化配置目录；Compose 内固定使用持久卷 |
| `PUBLIC_URL` | 向导设置 | 可覆盖浏览器访问 Origin |
| `LISTEN_ADDR` | `:8787` | Go 监听地址 |
| `CHANNEL_MAX_CONCURRENCY` | `64` | 每渠道最多同时执行的请求 |
| `CONNECT_TIMEOUT` | `5s` | 连接上游超时 |
| `RESPONSE_HEADER_TIMEOUT` | `30s` | 等待上游响应头 |
| `STREAM_IDLE_TIMEOUT` | `60s` | 开始输出后上游读取空闲上限 |
| `STREAM_MAX_DURATION` | `20m` | 单次流式尝试总时长上限 |
| `REQUEST_TIMEOUT` | `20m` | 包括重试在内的请求总时长上限 |
| `DOWNSTREAM_WRITE_TIMEOUT` | `30s` | 向客户端写数据的超时 |
| `CIRCUIT_FAILURE_THRESHOLD` | `3` | 每渠道快速熔断阈值 |
| `CIRCUIT_COOLDOWN` | `15s` | 快速熔断冷却时间 |
| `LOG_QUEUE_SIZE` / `LOG_WORKERS` | `4096` / `4` | 日志队列长度 / 写入协程数 |
| `DB_MAX_OPEN_CONNS` / `DB_MAX_IDLE_CONNS` | `32` / `16` | 数据库连接池 |

已有环境变量部署仍支持完整的 `DATABASE_URL`、`ADMIN_TOKEN`、`ENCRYPTION_KEY` 三项：管理员令牌至少 24 字符，AES 密钥为 base64 编码的 32 字节。旧令牌登录仅在该兼容模式启用；已有 `config.json` 时优先读取它。默认 Compose 使用向导，不传递这三项；保留旧 Compose 部署时请保留原环境变量映射及数据。

上游支持 HTTP/HTTPS 和容器服务名，例如 `http://ollama:11434/v1`。上游 API Key 与后台凭据 AES-GCM 加密保存，管理响应不回传原文；网关 API Key 只保存 SHA-256 哈希。后台登录采用可撤销的 HttpOnly、SameSite=Strict 会话。初始化接口仅在尚未配置时可用，校验 JSON 和同源请求，重复初始化会被拒绝。

Cloudflare AI Gateway 模式已移除，渠道使用 `direct` 或 `relayUrl`。旧数据导入时会把 AI Gateway 渠道改为直连，请确认上游域名可由 Docker 主机访问。

## 从旧 Worker / D1 迁移

先备份旧数据库和原 `ENCRYPTION_KEY`，暂停旧实例业务写入。目标实例可选择任意一种数据库，先完成网页初始化，暂不添加渠道或 API Key；导入工具拒绝覆盖已有业务数据，初始化生成的管理会话不影响导入。

1. 取得本地 D1 SQLite 文件，或从 Cloudflare 导出 D1 SQL 文件。旧配置在 `legacy/cloudflare`，导出仍在旧环境完成。
2. 使用 Python 3 标准库转换快照：

```sh
python scripts/export-d1.py old-d1.sqlite d1-snapshot.json
# 或 python scripts/export-d1.py old-d1.sql d1-snapshot.json
```

3. 创建只用于迁移的 `.migration.env`，内容为 `SOURCE_ENCRYPTION_KEY=旧实例的原密钥`；不要提交该文件。新实例的加密密钥保持不变，导入时会重新加密上游凭据。
4. 停止网关，通过已保存的配置导入，再启动。若使用附加数据库 Compose 文件，以下命令同样加上对应 `-f` 参数。停止网关不会停止独立数据库服务。

```sh
docker compose stop gateway
docker compose -f compose.yaml -f compose.migration.yaml run --rm --no-deps -v "${PWD}:/migration:ro" --entrypoint /app/pulsegate-import gateway -input /migration/d1-snapshot.json
docker compose up -d gateway
```

工具读取持久卷中的初始化配置，导入在单个事务中执行。迁移保留渠道、上游密钥、网关 Key 哈希、额度计数、配置、标签、余额、请求日志、尝试详情和事件。旧管理会话、Durable Object 临时状态、粘性记录和 Cloudflare 网关令牌不迁移。完整网关 Key 原文仍需使用原来保存的值。确认成功后移除迁移环境文件；SQL / SQLite / JSON 快照按敏感数据库备份管理。

## 备份和升级

**同时保留 `config.json` 与数据库备份**。配置包含数据库连接密码和上游凭据加密密钥，丢失或随意替换会导致凭据无法解密。Docker 数据目录备份可在停止网关后复制：

```sh
docker compose stop gateway
docker compose cp gateway:/app/data ./backup-data
docker compose up -d --build gateway
```

SQLite 数据库就在该目录中，应停止网关后复制完整目录。MySQL / PostgreSQL 还需分别备份数据库（例如 `mysqldump` / `pg_dump`），恢复时使用对应数据库工具。升级自动执行对应数据库的嵌入式迁移。`docker compose down` 保留命名卷；`docker compose down -v` 会删除数据卷，不用于日常升级。

## 本地开发与验证

本机需要 Go 1.27.3+、Node.js 22.12+。SQLite 不需要安装额外服务：

```sh
npm ci
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，在向导中将访问地址保留为该地址。Go API 位于 `127.0.0.1:8787`。也可 `npm run build` 后直接运行 Go 服务，在 `8787` 访问构建好的控制台。开发数据库可用 `docker compose -f compose.yaml -f compose.postgres.yaml -f compose.dev.yaml up -d postgres` 启动，首次需要生成 `.env` 中的数据库密码。

```sh
npm test
npm run build
go test ./...
go vet ./...
go test -race ./...
```

SQLite 集成测试直接运行。设置 `TEST_DATABASE_URL` 可运行真实 PostgreSQL 集成测试，每个测试创建随机 schema 并清理；设置 `TEST_MYSQL_URL` 可运行真实 MySQL 测试，测试用户需要创建/删除专用测试数据库的权限。这些地址应指向测试环境。Windows 的 `-race` 需要启用 CGO 和可用 GCC；生产二进制使用 `CGO_ENABLED=0`，SQLite 驱动无需 C 编译器。

回归覆盖首次初始化、连接失败、重复初始化、密码登录与重启、三种数据库事务及并发配额、故障 A 满载时 B 正常响应、取消释放容量、超时、断流不重放、日志队列隔离，以及原生协议和用量统计。历史 Worker 代码与测试归档在 `legacy/cloudflare`，不参与当前构建。
