import { test, expect } from "@playwright/experimental-ct-react";
import { SidebarGapHarness } from "./SidebarGapHarness";

// Spec for .claude/backlog/sidebar-collapsed-mobile-gap.md

test.describe("collapsed sidebar + mobile viewport gap", () => {
  test("live resize to mobile after desktop-collapsed leaves no left margin", async ({ mount, page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const component = await mount(<SidebarGapHarness collapsed={true} />);
    const mainArea = component.locator(".main-area");
    await expect(mainArea).toHaveCSS("margin-left", "60px");

    await page.setViewportSize({ width: 375, height: 800 });
    await expect(mainArea).toHaveCSS("margin-left", "0px");
  });

  test("fresh load at mobile width with sb-collapsed-init snapshot leaves no left margin", async ({ mount, page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.evaluate(() => document.documentElement.classList.add("sb-collapsed-init"));
    const component = await mount(<SidebarGapHarness collapsed={true} />);
    await expect(component.locator(".main-area")).toHaveCSS("margin-left", "0px");
  });

  test("desktop expanded above 768px keeps the normal margin (no regression)", async ({ mount, page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const component = await mount(<SidebarGapHarness collapsed={false} />);
    await expect(component.locator(".main-area")).toHaveCSS("margin-left", "220px");
  });

  test("desktop collapsed above 768px keeps the 60px margin (no regression)", async ({ mount, page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const component = await mount(<SidebarGapHarness collapsed={true} />);
    await expect(component.locator(".main-area")).toHaveCSS("margin-left", "60px");
  });
});
