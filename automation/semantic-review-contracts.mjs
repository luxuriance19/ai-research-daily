const freezeList = (items) => Object.freeze([...items]);

export const COMMON_REVIEW_CHECKS = freezeList([
  "确认每个来源仍指向 canonical upstream，并逐项核对 arXiv vN、Git SHA、release ID/tag、HF revision 或正文 hash。",
  "把直接可观察事实、作者主张、编辑推断和未知项分开，不用来源权威替代结果独立性。",
  "检查 independence_group 是否真实独立，论文、代码、权重和同一作者组的报道不得重复计票。",
  "检查 artifact 的许可、required files、可运行配置、原始日志/轨迹与缺失文件，不把 artifact availability 写成 result reproduction。",
  "关注度只决定复核顺序；GitHub Trending、HN、媒体或下载量不得提高证据等级或通知资格。",
]);

export const semanticReviewPackages = Object.freeze([
  Object.freeze({
    id: "policy-to-weights",
    title: "规范文本、训练桥接与权重实现",
    topic_ids: freezeList(["openai-model-spec", "claude-constitution", "model-spec-midtraining"]),
    layers: freezeList(["B0", "M2", "M4"]),
    review_focus: "把官方 intended-behavior 文本变化、开放模型训练桥接和生产权重中的 learned mechanism 分开。",
  }),
  Object.freeze({
    id: "latent-and-recurrent-computation",
    title: "循环深度、连续隐状态与潜在计算",
    topic_ids: freezeList(["ouro-looplm", "coconut-continuous-thought", "hidden-decoding"]),
    layers: freezeList(["M1", "M2", "M3", "M4"]),
    review_focus: "核对 computation graph、训练/推理预算、直接 checkpoint 干预和跨模型外推边界。",
  }),
  Object.freeze({
    id: "internal-causal-analysis",
    title: "模型内部机制与因果解释",
    topic_ids: freezeList(["circuit-tracing"]),
    layers: freezeList(["M4"]),
    review_focus: "区分 feature/circuit localization、替代模型近似、干预覆盖和完整因果解释。",
  }),
  Object.freeze({
    id: "harness-and-evaluation",
    title: "Agent Harness、Evaluation Harness 与可比性",
    topic_ids: freezeList(["agent-harness", "evaluation-harness"]),
    layers: freezeList(["H1", "E1"]),
    review_focus: "把 release occurrence、语义变更、固定模型能力增益和评测可比性分成四个不同结论。",
  }),
]);

