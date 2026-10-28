# PulseGate

Go + Vue 3 大模型网关，支持 SQLite、MySQL 和 PostgreSQL。

- 多渠道、密钥池、模型映射与路由切换
- API Key 权限、额度和限流
- SSE 流式响应、请求追踪、用量统计
- NewAPI / Sub2API / BBDevLab 余额查询

支持 OpenAI Chat Completions / Responses、Anthropic Messages 和 Gemini 原生接口。客户端协议需与渠道匹配。

## 快速部署

需要 Docker 和 Docker Compose：

```sh
docker compose up -d --build
```

打开 [http://localhost:8787](http://localhost:8787)，按向导设置管理员密码、数据库和访问地址。默认使用 SQLite，无需创建 `.env`。

1. 添加渠道，填写上游地址、模型和上游密钥。
2. 创建网关 API Key，保存生成的完整密钥。
3. 将客户端 API 地址设为 `http://localhost:8787/v1`，填写网关 API Key。

调用示例（模型名替换为已配置的模型）：

```sh
curl http://localhost:8787/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_GATEWAY_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"your-model","messages":[{"role":"user","content":"你好"}]}'
```

## 可选数据库

使用 MySQL / PostgreSQL 前，运行 `npm run setup:local` 生成数据库密码（需要 Node.js），再选择对应命令：

```sh
# PostgreSQL
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build

# MySQL
docker compose -f compose.yaml -f compose.mysql.yaml up -d --build
```

向导中的主机填 `postgres` / `mysql`，数据库和用户名均为 `pulsegate`，密码见 `.env`。后续操作请带上相同的 `-f` 参数。

## 配置与维护

常用配置见 [.env.example](.env.example)：`PORT` 设置端口，`PUBLIC_URL` 设置浏览器访问地址。

- 使用域名时配置 HTTPS，反向代理关闭 SSE 缓冲。
- 当前建议运行一个网关实例；高并发场景建议使用 MySQL / PostgreSQL。
- 同时备份数据库和 `data/config.json`（容器内为 `/app/data/config.json`），其中保存了上游凭据的加密密钥。
- `docker compose down` 保留数据；`docker compose down -v` 会删除数据卷。
- `/health/live` 检查进程；`/health/ready` 检查初始化状态和数据库。

升级与查看日志：

```sh
docker compose up -d --build
docker compose logs -f gateway
```

反向代理、数据库备份及旧 Worker / D1 迁移步骤见[部署说明](docs/deployment.md)。

## 本地开发

需要 Go 1.27.3+、Node.js 22.12+：

```sh
npm ci
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，向导中的访问地址也填写此地址。

```sh
npm test
npm run build
go test ./...
go vet ./...
go run golang.org/x/vuln/cmd/govulncheck@latest ./...
```

`go test -race ./...` 还需启用 CGO 并安装 GCC。

历史 Worker 代码在 `legacy/cloudflare`，不参与当前构建。
