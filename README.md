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
npm run audit:mechanisms
npm run verify:mechanisms
npm run gate:source-candidates
npm run gate:model-compute-sources
npm run probe:tech-discovery
npm run verify:tech-discovery
npm run gate:source-diligence
npm run gate:semantic-review
npm run gate:source-readiness
```

生成静态独立版：

```bash
OUTPUT_PATH=data/latest.json SKIP_INGEST=1 node automation/run-daily.mjs
npm run export:static -- data/latest.json public-pages
```

`public-pages/` 可以直接部署到 GitHub Pages 或 Cloudflare Pages。

## 模型机制静默监测

`automation/run-mechanism-watch.mjs` 是与网站发布完全分离的采集器，覆盖：

- B0：Constitution、Model Spec、System Card 等预期行为规则；
- M1–M4：架构、训练、推理时计算、机制可解释性；
- H1 / E1：Agent harness 与评测 harness。

它会抓取公开结构化源，做 URL/论文 ID 归一化、去重、分层、证据初评、内容哈希和失败审计，并保留 Constitution、Ouro、Coconut、Circuit Tracing、Agent/Eval Harness 的核验种子图。

当前固定为 `silent-audit`：代码中没有发布、发消息或创建公众号草稿的动作。即使发现疑似 P0/P1，也只会记录阻断原因。通知功能必须先满足 `references/model-mechanism-source-policy.md` 规定的连续 7 天静默门槛，再单独设计和人工审核。

`automation/run-source-promotion-readiness.mjs` 进一步把四份已验证快照连接成只读的来源晋级准备度矩阵。它按 endpoint 计算抓取与稳定性，按完整 artifact ref 绑定 claim、证据极性、结果谱系和证明上限；生产 `core/supplemental` 只表示现有 registry 状态，候选仍保持 `shadow`。报告会把 response hash、未解析 tag commit、缺失 LICENSE、paper/code mismatch 与 raw artifact 缺口显式列为人工阻断，但永远不会写入 target tier、人工决定、自动晋级或通知。完整矩阵之前另有最多 12 条的人工复核短清单；只有逐源满 7 天、已绑定具体 claim 且没有健康硬阻断的候选才会进入，排序仅用于主题覆盖和人工复核，不代表晋级。来源矩阵、语义包和 readiness 的定时入口都使用同一个 `staging -> verifier -> atomic promotion` 门禁；失败时保留上一份有效报告。

```bash
OUTPUT_PATH=work/mechanism-watch/audit.json \
STATE_PATH=work/mechanism-watch/audit.json \
CACHE_DIR=work/mechanism-watch/cache \
npm run audit:mechanisms
npm run verify:mechanisms
```

采集器同时生成 `review.md`，其中包含来源健康、通知门槛、优先候选和逐项人工复核清单。即使当天没有新身份或 revision，也会按日期和 canonical ID 对七层机制做确定性分层抽样，固定每日误报/错层/可追溯性复核分母；采集器不能填写人工结论。`.github/workflows/mechanism-audit.yml` 可每天北京时间 07:45 独立运行这条静默链路，通过 Actions cache 延续跨天状态，并把 `audit.json` 与 `review.md` 保存为 30 天构建产物；它没有任何部署步骤或 secrets 输入。

正式 registry 的种子主题另有专用版本源：Claude Constitution commits、OpenAI Model Spec commits/canonical text、Ouro 模型 revision、Coconut commits、Circuit Tracing 官方 artifact 与 paper-linked Circuit-Tracer tooling，以及 Codex、Claude Code、Inspect、lm-eval、METR 的 harness 流。独立 shadow 进一步核验 OpenAI Model Spec 的 tree/CHANGELOG/version manifest、Ouro 四模型 family、Coconut/Latent-CoT 压力测试、Pando 与 MIB/InterpBench 的方法边界、Inspect Evals 的 task-version 语义，以及 Harness Updating 与 Rethinking Harness Evolution；同时保留原有 MSM、SWITCH、Hidden Decoding、LHTB 和 Latent CoT Dynamics。所有候选都不计入正式健康率。MIB 与 InterpBench 因作者重叠只算一个独立组；Pando 不能外推到 Claude 自然行为；Rethinking 也不是 Harness Updating 的直接复跑。新接入来源只建立历史基线，不会把旧 commit、release 或 HF revision 误报成当天进展；`seed_health` 会逐个记录正式证据链是否 fresh。

候选来源的无人值守入口是 `npm run gate:source-candidates`。它先让 runner 在内存中生成新 audit，再把 JSON 与 review 写入 staging，只有 fail-closed verifier 通过后才原子替换最终文件，并最后提交跨日 state；runner、verifier、提交任一失败都会保留上一份有效 state。该门禁没有通知、发布、部署或公众号写入路径；`probe:source-candidates` 只保留给显式 runner 调试，不得作为定时入口，因为它会直接写入配置的 output。

论文变化以规范化 arXiv 身份和显式 `vN` 为准：`revision` 才表示版本递增；arXiv 主源补全 Hugging Face 镜像只记为 `enriched`；主源条目掉出有界窗口、镜像摘要格式变化仍为 `unchanged`。审计还保留最多 5000 条跨窗口身份历史，避免旧论文消失后重现时被误报为新论文；源版本倒退会记为 `source-regressed` 并停止在人工复核。

Claude Constitution 与 OpenAI Model Spec 还会保存规范化全文哈希，并在正文变化时生成受限的行级 before/after 片段。这个片段只是定位证据，始终带 `requires_human_semantic_review=true`；采集器不能自行判定政策语义是否发生实质变化。

这个采集过程不依赖 Gemini、Google 登录、OpenAI 会员或 Cloudflare 凭据。Gemini 仅是下方“每日论文中文编辑改写”的可选适配器，缺失时不影响原始证据采集。

## 新模型与算力系统 shadow 探针

`automation/run-model-compute-source-probe.mjs` 补齐现有流程缺少的两组官方发现源：9 个新模型端点和 7 个算力/运行时端点。模型端只使用 Kimi、Thinking Machines、Mistral 的公告索引、5 个待人工反向绑定的 HF 组织和 HF Trending 回退；算力端只使用 NVIDIA 技术/新闻 feed、ROCm 版本历史和 vLLM、SGLang、TensorRT-LLM、CUTLASS 的 GitHub REST releases。GitHub Atom、全站 HF created 流和无法确认 robots 的官网不进入注册表。

每日入口必须使用完整门禁：

```bash
npm run gate:model-compute-sources
npm run verify:model-compute-probe
```

首次成功响应只建立 onboarding baseline；先失败或因 GitHub 额度跳过的来源，要到首次完整成功后才完成基线，不得把恢复时看到的既有 release 当更新。原始 72 小时窗口与编辑候选分离：K3 这类官方模型发布可以进入人工候选；模型旁支评测、量化/adapter、sitemap lastmod、普通 patch、缺底层事件身份的技术解释和没有 compute 语义的 release 都保留为明确排除记录。所有输出固定为人工复核、零证据晋级、零 A1–A4 自动晋级、零通知、零网站与公众号写入。

七日静默观察由独立 LaunchAgent 管理，默认 07:00 运行，和 08:25 的大 GitHub 候选探针错开：

```bash
python3 ../scripts/install_model_compute_probe_launchd.py --dry-run --hour 7 --minute 0
python3 ../scripts/install_model_compute_probe_launchd.py --hour 7 --minute 0
python3 ../scripts/install_model_compute_probe_launchd.py --status
```

## 科技网与社区热点发现

`automation/run-tech-discovery-probe.mjs` 以独立 shadow 状态抓取 GitHub Trending 默认日榜（无 `since` 查询参数）、Hacker News、Techmeme、MIT Technology Review、IEEE Spectrum、Ars Technica 和 VentureBeat AI，并零请求复用已有 Interconnects、Simon Willison 与 Latent Space 快照。Harness/Eval 另有一个自包含的官方 GitHub release bundle，对 OpenAI Agents、Claude Agent SDK、Google ADK、Microsoft Agent Framework、HELM 和 Inspect Evals 做最多 6 个有界官方 API 请求，不再依赖 64 源候选探针。MIT/IEEE/Ars 仅使用公开 RSS/Atom 内的有界元数据，不抓取文章正文；Ars 只作独立 feed host 的 metadata discovery。Lobsters、The Register、The Decoder feed 与 ServeTheHome 因 robots 或 AI/版权使用约束不进入自动抓取注册表，只保留人工 watchlist。输出只映射到六个候选栏目：新模型、算力/芯片、底层机制、Agent Harness、Evaluation Harness、公司研究方向。

热度综合权威先验、关注度、时效性和抓取稳定性，只用于最多 5 条的人工核验队列。所有条目都带 `primary_verification_required=true`；首次接入、过期缓存、star 数、评论数或媒体转载都不能成为“当天新进展”，也不能提高论文或机制证据等级。

VentureBeat 只提供 T2 编辑发现信号，企业产品或厂商表述不能直接成为技术事实。CPU、服务器、机架和数据中心内容只有同时出现 AI 训练、推理、GPU/加速器或 HPC 上下文才进入算力候选；post-training、RLHF、RLAIF、DPO/GRPO、reward modeling 与 distillation 可进入底层机制候选，但仍需一手论文或版本化 artifact 桥接。

无人值守抓取有三层 deadline（单请求、单来源、整轮），仅对超时、429 与选定的 5xx 做至多两次指数退避重试；每次真实 attempt 都消耗来源预算并写入审计。状态、缓存和报告采用同目录临时文件后原子替换，同一事件优先按一手身份或 artifact link 跨媒体合并。定时任务使用两阶段 `staging runner -> verifier -> state-last commit` 门禁：任何证据边界、通知字段、来源注册表或一手核验状态被篡改都会返回非零并保留上一份有效状态。

GitHub 公共额度或临时网络失败时，24 小时内的最后一次 network-verified release cache 可以继续保留仍处于 48 小时窗口的编辑候选，但必须标记 `contains-retained-network-verified-cache`。它不计 fresh、不推进七日历史、不产生 change candidate，也不能提高证据等级；超过 24 小时后自动失效。这样不会因为一次限流把 Inspect 等已确认 release 从网站无声删除，也不会把缓存误写成“今天更新”。

```bash
npm run probe:tech-discovery
npm run verify:tech-discovery
npm run gate:tech-discovery
```

本机 08:30 的只读定时入口由 `scripts/install_tech_discovery_launchd.py` 管理；它调用上述完整门禁，没有通知、发布或公众号写入能力。

## 统一 Top 3 离线选稿

统一选稿只读取三份已经生成的审计：机制、科技/Harness、新模型/算力。它不再遍历 64 个证据端点；先按 48 小时、可定位一手身份、具体技术增量和非普通 patch 四个硬门槛过滤，再按 10 分制排序。同一事件按官方 URL 或版本身份跨来源合并，多路命中不重复占位、也不叠加分数。标准门槛仍为 6 分；只有一手身份 2/2、技术增量 3/3、时效至少 0.5 且为 G1–G4 的机制项可以走 5.5 分“一手机制轨道”，该例外不适用于媒体、Trending、Harness、新模型或算力条目。最多取 3 条，每个主栏最多一条，不足三条留空。

```bash
npm run replay:unified-top3
npm run verify:unified-top3
npm run gate:unified-top3
```

输出位于 `work/unified-top3-replay/audit.json` 与 `review.md`。无人值守入口必须使用 `gate:unified-top3`；它先写 staging，验证通过后才替换上一份有效结果。当前入口只生成手工一手复核队列，通知、公众号、网站发布和外部动作固定为关闭。

```bash
python3 ../scripts/install_unified_top3_launchd.py --dry-run --hour 8 --minute 40
python3 ../scripts/install_unified_top3_launchd.py --hour 8 --minute 40
python3 ../scripts/install_unified_top3_launchd.py --status
```

08:40 只读取 07:00、08:15、08:30 三路任务留下的审计，不新增网络请求。

## Top 3 机制证据包

排序之后才按 claim 拉证据。模型发布最多对每个入选 story 抓一次有界官方详情页；机制论文复用 arXiv 版本快照，Harness/Eval 复用精确 release snapshot。每个要点都必须带一手摘录、内容或 artifact 身份、证据上限、人工复核状态和“不能证明什么”。

```bash
npm run dossier:top3-evidence
npm run verify:top3-evidence
npm run gate:top3-evidence
```

K3 当前会拆成 KDA/AttnRes、16/896 Stable LatentMoE、训练稳定组件、MXFP4/MXFP8、权重/报告交付状态、thinking-history Harness 契约和跨 Harness 可比性七个独立要点。完整权重与技术报告实际出现前，证据包会明确保持 `announced-not-yet-delivered`。

机制类候选采用同一条“Top 3 后再深挖”路径，不增加日常抓取：Claude Constitution 从版本化 before/after diff 生成 B0 规范变化，并明确不能推出权重实现；Ouro 复用论文版本、模型 revision、发布代码的 post-loop state selection 与独立诊断，禁止把它写成已实现 adaptive halting 或已证明节省计算；Coconut 复用论文、官方代码和后续干预边界，明确 hidden-state feedback 不等于忠实、逐步、可解释的推理轨迹。来自尽调矩阵的证据合同与一手原文摘录在输出中分开标注。

当前第三名 T²MLR 会进一步拆成四个对象：自回归 token 空间造成的跨时间隐藏状态瓶颈；上一个 token 的中间层缓存注入当前 token 早期层；约 20% 局部中层递归与全层递归的作者比较；向既有 1.7B Transformer 加 recurrent pathway 的 retrofit 主张。四项均保持 G1 作者报告上限，并显式记录代码、完整配置、原始结果、层位干预和独立复现缺失。

```bash
python3 ../scripts/install_top3_evidence_launchd.py --dry-run --hour 8 --minute 42
python3 ../scripts/install_top3_evidence_launchd.py --hour 8 --minute 42
python3 ../scripts/install_top3_evidence_launchd.py --status
```

08:42 的证据任务只输出人工审阅文件，通知、公众号与网站发布均关闭。

证据门禁成功后会同时生成一个最小公开展示快照 `data/top3-latest.json`。该快照只保留标题、栏目、分数、中文机制要点、证据上限、结论边界、一手 URL/身份和缺口；不会复制原始响应、缓存或密钥。首页首屏直接读取这份快照，展示当前 K3、Inspect Evals 与 T²MLR 三条、13 个要点；旧 HF Top 5 保留为社区论文补充。快照仍标记 `manual_review_only=true`、通知与发布均为 false；它让本机页面可读，不代表 GitHub Pages 或 Cloudflare Pages 已上线。

## 每日发布

`.github/workflows/publish-static-sites.yml` 每天北京时间 07:30 运行：

1. 三路并行刷新 48 个注册发现源：机制 21、科技/社区 11、新模型/算力 16。这里统计逻辑来源，不等同于 HTTP 请求数；例如 HN 有有界 item fanout，GitHub release bundle 有 6 个官方请求。
2. 只读三份已验证快照，按 48 小时、主身份、技术增量、artifact、独立关注度和时效性确定性选 Top 3。
3. 排序以后才为三条入选 story 生成 claim-specific 证据包；64 个深度候选端点不在发布关键路径。
4. 拉取 Hugging Face 最新完整论文批次，并用 arXiv、Semantic Scholar 和四家公司官方源生成社区补充；该补充失败时复用上一快照，不阻断主 Top 3。
5. 导出并验证纯静态站点，然后发布到 GitHub Pages；Cloudflare Pages 在显式启用后复用同一份 artifact。

整个发布入口收敛为一个命令：

```bash
npm run daily:fast
```

它会把每个阶段、耗时、降级状态和实际注册发现源数写入 `work/fast-daily/run.json`。发现源刷新失败但存在上一份已验证快照时允许降级复用；Top 3 选择、证据包或静态产物验证失败则停止发布。

64 个候选证据端点、语义复核、七日稳定性、晋级准备度和引用缺口 Scout 已移到 `.github/workflows/source-diligence-audit.yml` 的独立静默旁路。旁路没有部署、通知、公众号或外部写入权限，不再拖慢日报网站。

本机也可以用一个 LaunchAgent 代替分散的分钟级发布任务：

```bash
python3 ../scripts/install_fast_daily_launchd.py --dry-run --hour 7 --minute 30
python3 ../scripts/install_fast_daily_launchd.py --hour 7 --minute 30 --replace-fragmented
python3 ../scripts/install_fast_daily_launchd.py --status
```

`--replace-fragmented` 只迁移旧的论文发布、三路发现、Top3 和证据包任务；来源候选、尽调、语义复核、晋级准备度与引用 Scout 继续静默运行。旧 plist 会保存为 `.disabled-by-fast-daily`，不会删除；需要回滚时执行 `python3 ../scripts/install_fast_daily_launchd.py --restore-fragmented`。

## GitHub Secrets

GitHub 仓库需要配置：

- `GEMINI_API_KEY`：仅在显式设置 `ENABLE_LLM_REWRITE=1` 时可选使用；默认工作流不调用 Gemini，证据采集和静态发布都不依赖模型 API。
- `CLOUDFLARE_API_TOKEN`：Cloudflare Pages 部署 token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账号 ID。

Cloudflare job 默认关闭。只有仓库变量 `CLOUDFLARE_ENABLED=true` 且两个 Cloudflare secrets 已配置时才执行；GitHub Pages 不依赖这些凭据。

`GITHUB_TOKEN` 由 GitHub Actions 自动提供，用于 Semantic Scholar/GitHub API 辅助信号和 Pages 部署。

## Cloudflare Pages

Cloudflare Pages 项目名默认是：

```text
frontier-signals-ai-daily
```

第一次部署前，建议在 Cloudflare 控制台创建同名 Pages 项目，或使用 Wrangler 登录后创建。之后 GitHub Actions 会把 `public-pages/` 发布到这个项目。

## OpenAI Sites

旧的 `.github/workflows/daily-digest.yml` 已改为手动触发，仅用于继续写入 OpenAI Sites 动态预览环境。长期生产发布请使用 `publish-static-sites.yml`。
