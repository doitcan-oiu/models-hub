# Cloudflare 旧实现归档

此目录只保留迁移前的 Worker、D1 SQL、Wrangler 配置和后端测试，便于审阅行为差异及导出旧数据库。当前 Go 服务、前端构建、Docker 镜像与测试均不依赖它，不安装 Cloudflare npm 包。

当前入口为 `cmd/pulsegate`；部署和数据迁移以仓库根目录 README 为准。这里的测试及 Wrangler 配置保留原始路径，不能直接从归档目录运行。
