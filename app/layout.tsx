import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "前沿信号｜AI 研究日报";
  const description = "每天筛选 5 篇热门 AI 论文，并追踪四家前沿实验室的官方研究信号。";
  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: { icon: "/favicon.svg" },
    openGraph: {
      type: "website",
      url: origin,
      title,
      description,
      siteName: "前沿信号",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "前沿信号 AI 研究日报" }],
    },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
