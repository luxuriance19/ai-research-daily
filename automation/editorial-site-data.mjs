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
    title_zh: "8 张 H20，把 RL 上下文推到 210 万 token",
    summary_zh: "LongStraw 的办法很直接：长提示词先做前向计算，不保留完整求导图；真正需要回传梯度时，再逐条回放短响应。它用更多计算时间换显存。",
    angle_label_zh: "它解决了什么",
    why_it_matters_zh: "Agent 做长任务会不断累积网页、工具输出和历史决策，但后训练的上下文长度一直追不上推理。LongStraw 瞄准的正是这段差距。",
    key_points_zh: [
      "Qwen3.6-27B 在 8 张 H20 上完成了 210 万位置的分组评分和响应反向传播；扩大组大小只增加约 0.21 GB 峰值显存。",
      "压力测试跑到 446 万位置；32 张 H20 上，GLM-5.2 的 78 层完成了 210 万 token 提示词的端到端执行。",
      "省下的是显存，付出的是回放时间：短响应分支要重新计算。",
    ],
    caveat_label_zh: "先别写成什么",
    caveat_zh: "这还不是“200 万 token RL 已经跑通”。提示词状态被 detach，部分分布式前向和梯度组合路径仍未完成。论文目前证明的是执行容量。",
    lead_note_zh: "研究侧先看 LongStraw：它用回放换显存，让 8 张 H20 扛住 210 万 token。",
  },
  "2607.14777": {
    title_zh: "Agent 做完任务后，再从自己的轨迹里总结技能",
    summary_zh: "SEED 让当前策略回看已经完成的轨迹，整理出工作流、关键观察和避错规则，再把这些规则带来的动作概率变化转成逐 token 训练信号。",
    angle_label_zh: "值得追的点",
    why_it_matters_zh: "Agent 强化学习往往只知道最后成功还是失败，中间哪一步做对了、哪一步走了弯路，奖励很难说清。SEED 试着补上这层反馈。",
    key_points_zh: [
      "技能来自当前策略自己的 on-policy 轨迹，不依赖一个长期固定的外部教师。",
      "普通上下文与技能增强上下文之间的动作概率差，被转成稠密的蒸馏信号。",
      "作者报告了文本和视觉 Agent 任务上的性能、样本效率提升，代码与完整实验设置仍要继续核对。",
    ],
    caveat_label_zh: "尚未回答",
    caveat_zh: "这些自然语言技能是否对应模型内部的真实因果机制，论文摘要回答不了。眼下只能确认它是一种训练信号设计。",
    lead_note_zh: "SEED 值得留意：它让 Agent 在任务结束后回看自己的轨迹，再把总结出的技能用于训练。",
  },
  "2607.14935": {
    title_zh: "VideoChat3 想把视频理解做成一套能复现的开源栈",
    summary_zh: "VideoChat3 用膨胀式 3D 视觉 Transformer 和自适应帧分辨率控制视频计算成本，并准备了通用、长视频和流式视频三套训练数据。",
    angle_label_zh: "它补的不只一块短板",
    why_it_matters_zh: "公开视频模型常见两种缺口：换个视频场景就失灵，或者只放权重、不放训练方法。VideoChat3 同时处理泛化、效率和复现材料。",
    key_points_zh: [
      "I3D-ViT 负责时空表示，自适应帧分辨率根据流式内容分配视觉计算。",
      "三套训练数据分别覆盖通用视频、长视频与在线流式场景，目标是减少跨场景能力断层。",
      "论文与代码仓库已经上线；数据许可、训练脚本、配置和完整复现实验还要逐项核对。",
    ],
    caveat_label_zh: "开源还要逐项核对",
    caveat_zh: "现在能确认的是论文和公开仓库。数据是否齐全、训练配方是否完整、结果能否被第三方复现，还没有答案。",
    lead_note_zh: "VideoChat3 同时盯着视频模型的流式效率、泛化和复现材料。",
  },
  "2607.15257": {
    title_zh: "SearchOS 把搜索 Agent 的进度从聊天记录里搬出来",
    summary_zh: "SearchOS 把搜索进度拆成待办前沿、证据图、覆盖地图和失败记忆。多个子 Agent 不必反复翻聊天记录，可以直接接着缺口往下做。",
    angle_label_zh: "为什么这很实际",
    why_it_matters_zh: "长任务经常败在管理混乱：系统忘了查过什么、还缺什么，也忘了哪些路已经走不通。这里解决的是协作记忆，不是搜索提示词。",
    key_points_zh: [
      "把开放域检索建模为带引用的关系表补全，让每个结论都能落到证据。",
      "用流水线并行调度持续填充空闲槽位，把算力投入尚未覆盖的信息缺口。",
      "中间件记录模型与工具交互，在搜索停滞或预算快耗尽时介入。",
    ],
    caveat_label_zh: "结果该怎么算",
    caveat_zh: "论文里的收益来自模型、上下文结构、调度和工具中间件共同作用，不能全记在基础模型头上。",
    lead_note_zh: "Harness 侧看 SearchOS：它把搜索进度从聊天记录拆成了可共享的工作状态。",
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
    angle_label: profile?.angle_label_zh || "先看它解决什么",
    why_it_matters: profile?.why_it_matters_zh || "它提供了一个值得继续核验的研究方向，但热度本身不等于结论已经成立。",
    key_points: profile?.key_points_zh || [
      "先看论文解决的具体问题，而不是只看标题和排行榜。",
      "再核对方法、实验设置、代码与失败案例是否完整。",
    ],
    caveat_label: profile?.caveat_label_zh || "现在能说到哪里",
    caveat: profile?.caveat_zh || "目前的信息来自论文摘要和作者材料。阅读全文、检查代码和独立复现之后，结论才可能更进一步。",
    lead_note: profile?.lead_note_zh || `${profile?.title_zh || paper.title_zh || paper.title} 进入了今天的论文关注榜。`,
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
      title: "Kimi K3 上线：2.8T MoE 先到，权重和技术报告还没来",
      original_title: item.title,
      published_at: item.published_at,
      summary: "官方先开放了产品和 API，也给出了 2.8T 参数 MoE、Kimi Delta Attention、Attention Residuals 与低精度训练方案。完整权重和技术报告还没发布。",
      angle_label: "看点在系统，不只在参数",
      why_it_matters: "K3 把模型架构、低精度训练、并行系统和 Agent 使用方式放在同一套发布里。单看参数规模，会漏掉大半信息。",
      key_points: [
        "产品与 API 已可用；开放权重仍要等官方交付。",
        "官方披露 KDA、Attention Residuals、896 专家中激活 16 个，以及 MXFP4/MXFP8 量化感知训练等设计。",
        "官方评测使用了 KimiCode、Claude Code、Codex、Terminus 2 等不同 Harness，榜单里混有系统差异。",
      ],
      caveat_label: "还缺的材料",
      caveat: "完整权重、技术报告、训练配置和原始评测都还没到。现阶段可以说它已上线，不能说已经具备独立复现条件。",
      lead_note: "K3 的产品和 API 先到了，权重与技术报告还在路上。",
      sources: [{ label: "Kimi 官方发布", url: item.url }],
    };
  }
  return {
    id: item.identity || `model:${item.url}`,
    kind: "model-release",
    title: item.title,
    original_title: item.title,
    published_at: item.published_at,
    summary: "官方发布入口已经出现这条更新。权重、许可证、技术材料和实际可用性还要分开看。",
    angle_label: "为什么进今天的版面",
    why_it_matters: "这次更新触及模型能力、成本、开放性或使用方式中的至少一项。",
    key_points: ["官方发布身份已经确认。", "可用性和开放程度会分开记录。"],
    caveat_label: "目前能说到这里",
    caveat: "公告能证明版本发布，不能替代开放权重检查或独立评测。",
    lead_note: `模型端今天有一条正式发布：${item.title}。`,
    sources: [{ label: "官方来源", url: item.url }],
  };
}