export const topicReviewGuidance = Object.freeze({
  "openai-model-spec": Object.freeze({
    notification_ceiling: "P0 candidate for a material intended-policy change only after a versioned diff and human semantic review",
    review_questions: freezeList([
      "变更是否触及 authority hierarchy、hard constraint、conflict resolution 或安全边界，而非格式、构建或 no-content commit？",
      "CHANGELOG、manifest、dated HTML 与 canonical Markdown 是否指向同一公开版本？",
      "是否明确避免把 Model Spec 文本变化写成生产模型已经遵从或权重机制已经改变？",
    ]),
    prohibited_conclusions: freezeList([
      "生产模型已经完整实现 Model Spec。",
      "文本 diff 证明了训练因果、遵从率或 learned circuit。",
    ]),
  }),
  "claude-constitution": Object.freeze({
    notification_ceiling: "P0 candidate for a material Constitution change only after a structured document event and human review",
    review_questions: freezeList([
      "repository 是否新增/替换 dated Constitution，旧 canonical raw path 未变化时是否仍能发现？",
      "文本差异是否改变价值优先级、authority、hard constraint 或冲突处理，而非排版和注释？",
      "README current-version pointer、dated files 与 canonical text 是否一致；commit-only 或 README copy edit 是否被排除？",
    ]),
    prohibited_conclusions: freezeList([
      "Claude 当前权重已经把 2026 Constitution 写成可定位 circuit。",
      "任何开放模型实验等同于 Claude 训练流程或生产权重证据。",
    ]),
  }),
  "model-spec-midtraining": Object.freeze({
    notification_ceiling: "P2 attributed open-model training result; learned internalization remains held without M4 intervention",
    review_questions: freezeList([
      "base revision、adapter、dataset、训练/评测代码与论文版本是否精确绑定，且未把同一作者组的四类 artifact 重复计为独立结果？",
      "结论是否严格限于公开 Qwen 实验及作者报告，未外推到 Claude、OpenAI 或其他生产模型？",
      "是否存在训练前后内部表征定位、必要/充分干预、matched controls、raw results 与不同作者组复现？",
    ]),
    prohibited_conclusions: freezeList([
      "Claude 或其他生产模型使用了 MSM 配方。",
      "行为 OOD 提升证明规范已内化为可定位且因果必要的 circuit。",
    ]),
  }),
  "ouro-looplm": Object.freeze({
    notification_ceiling: "P1 attributed architecture/artifact update; causal generalization remains held for independent reproduction",
    review_questions: freezeList([
      "明确记录 loop/recurrent block、UT steps、early-exit 阈值和服务实现是否实际执行 adaptive exit。",
      "发布 modeling 代码是否在阈值满足时真正中断 recurrent forward，并公开 matched quality、FLOPs 与 wall-clock；若先跑完再选状态，只能写后验选择。",
      "base 与 Thinking 四模型是否只证明 family artifact availability，而未被重复计为四份独立证据？",
      "直接 checkpoint diagnostic 是否包含原始日志、训练后对照 checkpoint、跨深度/架构与 matched-compute baseline？",
    ]),
    prohibited_conclusions: freezeList([
      "循环深度本身已被证明稳定地产生通用推理能力。",
      "公开推理代码和权重等于 7.7T-token 训练栈可复现。",
      "论文中的 early-exit 目标等于发布实现已经节省 recurrent FLOPs 或端到端延迟。",
    ]),
  }),
  "coconut-continuous-thought": Object.freeze({
    notification_ceiling: "P1 attributed latent-computation study; faithful-reasoning claim remains held",
    review_questions: freezeList([
      "hidden-state feedback 的计算图、训练阶段、latent steps 与显式 token baseline 是否可定位？",
      "干预作用于原始 Coconut checkpoint、Coconut-style 新模型，还是小型 CODI/COCONUT 派生 checkpoint？",
      "是否公开 raw hidden states、跨 backbone/domain、多 seed 和不同作者组的结果级复跑？",
    ]),
    prohibited_conclusions: freezeList([
      "latent state 是忠实、逐步且可解释的完整推理轨迹。",
      "小型合成任务或 GPT-2-small/GSM8K 结果可外推到自然语言大模型。",
    ]),
  }),
  "hidden-decoding": Object.freeze({
    notification_ceiling: "P1 attributed architecture release at demonstration scale only",
    review_questions: freezeList([
      "stream expansion 与 stream-factorized attention 的实际实现是否与论文描述一致？",
      "公开 8B demonstration 与 80B/617B 主实验在权重、训练代码和结果日志上是否被清楚区分？",
      "许可证限制、matched-compute baseline 和独立重跑是否完整披露？",
    ]),
    prohibited_conclusions: freezeList([
      "公开 8B 模型复现了 80B/617B 主实验增益。",
      "inference patch 证明训练栈或大规模因果增益可复现。",
    ]),
  }),
  "circuit-tracing": Object.freeze({
    notification_ceiling: "P1/P2 scoped method or counter-evidence update; complete causal logic requires G3/G4",
    review_questions: freezeList([
      "报告的是相关性、steering、ablation、causal mediation 还是 replacement fidelity？",
      "Pando、MIB 与 InterpBench 的 model-organism/半合成边界是否被错误外推到 Claude 自然行为？",
      "是否存在不同作者组的结果级复现、跨 prompt/model/OOD 验证与未解释残差？",
    ]),
    prohibited_conclusions: freezeList([
      "attribution graph 已完整揭示模型底层逻辑。",
      "工具 release 或半合成 benchmark 等同于独立科学复现。",
    ]),
  }),
  "agent-harness": Object.freeze({
    notification_ceiling: "P2 for a material versioned semantic delta; P1 uplift requires an independent fixed-setting rerun",
    review_questions: freezeList([
      "release 是否真正改变 context、memory、tool、sandbox、session、retry、tracing 或安全边界，而非普通 patch？",
      "前后比较是否固定 model/version、task/environment、prompt、tool interface、budget、grader 和 baseline？",
      "是否公开 raw trajectories/results，且 counter-evidence 与 direct rerun 未被混为一类？",
    ]),
    prohibited_conclusions: freezeList([
      "版本发布自动意味着固定模型能力提升。",
      "不同 protocol 的类别反证等同于对 Harness Updating 的直接复跑。",
    ]),
  }),
  "evaluation-harness": Object.freeze({
    notification_ceiling: "P2 for material task/scorer semantics; score reversal requires G3 matched reruns",
    review_questions: freezeList([
      "task、dataset、prompt/template、scorer、grader、adapter 或 schema 的哪一项发生了版本化变化？",
      "旧新分数是否使用同一 model snapshot、harness、environment、budget 和 grader，并公开 raw rerun？",
      "N-X policy、release note 和代码/配置 diff 是否能配对；LHTB 的 Codex/Terminus-2 例外是否披露？",
    ]),
    prohibited_conclusions: freezeList([
      "changelog 或 task version 变化本身证明了分数影响量。",
      "不同 harness 的 leaderboard 数字可直接归因为模型能力差异。",
    ]),
  }),
});

export const SEMANTIC_REVIEW_MINIMUM_SILENT_DAYS = 7;
