import { Sidebar } from "@/app/Sidebar";
import { ThemeProvider } from "@/app/ThemeContext";
import { UnitSystemProvider } from "@/app/(app)/nutrition/UnitSystemContext";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import { getAuthenticatedLanguage } from "@/lib/i18n/getServerLanguage";
import { getUserId } from "@/lib/supabase-server";
import { getPendingMemorySuggestions } from "@/app/actions/memory-suggestions";
import { PendingSuggestionsModal } from "@/app/(app)/PendingSuggestionsModal";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const uid = await getUserId();
  const [language, pendingMemorySuggestions] = await Promise.all([
    getAuthenticatedLanguage(uid),
    getPendingMemorySuggestions(),
  ]);
  return (
    <LanguageProvider initialLanguage={language}>
      <ThemeProvider>
        <div className="app-shell">
          <Sidebar />
          <div className="main-area">
            <UnitSystemProvider>{children}</UnitSystemProvider>
          </div>
        </div>
        <PendingSuggestionsModal suggestions={pendingMemorySuggestions} />
      </ThemeProvider>
    </LanguageProvider>
  );
}
