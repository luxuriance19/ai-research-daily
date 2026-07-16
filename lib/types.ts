export type Paper = {
  id: string;
  title: string;
  title_zh?: string;
  summary: string;
  summary_zh?: string;
  why_zh?: string;
  problem_zh?: string;
  method_zh?: string;
  key_points_zh?: string[];
  limitations_zh?: string;
  pub_angle_zh?: string;
  source_signals?: string[];
  authors: string[];
  upvotes: number;
  published_at?: string;
  daily_at?: string;
  arxiv_published_at?: string;
  arxiv_url: string;
  hf_url: string;
  github_url?: string;
  categories: string[];
};

export type CompanyItem = {
  title: string;
  title_zh?: string;
  summary: string;
  summary_zh?: string;
  url: string;
  published_at: string;
  categories: string[];
  directions: string[];
};

export type FetchEvent = {
  source: string;
  status: "fresh" | "stale-cache" | "failed" | string;
  fetched_at: string;
  cache_age_seconds?: number | null;
  error?: string | null;
};

export type Digest = {
  date: string;
  generated_at: string;
  papers: Paper[];
  companies: Record<string, CompanyItem[]>;
  warnings: string[];
  fetch_events: FetchEvent[];
};
