#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputPath = process.env.EDITORIAL_SITE_DATA_PATH || "data/editorial-latest.json";

const readJson = async (filename, fallback = {}) => {
  try {
    return JSON.parse(await readFile(path.resolve(root, filename), "utf8"));
  } catch {
    return fallback;
  }
};

const list = (value) => Array.isArray(value) ? value : [];
const includes = (value, pattern) => pattern.test(String(value || ""));

const PAPER_PROFILES = {
  "2607.14952": {
    title_zh: "固定 GPU 预算，也能把强化学习上下文推到 200 万 token",
    summary_zh: "LongStraw 不靠增加显存，而是把长提示词的计算图拆开：提示词阶段不保留自动求导图，只保存后续真正需要的模型状态，再逐条回放短响应分支。",
    why_it_matters_zh: "长上下文推理已经进入百万 token，但强化学习后训练通常还停在 25.6 万 token 左右。对会积累工具输出、网页和历史决策的 Agent，这个训练缺口会直接限制长任务能力。",
    key_points_zh: [
      "在 8 张 H20 上，Qwen3.6-27B 的分组评分和响应反向传播跑到 210 万位置；扩大组大小只增加约 0.21 GB 峰值显存。",
      "压力测试达到 446 万位置；在 32 张 H20 上，GLM-5.2 的 78 层完成了 210 万 token 提示词的端到端执行路径。",
      "代价是更多回放时间，而且论文证明的是执行容量，不是完整训练正确性。",
    ],
    caveat_zh: "提示词状态被 detach，部分分布式前向和梯度组合路径仍未完成，不能把这组结果写成已完成 200 万 token 的可靠 RL 训练。",
  },
  "2607.14777": {
    title_zh: "让 Agent 从自己的完整轨迹中提炼‘事后技能’",
    summary_zh: "SEED 让当前策略先分析已经完成的轨迹，提炼可复用的工作流、关键观察和避错规则，再把这些技能带来的概率变化变成逐 token 的训练信号。",
    why_it_matters_zh: "它试图填补 Agent 强化学习只有最终成败奖励、却缺少中间步骤指导的问题。",
    key_points_zh: [
      "技能来自当前策略自己的 on-policy 轨迹，不依赖一个长期固定的外部教师。",
      "普通上下文与技能增强上下文之间的动作概率差，被转成稠密的蒸馏信号。",
      "作者报告文本与视觉 Agent 任务中的性能和样本效率提升，仍需结合代码与完整实验设置复核。",
    ],
    caveat_zh: "目前仍是作者论文结果，不能据摘要断言这些自然语言技能就是模型内部真实的因果机制。",
  },
  "2607.14935": {
    title_zh: "VideoChat3：视频模型开始同时追求流式效率与全栈开放",
    summary_zh: "VideoChat3 用膨胀式 3D 视觉 Transformer 和自适应帧分辨率降低训练与推理的视频成本，同时建立覆盖通用、长视频和流式视频的三套数据。",
    why_it_matters_zh: "公开视频模型常常只在单一场景有效，或者只开放权重而缺少训练代码、策略与数据。VideoChat3 试图同时补齐泛化、效率和可复现性。",
    key_points_zh: [
      "I3D-ViT 负责时空表示，自适应帧分辨率根据流式内容分配视觉计算。",
      "三套训练数据分别覆盖通用视频、长视频与在线流式场景，目标是减少跨场景能力断层。",
      "论文与代码仓库已经可见，但‘fully open’仍要逐项核对数据许可、训练脚本、配置和完整复现实验。",
    ],
    caveat_zh: "当前页面只能确认作者摘要与公开仓库存在，不能仅凭标题断言全部数据、训练配方和结果都已被第三方复现。",
  },
  "2607.15257": {
    title_zh: "SearchOS：让搜索 Agent 共享进度，而不是反复撞墙",
    summary_zh: "SearchOS 把隐含在对话历史里的搜索进度，拆成待办前沿、证据图、覆盖地图和失败记忆；多个子 Agent 因而能围绕缺口继续工作。",
    why_it_matters_zh: "长任务失败往往不是模型不会搜索，而是系统忘了已经找过什么、还缺什么，以及哪些路径已经失败。",
    key_points_zh: [
      "把开放域检索建模为带引用的关系表补全，让每个结论都能落到证据。",
      "用流水线并行调度持续填充空闲槽位，把算力投入尚未覆盖的信息缺口。",
      "中间件会记录模型与工具交互，并在停滞或预算耗尽时介入。",
    ],
    caveat_zh: "系统论文中的收益同时来自模型、上下文结构、调度和工具中间件，不能只归因于基础模型。",
  },
};

function sourceLinks(paper) {
  return [
    { label: "arXiv", url: paper.arxiv_url },
    paper.github_url ? { label: "代码", url: paper.github_url } : null,
    paper.hf_url ? { label: "Hugging Face 热度", url: paper.hf_url } : null,
  ].filter(Boolean);
}

