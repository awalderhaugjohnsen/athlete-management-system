import { beforeMount } from "@playwright/experimental-ct-react/hooks";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import { ThemeProvider } from "@/app/ThemeContext";
import { UnitSystemProvider } from "@/app/(app)/nutrition/UnitSystemContext";
import "@/app/globals.css";

beforeMount(async ({ App }) => {
  return (
    <LanguageProvider initialLanguage="en">
      <ThemeProvider>
        <UnitSystemProvider>
          <App />
        </UnitSystemProvider>
      </ThemeProvider>
    </LanguageProvider>
  );
});