function harnessStory(item) {
  const isOpenAIAgents = includes(item.title, /openai-agents-python/i);
  if (isOpenAIAgents) {
    return {
      id: item.normalized_event_fingerprint || "harness:openai-agents-0.18.3",
      kind: "harness-release",
      title: "OpenAI Agents SDK 这次在补会话、并发和沙箱的工程账",
      original_title: item.title,
      published_at: item.published_at,
      summary: "这次更新动了 tracing、实时会话用量、memory 初始化、handoff 消息保留、并发 Provider 隔离和 sandbox 工作区。都是小处，却正好是 Agent 跑久以后最容易出问题的地方。",
      angle_label: "这些小改动为什么重要",
      why_it_matters: "Agent 能不能稳定完成长任务，很大一部分取决于会话状态、并发隔离、失败恢复和可观测性。这里补的是运行可靠性。",
      key_points: [
        "任务与 turn 的 tracing span 可配置，实时会话能记录 response usage。",
        "memory 初始化改为串行，handoff 保留历史包装中的用户消息。",
        "并发运行隔离 Provider 实例，sandbox 避免重复创建工作区根目录。",
      ],
      caveat_label: "不能顺手推出的结论",
      caveat: "Release 能证明实现发生了变化。没有固定模型、任务和环境的前后对照，暂时看不出它让任务成功率提高了多少。",
      lead_note: "OpenAI Agents SDK 在补会话、并发隔离和 sandbox 这些长期运行问题。",
      sources: [{ label: "OpenAI 官方 Release", url: item.canonical_url }],
    };
  }
  return {
    id: item.normalized_event_fingerprint || `harness:${item.canonical_url}`,
    kind: "harness-release",
    title: item.title,
    original_title: item.title,
    published_at: item.published_at,
    summary: "这次更新改动了 Agent 或评测 Harness 的实际运行方式。版本号只是定位信息，正文只看上下文、工具、沙箱、重试、并发或 grader 的变化。",
    angle_label: "真正要盯的地方",
    why_it_matters: "Harness 的运行方式会改变系统表现，也可能影响评测结果。",
    key_points: ["改动来自官方版本说明。", "实际收益还要用固定模型、任务、环境和预算验证。"],
    caveat_label: "版本号证明不了的",
    caveat: "这次发布本身不能证明能力提高，也不能保证新旧分数仍然可比。",
    lead_note: `Harness 侧出现一条工程更新：${item.title}。`,
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
  const leadNotes = [modelStories[0]?.lead_note, hardwareStories[0]?.lead_note, analysisStories[0]?.lead_note, harnessStories[0]?.lead_note].filter(Boolean);

  return {
    schema_version: 1,
    mode: "reader-first-four-section-daily",
    generated_at: generatedAt,
    date,
    title: "AI 前沿日报",
    deck: "今天按四条线读：模型发布、芯片与算力、模型规则与底层研究、Harness。没有够格的新消息，就空着。",
    lead: leadNotes.slice(0, 2).join("") || "模型和芯片今天都没有硬新闻，论文与 Harness 也没有值得单列的新进展。",
    sections: [
      {
        id: "model-companies",
        number: "01",
        title: "前沿模型公司",
        description: "新模型、重大版本、开放权重，以及真正改变能力或成本的更新。",
        empty_message: "今天没有够格的模型公司新闻。",
        stories: modelStories,
      },
      {
        id: "hardware",
        number: "02",
        title: "芯片与算力",
        description: "芯片、互连、Kernel、编译器，以及训练和推理运行时。",
        empty_message: "今天没有硬件大新闻，旧解读和普通补丁不凑数。",
        stories: hardwareStories,
      },
      {
        id: "constitution-analysis",
        number: "03",
        title: "模型规则与底层分析",
        description: "模型规范、架构、训练、推理时计算，以及仍没弄懂的内部机制。",
        status_note: constitutionChanged
          ? "相关规范今天有版本变化，语义还在人工复核。"
          : "Claude Constitution 和 OpenAI Model Spec 今天都没有版本变化。",
        empty_message: "今天没有值得单列的底层研究进展。",
        stories: analysisStories,
      },
      {
        id: "harness",
        number: "04",
        title: "Harness 进展",
        description: "上下文、记忆、工具、沙箱、恢复、协作和评测。",
        empty_message: "今天没有值得单列的 Harness 更新。",
        stories: harnessStories,
      },
    ],
    reading_notes: {
      paper_batch: digest.date,
      omitted_evaluation_patch: techCandidates.some((item) => includes(item.title, /inspect_evals/i)),
      note: "Inspect Evals 的 scorer 修复今天只进审计记录，不占日报版面。",
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
