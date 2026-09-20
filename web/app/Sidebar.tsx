"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useT } from "@/lib/i18n/LanguageContext";
import type { Dictionary } from "@/lib/i18n/types";

// Same useSyncExternalStore approach as ThemeContext/UnitSystemContext: resolves the real
// collapsed state synchronously on the client instead of a mount-effect setState. The blocking
// script in layout.tsx still handles the very first paint (via the sb-collapsed-init class,
// before React/JS has even run) — this just keeps React's own `collapsed` state in sync with
// localStorage without a flash once hydration happens.
const collapsedListeners = new Set<() => void>();
function subscribeCollapsed(cb: () => void) {
  collapsedListeners.add(cb);
  return () => collapsedListeners.delete(cb);
}
function getCollapsedSnapshot(): boolean {
  try {
    const saved = localStorage.getItem("sb-collapsed");
    return saved !== null ? JSON.parse(saved) : false;
  } catch {
    return false;
  }
}
function getCollapsedServerSnapshot(): boolean {
  return false;
}

function navItems(t: Dictionary) {
  return [
    { href: "/",           label: t.sidebar.nav.today,      icon: "ti-home" },
    { href: "/plan",       label: t.sidebar.nav.plan,       icon: "ti-route" },
    { href: "/nutrition",  label: t.sidebar.nav.nutrition,  icon: "ti-salad" },
    { href: "/report",     label: t.sidebar.nav.progress,   icon: "ti-trending-up" },
    { href: "/chat",       label: t.sidebar.nav.chat,       icon: "ti-message-circle" },
  ];
}

function bottomItem(t: Dictionary) {
  return { href: "/profile", label: t.sidebar.nav.settings, icon: "ti-settings" };
}

function NavItems({ items, onNavigate }: { items: ReturnType<typeof navItems>; onNavigate?: () => void }) {
  const pathname = usePathname();
  function isActive(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }
  return (
    <>
      {items.map(({ href, label, icon }) => (
        <Link
          key={href}
          href={href}
          className={`sb-item${isActive(href) ? " sb-active" : ""}`}
          onClick={onNavigate}
          title={label}
        >
          <i className={`ti ${icon}`} aria-hidden="true" />
          <span className="sb-label">{label}</span>
        </Link>
      ))}
    </>
  );
}

function BottomTabBar({ items }: { items: ReturnType<typeof navItems> }) {
  const pathname = usePathname();
  function isActive(href: string) {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }
  return (
    <nav className="tab-bar" aria-label="Primary">
      {items.map(({ href, label, icon }) => (
        <Link
          key={href}
          href={href}
          className={`tab-bar-item${isActive(href) ? " tab-bar-active" : ""}`}
        >
          <i className={`ti ${icon}`} aria-hidden="true" />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const t = useT();
  const NAV = navItems(t);
  const BOTTOM_ITEM = bottomItem(t);
  const collapsed = useSyncExternalStore(subscribeCollapsed, getCollapsedSnapshot, getCollapsedServerSnapshot);

  // The blocking script in layout.tsx already snapshotted the collapse preference onto
  // <html class="sb-collapsed-init"> so the first paint renders correctly (see the CSS comment
  // in globals.css) — drop that snapshot class here, once this component's own `collapsed`
  // value is live, so later toggles get their normal transition instead of colliding with the
  // pre-hydration "no transition" override.
  useEffect(() => {
    document.documentElement.classList.remove("sb-collapsed-init");
  }, []);

  if (pathname.startsWith("/login")) return null;

  function toggleCollapsed() {
    const next = !collapsed;
    try { localStorage.setItem("sb-collapsed", JSON.stringify(next)); } catch {}
    collapsedListeners.forEach(cb => cb());
  }

  const onSettings = BOTTOM_ITEM.href === "/" ? pathname === "/" : pathname.startsWith(BOTTOM_ITEM.href);

  return (
    <>
      {/* ── Desktop sidebar ── */}
      <aside className={`sidebar${collapsed ? " sb-collapsed" : ""}`}>
        <div className="sb-brand">
          <div className="sb-brand-text">
            <span className="sb-brand-name">AMS</span>
            <span className="sb-brand-sub">{t.sidebar.brandSub}</span>
          </div>
          <button
            className="sb-collapse-btn"
            onClick={toggleCollapsed}
            title={collapsed ? t.sidebar.expand : t.sidebar.collapse}
          >
            <i className={`ti ${collapsed ? "ti-arrow-bar-right" : "ti-arrow-bar-left"}`} aria-hidden="true" />
          </button>
        </div>

        <nav className="sb-nav">
          <NavItems items={NAV} />
        </nav>

        <div className="sb-bottom">
          <NavItems items={[BOTTOM_ITEM]} />
        </div>
      </aside>

      {/* ── Mobile: slim top bar ── */}
      <header className="mobile-header">
        <span className="sb-brand-name" style={{ fontSize: 14 }}>AMS</span>
        <Link
          href={BOTTOM_ITEM.href}
          className={`mobile-header-icon-btn${onSettings ? " mobile-header-icon-active" : ""}`}
          aria-label={BOTTOM_ITEM.label}
          title={BOTTOM_ITEM.label}
        >
          <i className={`ti ${BOTTOM_ITEM.icon}`} aria-hidden="true" />
        </Link>
      </header>

      {/* ── Mobile: fixed bottom tab bar ── */}
      <BottomTabBar items={NAV} />
    </>
  );
}
