import { test, expect } from "@playwright/experimental-ct-react";
import { FoodNutrientModal, type FoodNutrientEntry } from "@/app/(app)/nutrition/FoodNutrientModal";

// Spec for .claude/backlog/food-nutrient-detail-modal.md
//
// FoodNutrientModal doesn't exist yet — these tests define its contract (props, rendered
// nutrient rows keyed by `data-testid="nutrient-<field>"`, close behavior) and are expected to
// fail on a missing-module error until it's implemented. Wiring a click handler onto each diary
// row in NutritionClient.tsx to open this modal is a small, low-risk addition covered by manual
// browser verification at implementation time rather than an automated test here — see the Notes
// section of the backlog file for why mounting the full NutritionClient (camera capture, meal
// builder, several more Server Actions) wasn't a good fit for this test harness.

const FULL_ENTRY: FoodNutrientEntry = {
  food_name: "Grilled chicken breast",
  calories: 284,
  protein_g: 53.4,
  carbs_g: 0,
  fat_g: 6.2,
  fiber_g: 0,
  sugar_g: 0,
  sodium_mg: 128,
  saturated_fat_g: 1.7,
  monounsaturated_fat_g: 2.1,
  polyunsaturated_fat_g: 1.3,
  omega3_g: 0.1,
  cholesterol_mg: 147,
  vitamin_a_mcg: 12,
  vitamin_c_mg: 0,
  vitamin_d_mcg: 0.1,
  vitamin_e_mg: 0.3,
  vitamin_k_mcg: 0.3,
  thiamin_mg: 0.1,
  riboflavin_mg: 0.2,
  niacin_mg: 21.8,
  vitamin_b6_mg: 1.1,
  folate_mcg: 6,
  vitamin_b12_mcg: 0.6,
  calcium_mg: 18,
  iron_mg: 1.1,
  magnesium_mg: 36,
  phosphorus_mg: 259,
  potassium_mg: 484,
  zinc_mg: 1.3,
  copper_mg: 0.1,
};

// Only the fields DiaryEntry always has, matching an entry that never had a full USDA nutrient
// match — the rest are legitimately absent, not zero.
const SPARSE_ENTRY: FoodNutrientEntry = {
  food_name: "Homemade soup",
  calories: 210,
  protein_g: 8,
  carbs_g: 22,
  fat_g: 9,
};

test.describe("FoodNutrientModal", () => {
  test("renders the full nutrient profile for a fully-populated entry", async ({ mount }) => {
    const component = await mount(<FoodNutrientModal entry={FULL_ENTRY} onClose={() => {}} />);

    await expect(component.getByText("Grilled chicken breast")).toBeVisible();

    const expected: [keyof FoodNutrientEntry, string][] = [
      ["calories", "284"],
      ["protein_g", "53.4"],
      ["carbs_g", "0"],
      ["fat_g", "6.2"],
      ["fiber_g", "0"],
      ["sugar_g", "0"],
      ["sodium_mg", "128"],
      ["saturated_fat_g", "1.7"],
      ["monounsaturated_fat_g", "2.1"],
      ["polyunsaturated_fat_g", "1.3"],
      ["omega3_g", "0.1"],
      ["cholesterol_mg", "147"],
      ["vitamin_a_mcg", "12"],
      ["vitamin_c_mg", "0"],
      ["vitamin_d_mcg", "0.1"],
      ["vitamin_e_mg", "0.3"],
      ["vitamin_k_mcg", "0.3"],
      ["thiamin_mg", "0.1"],
      ["riboflavin_mg", "0.2"],
      ["niacin_mg", "21.8"],
      ["vitamin_b6_mg", "1.1"],
      ["folate_mcg", "6"],
      ["vitamin_b12_mcg", "0.6"],
      ["calcium_mg", "18"],
      ["iron_mg", "1.1"],
      ["magnesium_mg", "36"],
      ["phosphorus_mg", "259"],
      ["potassium_mg", "484"],
      ["zinc_mg", "1.3"],
      ["copper_mg", "0.1"],
    ];
    for (const [field, value] of expected) {
      await expect(component.locator(`[data-testid="nutrient-${String(field)}"]`)).toContainText(value);
    }
  });

  test("shows a placeholder, not 0 or a crash, for nutrient fields missing on the entry", async ({ mount }) => {
    const component = await mount(<FoodNutrientModal entry={SPARSE_ENTRY} onClose={() => {}} />);

    await expect(component.getByText("Homemade soup")).toBeVisible();
    // Always-present fields still render normally.
    await expect(component.locator('[data-testid="nutrient-calories"]')).toContainText("210");
    // Missing fields render a placeholder, not "0" (which would misreport zero content) and
    // don't throw — the mount succeeding at all is part of what this test checks.
    await expect(component.locator('[data-testid="nutrient-vitamin_d_mcg"]')).toContainText("—");
    await expect(component.locator('[data-testid="nutrient-sodium_mg"]')).toContainText("—");
    await expect(component.locator('[data-testid="nutrient-calcium_mg"]')).toContainText("—");
  });

  test("closes on Escape", async ({ mount }) => {
    const events: string[] = [];
    const component = await mount(
      <FoodNutrientModal entry={FULL_ENTRY} onClose={() => events.push("closed")} />
    );
    await component.press("Escape");
    expect(events).toEqual(["closed"]);
  });

  test("closes via an explicit close control", async ({ mount }) => {
    const events: string[] = [];
    const component = await mount(
      <FoodNutrientModal entry={FULL_ENTRY} onClose={() => events.push("closed")} />
    );
    await component.getByRole("button", { name: /close/i }).click();
    expect(events).toEqual(["closed"]);
  });
});
