"use client";

// Stub only — see .claude/backlog/food-nutrient-detail-modal.md. This exists so the spec tests
// in tests/component/food-nutrient-detail-modal.spec.tsx (and this project's tsc --noEmit gate)
// can resolve the module and its type; it deliberately implements none of the acceptance
// criteria yet, so those tests fail on missing behavior rather than a missing import.

export interface FoodNutrientEntry {
  food_name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number | null;
  sugar_g?: number | null;
  sodium_mg?: number | null;
  saturated_fat_g?: number | null;
  monounsaturated_fat_g?: number | null;
  polyunsaturated_fat_g?: number | null;
  omega3_g?: number | null;
  cholesterol_mg?: number | null;
  vitamin_a_mcg?: number | null;
  vitamin_c_mg?: number | null;
  vitamin_d_mcg?: number | null;
  vitamin_e_mg?: number | null;
  vitamin_k_mcg?: number | null;
  thiamin_mg?: number | null;
  riboflavin_mg?: number | null;
  niacin_mg?: number | null;
  vitamin_b6_mg?: number | null;
  folate_mcg?: number | null;
  vitamin_b12_mcg?: number | null;
  calcium_mg?: number | null;
  iron_mg?: number | null;
  magnesium_mg?: number | null;
  phosphorus_mg?: number | null;
  potassium_mg?: number | null;
  zinc_mg?: number | null;
  copper_mg?: number | null;
}

export function FoodNutrientModal(_props: { entry: FoodNutrientEntry; onClose: () => void }) {
  return null;
}
