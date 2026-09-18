"use client";

// Centered overlay showing the full nutrient breakdown for one logged food entry (standalone
// diary row or an ingredient row inside an expanded meal). Reuses the same fixed-overlay idiom
// as `ExpandedChart` (web/app/(app)/report/ProgressTabs.tsx ~991) and the food-search modal in
// this file's sibling NutritionClient.tsx (~1827) rather than a new drawer/panel pattern.
//
// See .claude/backlog/food-nutrient-detail-modal.md for the point this implements, and
// tests/component/food-nutrient-detail-modal.spec.tsx for the contract this must satisfy.

import { useEffect } from "react";
import { useT } from "@/lib/i18n/LanguageContext";

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

type Row = [keyof FoodNutrientEntry, string, string, number | null | undefined];

function NutrientRow({ field, label, unit, value }: { field: keyof FoodNutrientEntry; label: string; unit: string; value: number | null | undefined }) {
  const display = value === null || value === undefined ? "—" : `${value}${unit}`;
  return (
    <div
      data-testid={`nutrient-${String(field)}`}
      style={{
        display: "flex", justifyContent: "space-between", gap: 10,
        fontSize: 12, padding: "5px 0",
        borderBottom: "1px solid rgba(var(--overlay-rgb),.05)",
      }}
    >
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span style={{ fontWeight: 600, color: "var(--text)", flexShrink: 0 }}>{display}</span>
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--dim)", marginBottom: 6 }}>
        {title}
      </div>
      {rows.map(([field, label, unit, value]) => (
        <NutrientRow key={field} field={field} label={label} unit={unit} value={value} />
      ))}
    </div>
  );
}

export function FoodNutrientModal({ entry, onClose }: { entry: FoodNutrientEntry; onClose: () => void }) {
  const nt = useT().nutrition;
  const mi = nt.micronutrients.items;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const macroRows: Row[] = [
    ["calories", nt.macroLabels.calories, "", entry.calories],
    ["protein_g", nt.macroLabels.protein, "g", entry.protein_g],
    ["carbs_g", nt.macroLabels.carbs, "g", entry.carbs_g],
    ["fat_g", nt.macroLabels.fat, "g", entry.fat_g],
    ["fiber_g", nt.macroLabels.fiber, "g", entry.fiber_g],
    ["sugar_g", nt.macroLabels.sugar, "g", entry.sugar_g],
  ];

  const fatRows: Row[] = [
    ["saturated_fat_g", mi.saturated, "g", entry.saturated_fat_g],
    ["monounsaturated_fat_g", mi.monounsaturated, "g", entry.monounsaturated_fat_g],
    ["polyunsaturated_fat_g", mi.polyunsaturated, "g", entry.polyunsaturated_fat_g],
    ["omega3_g", mi.omega3, "g", entry.omega3_g],
    ["cholesterol_mg", mi.cholesterol, "mg", entry.cholesterol_mg],
  ];

  const vitaminRows: Row[] = [
    ["vitamin_a_mcg", mi.vitaminA, "µg", entry.vitamin_a_mcg],
    ["vitamin_c_mg", mi.vitaminC, "mg", entry.vitamin_c_mg],
    ["vitamin_d_mcg", mi.vitaminD, "µg", entry.vitamin_d_mcg],
    ["vitamin_e_mg", mi.vitaminE, "mg", entry.vitamin_e_mg],
    ["vitamin_k_mcg", mi.vitaminK, "µg", entry.vitamin_k_mcg],
    ["thiamin_mg", mi.thiamin, "mg", entry.thiamin_mg],
    ["riboflavin_mg", mi.riboflavin, "mg", entry.riboflavin_mg],
    ["niacin_mg", mi.niacin, "mg", entry.niacin_mg],
    ["vitamin_b6_mg", mi.vitaminB6, "mg", entry.vitamin_b6_mg],
    ["folate_mcg", mi.folate, "µg", entry.folate_mcg],
    ["vitamin_b12_mcg", mi.vitaminB12, "µg", entry.vitamin_b12_mcg],
  ];

  const mineralRows: Row[] = [
    ["sodium_mg", mi.sodium, "mg", entry.sodium_mg],
    ["calcium_mg", mi.calcium, "mg", entry.calcium_mg],
    ["iron_mg", mi.iron, "mg", entry.iron_mg],
    ["magnesium_mg", mi.magnesium, "mg", entry.magnesium_mg],
    ["phosphorus_mg", mi.phosphorus, "mg", entry.phosphorus_mg],
    ["potassium_mg", mi.potassium, "mg", entry.potassium_mg],
    ["zinc_mg", mi.zinc, "mg", entry.zinc_mg],
    ["copper_mg", mi.copper, "mg", entry.copper_mg],
  ];

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(0,0,0,.70)",
        backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "24px 16px",
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
        width: "100%", maxWidth: 460, maxHeight: "88vh", overflow: "auto", padding: 20,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{entry.food_name}</div>
          <button
            onClick={onClose}
            aria-label={nt.actions.close}
            style={{
              background: "none", border: "1px solid var(--border)", borderRadius: 7,
              cursor: "pointer", color: "var(--muted)", padding: "5px 10px", fontSize: 13,
              flexShrink: 0,
            }}
          >✕</button>
        </div>

        <Section title={nt.macrosCard.title} rows={macroRows} />
        <Section title={nt.micronutrients.groups.fats} rows={fatRows} />
        <Section title={nt.micronutrients.groups.vitamins} rows={vitaminRows} />
        <Section title={nt.micronutrients.groups.minerals} rows={mineralRows} />
      </div>
    </div>
  );
}
