import { listDigests } from "@/lib/digests";
import type { CompanyItem, Digest, Paper } from "@/lib/types";

const companyOrder = ["OpenAI", "Anthropic", "Google DeepMind", "DeepSeek"];

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${value}T00:00:00+08:00`));
}

function paperTitle(paper: Paper) {
  return paper.title_zh || paper.title;
}

function paperSummary(paper: Paper) {
  return paper.summary_zh || paper.summary;
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
    <article className="paper-card">
      <div className="paper-rank" aria-label={`排名 ${rank}`}>{String(rank).padStart(2, "0")}</div>
      <div className="paper-body">
        <div className="paper-kicker">
          <span>{paper.categories.slice(0, 3).join(" · ") || "AI Research"}</span>
          <span>{paper.upvotes} HF 赞</span>
        </div>
        <h3>{paperTitle(paper)}</h3>
        {paper.title_zh && paper.title_zh !== paper.title ? <p className="original-title">{paper.title}</p> : null}
        <p className="paper-summary">{paperSummary(paper)}</p>
        <p className="paper-why"><strong>关注理由</strong>{paper.why_zh || "当日社区关注度较高，值得进一步阅读原文。"}</p>
        <div className="vote-track" aria-label={`${paper.upvotes} 个 Hugging Face 赞`}>
          <span style={{ width: `${voteWidth}%` }} />
        </div>
        <div className="paper-footer">
          <span>{paper.authors.slice(0, 3).join("、")}{paper.authors.length > 3 ? " 等" : ""}</span>
          <nav aria-label={`${paperTitle(paper)} 的来源`}>
            <a href={paper.hf_url} target="_blank" rel="noreferrer">HF</a>
            <a href={paper.arxiv_url} target="_blank" rel="noreferrer">arXiv</a>
            {paper.github_url ? <a href={paper.github_url} target="_blank" rel="noreferrer">Code</a> : null}
          </nav>
        </div>
      </div>
    </article>
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

function MetricRail({ digest }: { digest: Digest }) {
  const totalSignals = Object.values(digest.companies).reduce((count, items) => count + items.length, 0);
  const totalVotes = digest.papers.reduce((count, paper) => count + paper.upvotes, 0);
  return (
    <div className="metric-rail" aria-label="本期摘要指标">
      <div>
        <span>TOP</span>
        <strong>5</strong>
        <em>热门论文</em>
      </div>
      <div>
        <span>HF</span>
        <strong>{totalVotes}</strong>
        <em>社区赞数</em>
      </div>
      <div>
        <span>LAB</span>
        <strong>{totalSignals}</strong>
        <em>官方信号</em>
      </div>
    </div>
  );
}

function StatusStrip({ digest }: { digest: Digest }) {
  const fresh = digest.fetch_events.filter((event) => event.status === "fresh").length;
  const stale = digest.fetch_events.filter((event) => event.status === "stale-cache").length;
  return (
    <div className="status-strip" aria-label="数据源状态">
      <span className={stale ? "status-warning" : "status-live"} />
      <strong>{stale ? `${stale} 个来源使用缓存` : "全部来源已核验"}</strong>
      <span>{fresh}/{digest.fetch_events.length} 个来源为最新响应</span>
      <span className="status-separator" />
      <span>生成于 {new Date(digest.generated_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</span>
    </div>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const [{ date }, digests] = await Promise.all([searchParams, listDigests()]);
  const digest = digests.find((item) => item.date === date) ?? digests[0];
  const maxVotes = Math.max(...digest.papers.map((paper) => paper.upvotes), 1);

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="/" aria-label="前沿信号首页">
          <span className="brand-mark">F</span>
          <span><strong>前沿信号</strong><small>FRONTIER SIGNALS</small></span>
        </a>
        <div className="header-note">每日 AI 研究筛选与官方信号追踪</div>
      </header>

      <div className="page-shell">
        <aside className="archive-panel">
          <p className="eyebrow">DAILY ARCHIVE</p>
          <h2>日报归档</h2>
          <nav aria-label="日报日期">
            {digests.map((item, index) => (
              <a className={item.date === digest.date ? "active" : ""} href={`/?date=${item.date}`} key={item.date}>
                <span>{formatDate(item.date)}</span>
                {index === 0 ? <em>最新</em> : null}
              </a>
            ))}
          </nav>
          <div className="method-note">
            <span>筛选公式</span>
            <div className="formula" aria-label="论文分数等于 Hugging Face 赞数">
              S<sub>paper</sub> = U<sub>HF</sub>
            </div>
            <p>同一完整日榜内按 Hugging Face 社区赞数排序，arXiv 仅用于元数据交叉核验。</p>
          </div>
        </aside>

        <div className="content-column">
          <section className="hero">
            <div>
              <p className="eyebrow">AI RESEARCH DAILY · {digest.date}</p>
              <h1>每日 AI 研究情报台</h1>
              <p className="hero-copy">从 Hugging Face 热度、arXiv 元数据和前沿实验室官方渠道中，提炼当天最值得进入公众号排版的研究信号。</p>
              <StatusStrip digest={digest} />
            </div>
            <MetricRail digest={digest} />
          </section>

          <section className="section-block" id="papers">
            <div className="section-title">
              <div><p className="eyebrow">TODAY&apos;S TOP FIVE</p><h2>热门论文</h2></div>
              <p>批次日期 {formatDate(digest.date)}<br />热度来自社区投票，不代表引用量。</p>
            </div>
            <div className="paper-list">
              {digest.papers.map((paper, index) => (
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
    </main>
  );
}
