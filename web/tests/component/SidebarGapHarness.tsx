// Minimal reproduction of the real `.app-shell > .sidebar + .main-area` structure
// (see app/(app)/layout.tsx and app/Sidebar.tsx) — deliberately not the real Sidebar
// component, which depends on next/navigation's usePathname and next/link, neither of
// which resolve under Playwright's component-test runner (Vite, not the Next.js app
// router). The bug under test lives entirely in the CSS selectors keyed off these class
// names, so reproducing the class structure is sufficient and avoids router mocking.
export function SidebarGapHarness({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="app-shell">
      <aside className={`sidebar${collapsed ? " sb-collapsed" : ""}`} />
      <div className="main-area">content</div>
    </div>
  );
}
