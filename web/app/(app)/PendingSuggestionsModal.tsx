"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/LanguageContext";
import { PendingSuggestionsList } from "./PendingSuggestionsList";
import type { MemorySuggestion } from "@/app/actions/memory-suggestions";

interface Props {
  suggestions: MemorySuggestion[];
}

// App-wide pop-up for athlete_memory_suggestions (migration 047) — mounted once in the (app)
// layout so a pending suggestion from check-in, reschedule, new-season, or chat is impossible to
// miss regardless of which page the athlete lands on, rather than relying on a quiet dashboard
// card. Dismissing the pop-up only hides it for this browser session (local state, not
// persisted) — it resolves nothing; each item's own Save/Dismiss button (in
// PendingSuggestionsList) is what actually writes to Supabase. The same list is also shown
// inline, non-modal, on /setup — see SetupPage.
export function PendingSuggestionsModal({ suggestions }: Props) {
  const t = useT().dashboard.memorySuggestions;
  const [closed, setClosed] = useState(false);

  if (!suggestions.length || closed) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,.65)",
        backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
      }}
      onClick={() => setClosed(true)}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--surface)", border: "1px solid rgba(var(--overlay-rgb),.12)",
          borderRadius: 16, padding: "28px 32px", maxWidth: 460, width: "90%",
          display: "flex", flexDirection: "column", gap: 16,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--accent)" }}>
          {t.title}
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.65, color: "var(--muted)", margin: 0 }}>
          {t.modalIntro}
        </p>

        <PendingSuggestionsList suggestions={suggestions} bare />

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn-secondary" onClick={() => setClosed(true)}>{t.closeForNow}</button>
        </div>
      </div>
    </div>
  );
}
