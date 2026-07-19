import editorialData from "../data/editorial-latest.json";

type Story = {
  id: string;
  kind: string;
  title: string;
  original_title?: string;
  published_at?: string | null;
  summary: string;
  angle_label?: string;
  why_it_matters: string;
  key_points: string[];
  caveat_label?: string;
  caveat: string;
  sources: Array<{ label: string; url: string }>;
};

type EditorialSection = {
  id: string;
  number: string;
  title: string;
  description: string;
  status_note?: string;
  empty_message: string;
  stories: Story[];
};

const editorial = editorialData as {
  date: string;
  title: string;
  deck: string;
  lead: string;
  sections: EditorialSection[];
  reading_notes: { paper_batch: string; omitted_evaluation_patch: boolean; note: string };
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${value}T00:00:00+08:00`));
}

function formatStoryDate(value?: string | null) {
  if (!value) return "日期待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function StoryArticle({ story, featured }: { story: Story; featured: boolean }) {
  return (
    <article className={featured ? "news-story news-story-featured" : "news-story"}>
      <div className="story-meta">
        <time>{formatStoryDate(story.published_at)}</time>
        <span>{story.kind === "model-release" ? "公司发布" : story.kind === "harness-release" ? "工程更新" : "研究论文"}</span>
      </div>
      <h3>{story.title}</h3>
      {story.original_title && story.original_title !== story.title ? <p className="original-title">{story.original_title}</p> : null}
      <p className="story-summary">{story.summary}</p>
      <div className="story-why"><strong>{story.angle_label || "先看重点"}</strong><p>{story.why_it_matters}</p></div>
      <ul className="story-points">
        {story.key_points.map((point) => <li key={point}>{point}</li>)}
      </ul>
      <div className="story-caveat"><strong>{story.caveat_label || "还没确认"}</strong><p>{story.caveat}</p></div>
      <nav className="story-sources" aria-label={`${story.title} 的一手来源`}>
        {story.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label} ↗</a>)}
      </nav>
    </article>
  );
}

function EditorialSectionBlock({ section }: { section: EditorialSection }) {
  return (
    <section className={`editorial-section editorial-section-${section.id}`} id={section.id}>
      <header className="section-heading">
        <span>{section.number}</span>
        <div><h2>{section.title}</h2><p>{section.description}</p></div>
      </header>
      {section.status_note ? <p className="section-status">{section.status_note}</p> : null}
      {section.stories.length ? (
        <div className="story-list">
          {section.stories.map((story, index) => <StoryArticle key={story.id} story={story} featured={index === 0} />)}
        </div>
      ) : (
        <div className="honest-empty"><span>今天无大事</span><p>{section.empty_message}</p></div>
      )}
    </section>
  );
}

export default function Home() {
  return (
    <main className="daily-page">
      <header className="daily-header">
        <a className="wordmark" href="#top" aria-label="AI 前沿日报顶部">Frontier Brief</a>
        <nav aria-label="四大栏目">
          {editorial.sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
        </nav>
      </header>

      <article className="daily-article" id="top">
        <section className="editorial-hero">
          <p className="edition-date">{formatDate(editorial.date)} · 第 {editorial.date.replaceAll("-", "")} 期</p>
          <h1>{editorial.title}</h1>
          <p className="hero-deck">{editorial.deck}</p>
          <div className="today-judgment"><span>编辑手记</span><p>{editorial.lead}</p></div>
          <div className="section-index" aria-label="本期栏目目录">
            {editorial.sections.map((section) => (
              <a key={section.id} href={`#${section.id}`}>
                <span>{section.number}</span><strong>{section.title}</strong><em>{section.stories.length ? `${section.stories.length} 条` : "留空"}</em>
              </a>
            ))}
          </div>
        </section>

        {editorial.sections.map((section) => <EditorialSectionBlock key={section.id} section={section} />)}

        <footer className="daily-footer">
          <details>
            <summary>编辑说明与来源边界</summary>
            <p>论文热度批次为 {editorial.reading_notes.paper_batch}。社区热度只帮助发现，不替代官方发布、论文、代码或版本记录。</p>
            {editorial.reading_notes.omitted_evaluation_patch ? <p>{editorial.reading_notes.note}</p> : null}
          </details>
          <p>资料由程序汇集，正文按证据整理。没到新闻门槛的内容不占版面。</p>
        </footer>
      </article>
    </main>
  );
}
