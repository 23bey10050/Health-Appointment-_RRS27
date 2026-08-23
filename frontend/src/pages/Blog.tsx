import { Link, useParams, Navigate } from "react-router-dom";
import { ArrowLeft, CalendarDays, Clock, PenLine } from "lucide-react";
import { PublicShell } from "@/components/layout/PublicShell";
import { ARTICLES } from "@/content/site";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

export function BlogIndex() {
  return (
    <PublicShell>
      <div className="mx-auto max-w-5xl px-4 py-16">
        <div className="animate-slide-up">
          <div className="flex items-center gap-3">
            <PenLine className="h-7 w-7 text-brand-600" />
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Insights</h1>
          </div>
          <p className="mt-3 max-w-2xl text-slate-600">
            How the platform is built and why, from the people building and using it.
          </p>
        </div>

        <div className="mt-10 space-y-6">
          {ARTICLES.map((article) => (
            <Link key={article.slug} to={`/blog/${article.slug}`} className="glass-card group block p-7">
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">
                  {article.tag}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {formatDate(article.date)}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  {article.readingMinutes} min read
                </span>
              </div>
              <h2 className="mt-3 text-xl font-bold leading-snug text-slate-900 group-hover:text-brand-700">
                {article.title}
              </h2>
              <p className="mt-2 leading-relaxed text-slate-600">{article.excerpt}</p>
              <p className="mt-4 text-sm text-slate-500">
                {article.author}, {article.role}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </PublicShell>
  );
}

export function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const article = ARTICLES.find((a) => a.slug === slug);

  // An unknown slug is a bad URL, not an error state worth its own page.
  if (!article) return <Navigate to="/blog" replace />;

  return (
    <PublicShell>
      <article className="mx-auto max-w-3xl px-4 py-16">
        <Link to="/blog" className="inline-flex items-center gap-2 text-sm font-medium text-brand-700 hover:underline">
          <ArrowLeft className="h-4 w-4" />
          All articles
        </Link>

        <div className="mt-6 animate-slide-up">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
            {article.tag}
          </span>
          <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
            {article.title}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
            <span className="font-medium text-slate-700">{article.author}</span>
            <span>{article.role}</span>
            <span>{formatDate(article.date)}</span>
            <span>{article.readingMinutes} min read</span>
          </div>
        </div>

        <div className="glass-card mt-10 p-8">
          {article.body.map((block, i) =>
            block.startsWith("## ") ? (
              <h2 key={i} className="mt-8 text-xl font-bold text-slate-900 first:mt-0">
                {block.slice(3)}
              </h2>
            ) : (
              <p key={i} className="mt-4 leading-relaxed text-slate-700 first:mt-0">
                {block}
              </p>
            )
          )}
        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            to="/register"
            className="rounded-full bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Create a patient account
          </Link>
          <Link
            to="/faq"
            className="rounded-full border border-slate-300 bg-white/70 px-6 py-3 text-sm font-semibold text-slate-700 hover:bg-white"
          >
            Read the FAQ
          </Link>
        </div>
      </article>
    </PublicShell>
  );
}
