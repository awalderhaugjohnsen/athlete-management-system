// Playwright component tests aliase real Next.js Server Action modules to stubs like this one
// (see playwright-ct.config.ts's ctViteConfig.resolve.alias) — the real module pulls in
// server-only code (Supabase server client, next/headers) that Vite's CT bundler can't run in
// a browser context, and hangs `mount()` indefinitely instead of failing cleanly. Nothing under
// test in tests/component/ depends on these actions' side effects (persisting to Supabase), so
// no-ops are sufficient.
export async function saveMaxHR(): Promise<{ error?: string }> {
  return {};
}

export async function saveLanguage(): Promise<{ error?: string }> {
  return {};
}
