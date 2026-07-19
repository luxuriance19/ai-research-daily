/* eslint-disable @next/next/no-img-element */
import { listDigests } from "@/lib/digests";
import type { CompanyItem, Paper } from "@/lib/types";
import Link from "next/link";
import top3Audit from "../data/top3-latest.json";
import mechanismRadarAudit from "../data/mechanism-radar-latest.json";
import sourceQualityAudit from "../data/source-quality-latest.json";
import formulaAssetsAudit from "../data/formula-assets-latest.json";

const companyOrder = ["OpenAI", "Anthropic", "Google DeepMind", "DeepSeek"];

type EvidencePoint = {
  topic: string;
  mechanism_layer: string;
  statement_zh: string;
  evidence_ceiling: string;
  verification_state: string;
  boundary: string;
  source_url: string;
  source_identity: string;
  formula?: {
    label_zh: string;
    alt_zh: string;
    latex: string;
    verification_state: "source-exact";
    source_url: string;
    source_identity: string;
    source_excerpt_sha256: string;
  };
};

type EvidenceDossier = {
  rank: number;
  story_id: string;
  title: string;
  primary_section: string;
  canonical_url: string;
  selection_score: number;
  evidence_status: string;
  key_points: EvidencePoint[];
  evidence_gaps: string[];
};

const latestTop3 = top3Audit as unknown as {
  generated_at: string;
  status: string;
  metrics: { dossiers_created: number; key_points_extracted: number; evidence_gaps: number };
  manual_review_only: boolean;
  notification_enabled: boolean;
  publishing_enabled: boolean;
  dossiers: EvidenceDossier[];
};

type MechanismRadarCard = {
  id: string;
  layer: string;
  title: string;
  thesis_zh: string;
  boundary_zh: string;
  primary_url: string;
  current_event: false;
  attention_level: string;
  claim_metrics: { source_ready: number; human_review_required: number; evidence_gap: number };
  source_observation: {
    observed_days: number;
    required_days: number;
    state: "observing" | "degraded" | "await-human-source-review";
    degraded_source_count: number;
    review_flag_count: number;
    human_review_complete: boolean;
  };
};

const latestMechanismRadar = mechanismRadarAudit as unknown as {
  generated_at: string;
  status: string;
  current_event_candidates: number;
  cards: MechanismRadarCard[];
};

type SourceQualityEntry = {
  id: string;
  label: string;
  lane: "mechanism" | "technology-attention" | "model-compute";
  quality_role: string;
  health: { state: "healthy" | "degraded"; source_status: string };
  observation: { scorecard_consecutive_healthy_days: number; required_days_for_role_review: number; ready_for_human_role_review: boolean };
  today: { current_window_attributions: number; editorial_exclusion_attributions: number; eligible_candidate_attributions: number; selected_top3_attributions: number };
  recommendation: string;
};

const latestSourceQuality = sourceQualityAudit as unknown as {
  generated_at: string;
  report_date: string;
  status: string;
  summary: {
    registered_sources: number;
    healthy_sources: number;
    degraded_sources: number;
    editorial_exclusion_endpoint_attributions: number;
    selected_top3_contributors: number;
    ready_for_human_role_review: number;
  };
  sources: SourceQualityEntry[];
};

type FormulaAsset = {
  id: string;
  scope: "editorial-method" | "research-source-exact";
  story_id?: string;
  point_topic?: string;
  label_zh: string;
  alt_zh: string;
  asset_url: string;
};

const latestFormulaAssets = formulaAssetsAudit as unknown as {
  generated_at: string;
  formulas: FormulaAsset[];
};
const rankingFormula = latestFormulaAssets.formulas.find((formula) => formula.id === "editorial-ranking-score-v1");

const sectionLabels: Record<string, string> = {
  "new-model": "新模型",
  mechanism: "底层机制",
  "harness-eval": "Harness / Eval",
  "compute-system": "算力系统",
};

