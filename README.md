# 前沿信号 AI 研究日报

这个目录是 AI 研究日报的网站层。它保留三种出口：

- OpenAI Sites：快速预览和验收，不作为唯一生产依赖。
- GitHub Pages：长期兜底的免费静态站点。
- Cloudflare Pages：长期生产静态站点，可后续扩展 Workers、D1、Cron。

## 本地命令

```bash
npm install
npm run dev
npm run build
npm test
```

生成静态独立版：

```bash
OUTPUT_PATH=data/latest.json SKIP_INGEST=1 node automation/run-daily.mjs
npm run export:static -- data/latest.json public-pages
```

`public-pages/` 可以直接部署到 GitHub Pages 或 Cloudflare Pages。

## 每日发布

`.github/workflows/publish-static-sites.yml` 每天北京时间 07:30 运行：

1. 拉取 Hugging Face Daily Papers 当天最新完整批次。
2. 用 arXiv 核验论文元数据。
3. 用 Semantic Scholar 补充引用和领域信号。
4. 拉取 OpenAI、Anthropic、Google DeepMind、DeepSeek 官方动态。
5. 用 Gemini 生成中文摘要、研究问题、核心方法、关键点、局限和公众号角度。
6. 导出纯静态站点。
7. 同时发布到 GitHub Pages 和 Cloudflare Pages。

## GitHub Secrets

GitHub 仓库需要配置：

- `GEMINI_API_KEY`：可选，但建议配置；没有它时会使用规则生成的保守占位。
- `CLOUDFLARE_API_TOKEN`：Cloudflare Pages 部署 token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账号 ID。

`GITHUB_TOKEN` 由 GitHub Actions 自动提供，用于 Semantic Scholar/GitHub API 辅助信号和 Pages 部署。

## Cloudflare Pages

Cloudflare Pages 项目名默认是：

```text
frontier-signals-ai-daily
```

第一次部署前，建议在 Cloudflare 控制台创建同名 Pages 项目，或使用 Wrangler 登录后创建。之后 GitHub Actions 会把 `public-pages/` 发布到这个项目。

## OpenAI Sites

旧的 `.github/workflows/daily-digest.yml` 已改为手动触发，仅用于继续写入 OpenAI Sites 动态预览环境。长期生产发布请使用 `publish-static-sites.yml`。
