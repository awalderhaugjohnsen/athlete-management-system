"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resolveMemorySuggestion, type MemorySuggestion } from "@/app/actions/memory-suggestions";
import { useT } from "@/lib/i18n/LanguageContext";

interface Props {
  suggestions: MemorySuggestion[];
  bare?: boolean;
}

// Presentational accept/dismiss list for athlete_memory_suggestions (migration 047) — facts the
// coach picked up from a check-in, reschedule, new-season, or chat note, pending the athlete's
// review. Nothing here is written to athlete_memory until the athlete clicks Save. Shared by
// PendingSuggestionsModal (the app-wide pop-up) and the /setup page's inline section — `bare`
// drops the card chrome for the latter, which already sits inside its own page layout.
export function PendingSuggestionsList({ suggestions, bare = false }: Props) {
  const t = useT().dashboard.memorySuggestions;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function resolve(id: string, accept: boolean) {
    setResolvingId(id);
    setError(null);
    startTransition(async () => {
      try {
        await resolveMemorySuggestion(id, accept);
        router.refresh();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : t.errorFailed);
      } finally {
        setResolvingId(null);
      }
    });
  }

  if (!suggestions.length) return null;

  const list = (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {suggestions.map((s) => (
        <div
          key={s.id}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}
        >
          <div>
            <div style={{ fontSize: 14, color: "var(--text)" }}>{s.value}</div>
            {s.source_note && (
              <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 2 }}>
                {t.fromNote} &ldquo;{s.source_note}&rdquo;
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn-secondary"
              disabled={isPending && resolvingId === s.id}
              onClick={() => resolve(s.id, false)}
            >
              {t.dismiss}
            </button>
            <button
              className="btn-primary"
              disabled={isPending && resolvingId === s.id}
              onClick={() => resolve(s.id, true)}
            >
              {isPending && resolvingId === s.id ? t.saving : t.save}
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  if (bare) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {error && <div className="alert alert-bad">{error}</div>}
        {list}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
      {error && <div className="alert alert-bad">{error}</div>}
      <div className="card card-accent" style={{ borderLeftWidth: 4 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.2px", textTransform: "uppercase", color: "var(--accent)", marginBottom: 12 }}>
          {t.title}
        </div>
        {list}
      </div>
    </div>
  );
}