function paperStory(paper, kind = "analysis") {
  const profile = PAPER_PROFILES[paper.id];
  return {
    id: `paper:${paper.id}`,
    kind,
    title: profile?.title_zh || paper.title_zh || paper.title,
    original_title: paper.title,
    published_at: paper.published_at || paper.daily_at || null,
    summary: profile?.summary_zh || "这篇论文进入了当天的社区关注榜；正文只保留可以从摘要直接确认的问题、方法与限制。",
    why_it_matters: profile?.why_it_matters_zh || "它提供了一个值得继续核验的研究方向，但热度本身不等于结论已经成立。",
    key_points: profile?.key_points_zh || [
      "先看论文解决的具体问题，而不是只看标题和排行榜。",
      "再核对方法、实验设置、代码与失败案例是否完整。",
    ],
    caveat: profile?.caveat_zh || "当前结论来自论文摘要和作者材料，仍需阅读全文与独立复现。",
    sources: sourceLinks(paper),
    heat: Number(paper.upvotes || 0),
  };
}

function modelStory(item) {
  const isK3 = includes(item.title, /kimi\s*k3/i) || includes(item.url, /kimi-k3/i);
  if (isK3) {
    return {
      id: item.identity || "model:kimi-k3",
      kind: "model-release",
      title: "Kimi K3：产品与 API 已上线，完整权重仍待发布",
      original_title: item.title,
      published_at: item.published_at,
      summary: "K3 是一条真正需要同时看模型、芯片和 Harness 的发布：官方公布了 2.8T 参数 MoE、Kimi Delta Attention、Attention Residuals 与低精度训练方案，但完整权重和技术报告尚未交付。",
      why_it_matters: "它的代表性不只来自模型规模，而是把架构、低精度、并行系统和 Agent 使用方式绑在了一起。",
      key_points: [
        "官方产品与 API 已可用；这只能证明可访问，不能等同于开放权重。",
        "官方披露 KDA、Attention Residuals、896 专家中激活 16 个，以及 MXFP4/MXFP8 量化感知训练等设计。",
        "官方评测混用了 KimiCode、Claude Code、Codex、Terminus 2 等 Harness，榜单不能被简化成纯模型能力排名。",
      ],
      caveat: "截至本期证据窗口，完整权重、技术报告、训练配置和原始评测仍待发布，因此不能称为可独立复现的开放模型。",
      sources: [{ label: "Kimi 官方发布", url: item.url }],
    };
  }
  return {
    id: item.identity || `model:${item.url}`,
    kind: "model-release",
    title: item.title,
    original_title: item.title,
    published_at: item.published_at,
    summary: "这是一条经过官方发布入口识别的模型动态；开放状态、权重、许可证和技术材料需要分别核验。",
    why_it_matters: "只有明确改变能力、成本、开放性或使用边界的版本，才会进入这里。",
    key_points: ["官方发布身份已经确认。", "模型可用性与开放程度仍分开记录。"],
    caveat: "不把公告自动写成开放权重，也不把厂商指标自动写成独立验证。",
    sources: [{ label: "官方来源", url: item.url }],
  };
}

function harnessStory(item) {
  const isOpenAIAgents = includes(item.title, /openai-agents-python/i);
  if (isOpenAIAgents) {
    return {
      id: item.normalized_event_fingerprint || "harness:openai-agents-0.18.3",
      kind: "harness-release",
      title: "OpenAI Agents SDK：重点不在版本号，而在会话与并发可靠性",
      original_title: item.title,
      published_at: item.published_at,
      summary: "这次更新覆盖 tracing、实时会话用量、memory 初始化、handoff 消息保留、并发 Provider 隔离与 sandbox 工作区，反映 Agent Harness 正在从‘会调用工具’走向‘可长期稳定运行’。",
      why_it_matters: "Agent 的真实能力越来越取决于会话状态、并发隔离、失败恢复与可观测性；这些系统层细节会直接改变任务成功率。",
      key_points: [
        "任务与 turn 的 tracing span 可配置，实时会话能记录 response usage。",
        "memory 初始化改为串行，handoff 保留历史包装中的用户消息。",
        "并发运行隔离 Provider 实例，sandbox 避免重复创建工作区根目录。",
      ],
      caveat: "官方 Release 只能证明这些实现发生变化；没有固定模型与任务的前后对照，不能声称模型能力因此提升。",
      sources: [{ label: "OpenAI 官方 Release", url: item.canonical_url }],
    };
  }
  return {
    id: item.normalized_event_fingerprint || `harness:${item.canonical_url}`,
    kind: "harness-release",
    title: item.title,
    original_title: item.title,
    published_at: item.published_at,
    summary: "这条更新改变了 Agent 或评测 Harness 的运行语义；版本号与仓库名只保留在来源中。",
    why_it_matters: "上下文、工具、沙箱、重试、并发与 grader 都可能改变系统表现。",
    key_points: ["具体变化来自官方版本说明。", "实际收益仍需固定模型、任务、环境和预算验证。"],
    caveat: "版本发生不等于能力提升或历史分数可比。",
    sources: [{ label: "官方 Release", url: item.canonical_url }],
  };
}