const sourceLanes = [
  { label: "论文与机制", count: 21, detail: "arXiv · Hugging Face · Semantic Scholar · 官方论文与代码页" },
  { label: "模型与算力", count: 16, detail: "官方模型页 · 芯片厂商 · 研究实验室 · GitHub Releases" },
  { label: "技术与社区", count: 11, detail: "GitHub Trending · Latent Space · Hacker News · 权威科技媒体" },
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${value}T00:00:00+08:00`));
}

function formatReportDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function paperTitle(paper: Paper) {
  return paper.title_zh || paper.title;
}

function paperSummary(paper: Paper) {
  return paper.summary_zh || paper.summary;
}

function paperKeyPoints(paper: Paper) {
  return (paper.key_points_zh || []).filter(Boolean).slice(0, 4);
}

function companyTitle(item: CompanyItem) {
  return item.title_zh || item.title;
}

function companySummary(item: CompanyItem) {
  return item.summary_zh || item.summary || "官方来源未提供摘要，请阅读原文。";
}

function PaperCard({ paper, rank, maxVotes }: { paper: Paper; rank: number; maxVotes: number }) {
  const voteWidth = Math.max(8, Math.round((paper.upvotes / Math.max(maxVotes, 1)) * 100));
  return (
    <details className="paper-card">
      <summary>
        <span className="paper-rank" aria-label={`补充排名 ${rank}`}>{String(rank).padStart(2, "0")}</span>
        <span className="paper-body paper-body-preview">
          <span className="paper-kicker">
            <span>{paper.categories.slice(0, 3).join(" · ") || "AI Research"}</span>
            <span>{paper.upvotes} HF 赞</span>
          </span>
          <strong className="paper-preview-title">{paperTitle(paper)}</strong>
          <span className="paper-preview-reason">{paper.why_zh || "社区热度补充，只在展开后显示详细分析。"}</span>
          <span className="vote-track" aria-label={`${paper.upvotes} 个 Hugging Face 赞`}><span style={{ width: `${voteWidth}%` }} /></span>
        </span>
        <span className="paper-expand" aria-hidden="true" />
      </summary>
      <div className="paper-expanded">
        <div className="paper-kicker"><span>补充雷达 · 非 Top 3</span><span>展开内容不代表入选</span></div>
        <h3>{paperTitle(paper)}</h3>
        {paper.title_zh && paper.title_zh !== paper.title ? <p className="original-title">{paper.title}</p> : null}
        <p className="paper-summary">{paperSummary(paper)}</p>
        <p className="paper-why"><strong>关注理由</strong>{paper.why_zh || "当日社区关注度较高，值得进一步阅读原文。"}</p>
        <div className="paper-deep-dive">
          <div>
            <span>研究问题</span>
            <p>{paper.problem_zh || "需要阅读全文后补充更精确的问题定义。"}</p>
          </div>
          <div>
            <span>核心方法</span>
            <p>{paper.method_zh || "来源摘要未提供足够方法细节，建议进入论文核验。"}</p>
          </div>
          {paperKeyPoints(paper).length ? (
            <div className="wide">
              <span>关键点</span>
              <ul>
                {paperKeyPoints(paper).map((point) => <li key={point}>{point}</li>)}
              </ul>
            </div>
          ) : null}
          <div>
            <span>局限与风险</span>
            <p>{paper.limitations_zh || "当前自动摘要未识别明确局限，发布前建议人工复核实验设置。"}</p>
          </div>
          <div>
            <span>公众号角度</span>
            <p>{paper.pub_angle_zh || "可作为当日热点论文观察，需结合代码、实验和应用场景再定标题。"}</p>
          </div>
        </div>
        {paper.source_signals?.length ? (
          <div className="signal-list" aria-label="辅助热度信号">
            {paper.source_signals.slice(0, 4).map((signal) => <span key={signal}>{signal}</span>)}
          </div>
        ) : null}
        <div className="paper-footer">
          <span>{paper.authors.slice(0, 3).join("、")}{paper.authors.length > 3 ? " 等" : ""}</span>
          <nav aria-label={`${paperTitle(paper)} 的来源`}>
            <a href={paper.hf_url} target="_blank" rel="noreferrer">HF</a>
            <a href={paper.arxiv_url} target="_blank" rel="noreferrer">arXiv</a>
            {paper.github_url ? <a href={paper.github_url} target="_blank" rel="noreferrer">Code</a> : null}
          </nav>
        </div>
      </div>
    </details>
  );
}

function CompanyCard({ company, items }: { company: string; items: CompanyItem[] }) {
  return (
    <section className="company-card">
      <div className="company-heading">
        <span className="company-dot" />
        <h3>{company}</h3>
        <span>{items.length} 条信号</span>
      </div>
      <div className="company-list">
        {items.map((item) => (
          <article key={item.url}>
            <div className="signal-meta">
              <time>{item.published_at?.slice(0, 10) || "日期待确认"}</time>
              <span>{item.directions?.[0] || "研究动态"}</span>
            </div>
            <h4><a href={item.url} target="_blank" rel="noreferrer">{companyTitle(item)}</a></h4>
            <p>{companySummary(item)}</p>
            <div className="direction-tags">
              {(item.directions || []).slice(0, 3).map((direction) => <span key={direction}>{direction}</span>)}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function MetricRail() {
  return (
    <div className="metric-rail" aria-label="本期摘要指标">
      <div>
        <span>TOP</span>
        <strong>{latestTop3.metrics.dossiers_created}</strong>
        <em>代表事件</em>
      </div>
      <div>
        <span>POINT</span>
        <strong>{latestTop3.metrics.key_points_extracted}</strong>
        <em>机制要点</em>
      </div>
      <div>
        <span>ACTION</span>
        <strong>0</strong>
        <em>自动发布</em>
      </div>
    </div>
  );
}

function Top3StatusStrip() {
  return (
    <div className="status-strip" aria-label="Top 3 审阅状态">
      <span className="status-review" />
      <strong>一手证据已整理，等待人工审阅</strong>
      <span>{latestTop3.metrics.dossiers_created} 条 / {latestTop3.metrics.key_points_extracted} 个要点</span>
      <span className="status-separator" />
      <span>更新于 {new Date(latestTop3.generated_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</span>
    </div>
  );
}

function Top3Card({ dossier }: { dossier: EvidenceDossier }) {
  return (
    <article className={`brief-card brief-card-${dossier.primary_section}`}>
      <div className="brief-rank">
        <span>NO.</span>
        <strong>{String(dossier.rank).padStart(2, "0")}</strong>
        <em>{dossier.selection_score.toFixed(1)}</em>
      </div>
      <div className="brief-content">
        <div className="brief-meta">
          <span>{sectionLabels[dossier.primary_section] || dossier.primary_section}</span>
          <span>{dossier.evidence_status === "source-audited-manual-review" ? "来源已审计" : "证据待补"}</span>
        </div>
        <h3><a href={dossier.canonical_url} target="_blank" rel="noreferrer">{dossier.title}</a></h3>
        <div className="mechanism-points">
          {dossier.key_points.map((point) => {
            const formula = latestFormulaAssets.formulas.find((item) => item.scope === "research-source-exact" && item.story_id === dossier.story_id && item.point_topic === point.topic);
            return (
            <section key={`${dossier.story_id}-${point.topic}`}>
              <div className="point-heading">
                <span>{point.mechanism_layer}</span>
                <strong>{point.topic.replaceAll("-", " ")}</strong>
              </div>
              <p>{point.statement_zh}</p>
              {formula ? <figure className="research-formula">
                <figcaption>{formula.label_zh} · 一手原式</figcaption>
                <img src={formula.asset_url} alt={formula.alt_zh} />
                <small>只显示一手摘录中逐字出现的公式，不由摘要反推。</small>
              </figure> : null}
              <div className="point-boundary"><span>证据边界</span>{point.boundary}</div>
              <div className="point-source">
                <span>{point.evidence_ceiling}</span>
                <a href={point.source_url} target="_blank" rel="noreferrer">查看一手来源 ↗</a>
              </div>
            </section>
            );
          })}
        </div>
        <details className="evidence-gaps">
          <summary>仍缺少的证据 · {dossier.evidence_gaps.length}</summary>
          <ul>{dossier.evidence_gaps.map((gap) => <li key={gap}>{gap.replaceAll("-", " ")}</li>)}</ul>
        </details>
      </div>
    </article>
  );
}

function MechanismRadar() {
  return (
    <section className="section-block mechanism-radar-section" id="mechanism-radar">
      <div className="section-title">
        <div><p className="eyebrow">MECHANISM WATCH · LONG-RUN</p><h2>底层机制雷达</h2></div>
        <p>不是当天新闻，也不是语言风格分析。<br />持续核对模型计算路径与证据缺口。</p>
      </div>
      <div className="radar-disclosure">
        <div><span className={latestMechanismRadar.status === "degraded" ? "status-warning" : "status-live"} /><strong>长期尽调 · 本轮新事件 {latestMechanismRadar.current_event_candidates}</strong></div>
        <p>来源稳定性与 claim 完整性分开显示；达到 7 天也仍需人工来源复核。</p>
      </div>
      <div className="mechanism-radar-grid">
        {latestMechanismRadar.cards.map((card) => (
          <article className="mechanism-radar-card" key={card.id}>
            <div className="radar-card-head">
              <span>{card.layer}</span>
              <em className={`radar-state radar-state-${card.source_observation.state}`}>
                {card.source_observation.state === "degraded" ? "来源降级" : `静默 ${card.source_observation.observed_days}/${card.source_observation.required_days}`}
              </em>
            </div>
            <h3><a href={card.primary_url} target="_blank" rel="noreferrer">{card.title}</a></h3>
            <p className="radar-thesis">{card.thesis_zh}</p>
            <div className="radar-boundary"><span>不能越过的结论</span><p>{card.boundary_zh}</p></div>
            <div className="radar-metrics">
              <span><strong>{card.claim_metrics.source_ready}</strong>窄 claim 可追溯</span>
              <span><strong>{card.claim_metrics.evidence_gap}</strong>证据缺口</span>
              <span><strong>{card.attention_level}</strong>关注层</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function StudioRail() {
  return (
    <aside className="studio-rail" aria-label="页面导航">
      <a className="rail-logo" href="#overview" aria-label="前沿信号顶部">FS</a>
      <nav>
        <a className="active" href="#overview"><span>01</span><em>概览</em></a>
        <a href="#top3"><span>02</span><em>Top 3</em></a>
        <a href="#mechanism-radar"><span>03</span><em>机制</em></a>
        <a href="#sources"><span>04</span><em>来源</em></a>
        <a href="#papers"><span>05</span><em>论文</em></a>
        <a href="#companies"><span>06</span><em>实验室</em></a>
      </nav>
      <div className="rail-state"><i />静默审阅</div>
    </aside>
  );
}

function SourceArchitecture() {
  const selectedContributors = latestSourceQuality.sources.filter((source) => source.today.selected_top3_attributions > 0);
  const noisyObservations = latestSourceQuality.sources
    .filter((source) => source.today.editorial_exclusion_attributions > 0)
    .sort((left, right) => right.today.editorial_exclusion_attributions - left.today.editorial_exclusion_attributions)
    .slice(0, 3);
  return (
    <section className="section-block source-section" id="sources">
      <div className="section-title">
        <div><p className="eyebrow">SOURCE PIPELINE</p><h2>来源不是越多越好</h2></div>
        <p>发现与举证分开运行。只有进入 Top 3 的事件，才触发逐论点证据抓取。</p>
      </div>
      <div className="pipeline-summary">
        <div className="pipeline-number"><strong>48</strong><span>注册发现源</span></div>
        <div className="pipeline-arrow" aria-hidden="true">→</div>
        <div className="pipeline-number"><strong>10</strong><span>采集器分组</span></div>
        <div className="pipeline-arrow" aria-hidden="true">→</div>
        <div className="pipeline-number featured"><strong>3</strong><span>最多入选</span></div>
        <div className="pipeline-arrow" aria-hidden="true">→</div>
        <div className="pipeline-number"><strong>64</strong><span>按需证据端点</span></div>
      </div>
      <div className="source-lanes">
        {sourceLanes.map((lane) => (
          <article key={lane.label}>
            <div><span>{String(lane.count).padStart(2, "0")}</span><i /></div>
            <h3>{lane.label}</h3>
            <p>{lane.detail}</p>
          </article>
        ))}
      </div>
      <div className="source-quality-console">
        <div className="source-quality-head">
          <div><span className={latestSourceQuality.status === "ok" ? "status-live" : "status-warning"} /><strong>当日来源质量账本</strong></div>
          <p>单日只记录，不自动删源；连续 7 个自然日后才进入人工角色复核。</p>
        </div>
        <div className="source-quality-metrics">
          <div><strong>{latestSourceQuality.summary.healthy_sources}/{latestSourceQuality.summary.registered_sources}</strong><span>当日健康</span></div>
          <div><strong>{latestSourceQuality.summary.selected_top3_contributors}</strong><span>Top 贡献源</span></div>
          <div><strong>{latestSourceQuality.summary.editorial_exclusion_endpoint_attributions}</strong><span>排除归因</span></div>
          <div><strong>{latestSourceQuality.summary.ready_for_human_role_review}</strong><span>可人审调级</span></div>
        </div>
        <div className="source-quality-columns">
          <section>
            <span>今日高信号贡献</span>
            {selectedContributors.map((source) => <div key={source.id}><strong>{source.label}</strong><em>{source.quality_role.replaceAll("-", " ")} · Top {source.today.selected_top3_attributions}</em></div>)}
          </section>
          <section>
            <span>噪声观察（不代表删源）</span>
            {noisyObservations.map((source) => <div key={source.id}><strong>{source.label}</strong><em>排除归因 {source.today.editorial_exclusion_attributions} · 观察 {source.observation.scorecard_consecutive_healthy_days}/7</em></div>)}
          </section>
        </div>
      </div>
      <div className="rule-console">
        <div><span>准入</span><code>一手身份 + 明确技术增量 + 48h 时效</code></div>
        <div><span>排序</span><code>I(0–2) + Δtech(0–3) + Artifact(0–2) + Heat(0–2) + Freshness(0–1)</code></div>
        <div><span>输出</span><code>score ≥ 6 · 每类最多 1 条 · 不足则留空</code></div>
      </div>
    </section>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const [{ date }, digests] = await Promise.all([searchParams, listDigests()]);
  const digest = digests.find((item) => item.date === date) ?? digests[0];
  const papers = digest?.papers || [];
  const maxVotes = Math.max(...papers.map((paper) => paper.upvotes), 1);

  return (
    <main className="studio-shell">
      <StudioRail />
      <div className="studio-main">
        <header className="site-header">
          <Link className="brand" href="/" aria-label="前沿信号首页">
            <span><strong>AI Signal Studio</strong><small>前沿信号 · DAILY RESEARCH CONSOLE</small></span>
          </Link>
          <nav className="header-actions" aria-label="快捷导航">
            <a href="#sources">48 个发现源</a>
            <a href="#top3">今日 Top {latestTop3.dossiers.length}</a>
            <span><i />人工审阅模式</span>
          </nav>
        </header>

        <div className="page-shell">
        <aside className="archive-panel">
          <p className="eyebrow">DAILY ARCHIVE</p>
          <h2>日报归档</h2>
          <nav aria-label="日报日期"><Link className="active" href="/"><span>{formatReportDate(latestTop3.generated_at)}</span><em>最新</em></Link></nav>
          <p className="archive-batch">论文热榜批次：{formatDate(digest.date)}</p>
          <div className="method-note">
            <span>筛选公式</span>
            <div className="formula">
              {rankingFormula ? <img src={rankingFormula.asset_url} alt={rankingFormula.alt_zh} /> : null}
            </div>
            <p>一手身份与技术增量决定准入，社区热度只负责排序；入选后才拉取 claim-specific 证据。</p>
          </div>
        </aside>

        <div className="content-column">
          <section className="hero" id="overview">
            <div>
              <p className="eyebrow">DAILY MECHANISM BRIEF · {formatReportDate(latestTop3.generated_at)}</p>
              <h1>今天真正值得理解的<br /><span>{latestTop3.metrics.dossiers_created} 个 AI 技术信号</span></h1>
              <p className="hero-copy">新模型、芯片与算力、底层机制、Harness / Eval 在同一个候选池竞争。社区热度负责发现，一手证据决定结论能写到哪里。</p>
              <div className="command-bar">
                <div><span className="command-dot" /><strong>48 个注册源完成发现</strong><small>→ 已收敛为 {latestTop3.metrics.dossiers_created} 条审阅候选</small></div>
                <a href="#top3">打开今日简报 <span>↗</span></a>
              </div>
              <Top3StatusStrip />
            </div>
            <MetricRail />
          </section>

          <section className="section-block top3-section" id="top3">
            <div className="section-title">
              <div><p className="eyebrow">TODAY&apos;S TOP SIGNALS</p><h2>今日 {latestTop3.dossiers.length} 条</h2></div>
              <p>最多三条，不足不补位。每条都保留<br />机制层、证据上限和反推边界。</p>
            </div>
            <div className="brief-list">
              {latestTop3.dossiers.length
                ? latestTop3.dossiers.map((dossier) => <Top3Card key={dossier.story_id} dossier={dossier} />)
                : <div className="brief-empty"><strong>今天没有达到门槛的代表事件</strong><p>系统不会用普通更新或单一热搜硬凑 Top 3。</p></div>}
            </div>
          </section>

          <MechanismRadar />

          <SourceArchitecture />

          <section className="section-block" id="papers">
            <div className="section-title">
              <div><p className="eyebrow">SECONDARY PAPER RADAR</p><h2>未入选论文补充</h2></div>
              <p>默认折叠，不与 Top 3 混排。<br />批次 {formatDate(digest.date)} · 热度不等于证据。</p>
            </div>
            <div className="paper-list">
              {papers.map((paper, index) => (
                <PaperCard key={paper.id} paper={paper} rank={index + 1} maxVotes={maxVotes} />
              ))}
            </div>
          </section>

          <section className="section-block" id="companies">
            <div className="section-title">
              <div><p className="eyebrow">LAB RADAR</p><h2>公司研究雷达</h2></div>
              <p>仅追踪官方 RSS、研究站点地图<br />和官方 GitHub 组织。</p>
            </div>
            <div className="company-grid">
              {companyOrder.map((company) => (
                <CompanyCard key={company} company={company} items={digest.companies[company] || []} />
              ))}
            </div>
          </section>

          {digest.warnings.length ? (
            <section className="warning-block"><strong>运行披露</strong>{digest.warnings.map((warning) => <p key={warning}>{warning}</p>)}</section>
          ) : null}

          <footer>
            <div><strong>前沿信号</strong><span>可验证、可追溯、不过度推断。</span></div>
            <p>数据源：Hugging Face、arXiv、OpenAI、Anthropic、Google DeepMind、DeepSeek。DeepSeek 仓库更新时间仅作为工程方向信号。</p>
          </footer>
        </div>
      </div>
      </div>
    </main>
  );
}
