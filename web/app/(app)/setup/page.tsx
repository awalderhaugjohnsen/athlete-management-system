import { getAthleteProfile } from "@/app/actions/athlete-profile";
import { getGarminConnectionStatus } from "@/app/actions/garmin-credentials";
import { getPendingMemorySuggestions } from "@/app/actions/memory-suggestions";
import { SetupWizard } from "./SetupWizard";
import { PendingSuggestionsList } from "@/app/(app)/PendingSuggestionsList";
import Link from "next/link";
import { getUserId } from "@/lib/supabase-server";
import { getAuthenticatedLanguage } from "@/lib/i18n/getServerLanguage";
import { dictionaries } from "@/lib/i18n/dictionaries";

export async function generateMetadata() {
  const uid = await getUserId();
  const language = await getAuthenticatedLanguage(uid);
  return { title: dictionaries[language].setup.pageTitle };
}

export default async function SetupPage() {
  const uid = await getUserId();
  const language = await getAuthenticatedLanguage(uid);
  const t = dictionaries[language].setup;
  const memoryT = dictionaries[language].dashboard.memorySuggestions;

  const [profile, garmin, pendingMemorySuggestions] = await Promise.all([
    getAthleteProfile(),
    getGarminConnectionStatus(),
    getPendingMemorySuggestions(),
  ]);

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "48px 24px 80px" }}>
      <Link href="/profile" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: 32 }}>
        <i className="ti ti-arrow-left" style={{ fontSize: 14 }} />{t.page.backToProfile}
      </Link>
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0, marginBottom: 6 }}>{t.page.heading}</h1>
        <p style={{ fontSize: 14, color: "var(--muted)", margin: 0 }}>
          {t.page.description}
        </p>
      </div>
      {pendingMemorySuggestions.length > 0 && (
        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.2px", textTransform: "uppercase", color: "var(--accent)", marginBottom: 12 }}>
            {memoryT.setupSectionTitle}
          </div>
          <PendingSuggestionsList suggestions={pendingMemorySuggestions} bare />
        </div>
      )}
      <SetupWizard initial={profile} garminEmail={garmin.email} />
    </main>
  );
}