export function buildEditorialSiteData({ digest, modelCompute, techDiscovery, mechanismRadar, generatedAt = new Date().toISOString() }) {
  const papers = list(digest.papers);
  const modelCandidates = list(modelCompute.daily_editorial_candidates);
  const techCandidates = list(techDiscovery.daily_current_window_review);
  const modelStories = modelCandidates.slice(0, 2).map(modelStory);

  const hardwareCandidates = modelCandidates.filter((item) => includes(item.kind, /compute|chip|runtime|kernel/i));
  const hardwareStories = hardwareCandidates.slice(0, 2).map((item) => ({
    ...modelStory(item),
    kind: "hardware-system",
  }));

  const analysisPapers = papers
    .filter((paper) => includes(`${paper.title} ${paper.summary}`, /long.?context|reinforcement learning|distillation|reasoning|architecture|latent|training/i))
    .sort((left, right) => Number(right.upvotes || 0) - Number(left.upvotes || 0));
  const analysisStories = analysisPapers.slice(0, 2).map((paper) => paperStory(paper, "mechanism-analysis"));

  const harnessCandidates = techCandidates.filter((item) => list(item.daily_sections).includes("harness") && !includes(item.title, /inspect_evals/i));
  const harnessPapers = papers
    .filter((paper) => includes(`${paper.title} ${paper.summary}`, /agent|harness|tool|search/i))
    .sort((left, right) => Number(right.upvotes || 0) - Number(left.upvotes || 0));
  const harnessStories = [
    ...harnessCandidates.slice(0, 1).map(harnessStory),
    ...harnessPapers.filter((paper) => paper.id === "2607.15257").slice(0, 1).map((paper) => paperStory(paper, "harness-research")),
  ].slice(0, 2);

  const constitutionCard = list(mechanismRadar.cards).find((card) => card.id === "claude-constitution");
  const constitutionChanged = Boolean(constitutionCard?.current_event);
  const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(generatedAt));

  return {
    schema_version: 1,
    mode: "reader-first-four-section-daily",
    generated_at: generatedAt,
    date,
    title: "AI 前沿日报",
    deck: "只讲四件事：前沿模型公司、芯片与算力、模型规则与底层研究、Harness 进展。没有重要更新的栏目会留空，不用版本号或来源数量填版面。",
    lead: modelStories.length
      ? "本期最值得注意的变化，不是又多了一个版本号，而是模型能力越来越和低精度训练、长上下文执行、会话状态与 Agent Harness 绑在一起。"
      : "本期没有足够证据的模型公司级发布，重点转向训练执行与 Agent Harness 的系统性变化。",
    sections: [
      {
        id: "model-companies",
        number: "01",
        title: "前沿模型公司",
        description: "只收基础模型、重大版本、开放权重或关键能力与成本边界变化。",
        empty_message: "本期没有达到门槛的前沿模型公司发布。",
        stories: modelStories,
      },
      {
        id: "hardware",
        number: "02",
        title: "芯片与算力",
        description: "只收芯片、互连、Kernel、编译器或训练/推理运行时的代表性进展。",
        empty_message: "本期没有可确认的硬件公司级重大更新；旧产品解读和普通补丁不补位。",
        stories: hardwareStories,
      },
      {
        id: "constitution-analysis",
        number: "03",
        title: "模型规则与底层分析",
        description: "把模型宪法、架构、训练、推理时计算和内部机制放在同一条解释链里。",
        status_note: constitutionChanged
          ? "本期发现模型宪法或行为规范的版本变化，仍需人工语义复核。"
          : "本期未发现 Claude Constitution 或 OpenAI Model Spec 的可验证版本变化。",
        empty_message: "本期没有足够证据的底层研究进展。",
        stories: analysisStories,
      },
      {
        id: "harness",
        number: "04",
        title: "Harness 进展",
        description: "关注上下文、记忆、工具、沙箱、恢复、协作与评测方式，而不是仓库版本号。",
        empty_message: "本期没有改变能力、安全或可靠性的 Harness 进展。",
        stories: harnessStories,
      },
    ],
    reading_notes: {
      paper_batch: digest.date,
      omitted_evaluation_patch: techCandidates.some((item) => includes(item.title, /inspect_evals/i)),
      note: "Inspect Evals 的打分修复保留在后台审计，不作为本期主新闻。",
    },
    manual_review_only: true,
    notification_enabled: false,
  };
}

async function main() {
  const seedDigest = await readJson("data/seed.json", { papers: [], companies: {} });
  const [digest, modelCompute, techDiscovery, mechanismRadar] = await Promise.all([
    readJson("data/latest.json", seedDigest),
    readJson("work/model-compute-source-probe/audit.json"),
    readJson("work/tech-discovery-probe/audit.json"),
    readJson("data/mechanism-radar-latest.json", { cards: [] }),
  ]);
  const generatedAt = modelCompute.generated_at || techDiscovery.generated_at || digest.generated_at || new Date().toISOString();
  const output = buildEditorialSiteData({ digest, modelCompute, techDiscovery, mechanismRadar, generatedAt });
  const target = path.resolve(root, outputPath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`);
  await rename(temporary, target);
  process.stdout.write(`editorial site data written to ${outputPath}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
