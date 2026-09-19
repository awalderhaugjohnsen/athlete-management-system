"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { BarcodeScanner } from "./BarcodeScanner";
import { PhotoFoodCapture } from "./PhotoFoodCapture";
import { WeekStrip } from "./WeekStrip";
import { WeightCard } from "./WeightCard";
import { DayEnergyBalance } from "./DayEnergyBalance";
import { CustomFoodModal, type CustomFood } from "./CustomFoodModal";
import { FoodNutrientModal, type FoodNutrientEntry } from "./FoodNutrientModal";
import { MealBuilderModal, type MealTemplate, type MealDraft } from "./MealBuilderModal";
import { MealManagerModal } from "./MealManagerModal";
import { WeeklyMealPlanModal } from "./WeeklyMealPlanModal";
import { QuantityInput } from "./QuantityInput";
import type { Portion } from "./useQuantityInput";
import { useFormatQty } from "./UnitSystemContext";
import { todayISO, daysSince } from "@/lib/dates";
import { useT, useLanguage } from "@/lib/i18n/LanguageContext";
import { localeTag } from "@/lib/i18n/language";
import type { Dictionary } from "@/lib/i18n/types";

// ── Types ────────────────────────────────────────────────────────────────────

type DiaryEntry = {
  id: string;
  date: string;
  meal_type: string;
  food_name: string;
  brand?: string | null;
  quantity_g: number;
  serving_qty?: number | null;
  serving_label?: string | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number;
  sugar_g?: number;
  sodium_mg?: number;
  vitamin_a_mcg?: number;
  vitamin_c_mg?: number;
  vitamin_d_mcg?: number;
  vitamin_e_mg?: number;
  vitamin_k_mcg?: number;
  thiamin_mg?: number;
  riboflavin_mg?: number;
  niacin_mg?: number;
  vitamin_b6_mg?: number;
  folate_mcg?: number;
  vitamin_b12_mcg?: number;
  calcium_mg?: number;
  iron_mg?: number;
  magnesium_mg?: number;
  phosphorus_mg?: number;
  potassium_mg?: number;
  zinc_mg?: number;
  copper_mg?: number;
  saturated_fat_g?: number;
  monounsaturated_fat_g?: number;
  polyunsaturated_fat_g?: number;
  omega3_g?: number;
  cholesterol_mg?: number;
  meal_items?: Array<{
    food_name: string;
    quantity_g: number;
    serving_qty?: number | null;
    serving_label?: string | null;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number;
  }> | null;
};

type RecentFood = {
  food_name: string;
  quantity_g: number;
  serving_qty?: number | null;
  serving_label?: string | null;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number;
  usda_fdc_id?: number | null;
  date: string;
  use_count: number;
};

type NutritionTarget = {
  day_type: string;
  calories: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  fiber_g?: number;
  water_ml?: number;
  notes?: string;
  source?: string;
};

type USDAFood = {
  fdcId: number;
  description: string;
  brand?: string | null;
  category?: string | null;
  servingSize?: number | null;
  servingUnit?: string;
  servingLabel?: string | null;
  portions?: Portion[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
  vitamin_a_mcg: number;
  vitamin_c_mg: number;
  vitamin_d_mcg: number;
  vitamin_e_mg: number;
  vitamin_k_mcg: number;
  thiamin_mg: number;
  riboflavin_mg: number;
  niacin_mg: number;
  vitamin_b6_mg: number;
  folate_mcg: number;
  vitamin_b12_mcg: number;
  calcium_mg: number;
  iron_mg: number;
  magnesium_mg: number;
  phosphorus_mg: number;
  potassium_mg: number;
  zinc_mg: number;
  copper_mg: number;
  saturated_fat_g: number;
  monounsaturated_fat_g: number;
  polyunsaturated_fat_g: number;
  omega3_g: number;
  cholesterol_mg: number;
  isCustom?: boolean;
  customFoodId?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

function getMeals(t: Dictionary["nutrition"]) {
  return [
    { key: "breakfast",    label: t.meals.breakfast,    emoji: "🌅" },
    { key: "pre_workout",  label: t.meals.preWorkout,   emoji: "⚡" },
    { key: "lunch",        label: t.meals.lunch,        emoji: "☀️" },
    { key: "post_workout", label: t.meals.postWorkout,  emoji: "💪" },
    { key: "dinner",       label: t.meals.dinner,       emoji: "🌙" },
    { key: "snacks",       label: t.meals.snacks,       emoji: "🍎" },
  ];
}

const WATER_LOG_MAX_ML = 1000; // one "bottle" — the fill gauge's full-scale range
const WATER_LOG_STEP_ML = 25;

function getDayTypeLabels(t: Dictionary["nutrition"]): Record<string, { label: string; color: string; bg: string }> {
  return {
    hard:    { label: t.dayTypes.hard,    color: "var(--red)",    bg: "rgba(var(--red-rgb),.12)" },
    easy:    { label: t.dayTypes.easy,    color: "var(--blue)",   bg: "rgba(111,182,255,.12)" },
    rest:    { label: t.dayTypes.rest,    color: "var(--green)",  bg: "rgba(var(--green-rgb),.12)" },
    race:    { label: t.dayTypes.race,    color: "var(--accent)", bg: "rgba(124,92,255,.12)" },
    default: { label: t.dayTypes.default, color: "var(--muted)",  bg: "rgba(var(--overlay-rgb),.05)" },
  };
}

// Standard adult RDAs (approximate)
const RDA: Record<string, number> = {
  vitamin_a_mcg:   900,
  vitamin_c_mg:    90,
  vitamin_d_mcg:   20,
  vitamin_e_mg:    15,
  vitamin_k_mcg:   120,
  thiamin_mg:      1.2,
  riboflavin_mg:   1.3,
  niacin_mg:       16,
  vitamin_b6_mg:   1.7,
  folate_mcg:      400,
  vitamin_b12_mcg: 2.4,
  calcium_mg:      1000,
  iron_mg:         8,
  magnesium_mg:    420,
  phosphorus_mg:   700,
  potassium_mg:    4700,
  zinc_mg:         11,
  copper_mg:       0.9,
  sodium_mg:       2300,    // max
  saturated_fat_g: 20,      // max
  omega3_g:        1.6,
  cholesterol_mg:  300,     // max
  fiber_g:         38,
};

function getMicroGroups(t: Dictionary["nutrition"]) {
  const mi = t.micronutrients.items;
  return [
    {
      label: t.micronutrients.groups.vitamins,
      items: [
        { key: "vitamin_c_mg",    label: mi.vitaminC,   unit: "mg" },
        { key: "vitamin_d_mcg",   label: mi.vitaminD,   unit: "µg" },
        { key: "vitamin_a_mcg",   label: mi.vitaminA,   unit: "µg" },
        { key: "vitamin_e_mg",    label: mi.vitaminE,   unit: "mg" },
        { key: "vitamin_k_mcg",   label: mi.vitaminK,   unit: "µg" },
        { key: "thiamin_mg",      label: mi.thiamin,    unit: "mg" },
        { key: "riboflavin_mg",   label: mi.riboflavin, unit: "mg" },
        { key: "niacin_mg",       label: mi.niacin,     unit: "mg" },
        { key: "vitamin_b6_mg",   label: mi.vitaminB6,  unit: "mg" },
        { key: "folate_mcg",      label: mi.folate,     unit: "µg" },
        { key: "vitamin_b12_mcg", label: mi.vitaminB12, unit: "µg" },
      ],
    },
    {
      label: t.micronutrients.groups.minerals,
      items: [
        { key: "calcium_mg",    label: mi.calcium,    unit: "mg" },
        { key: "iron_mg",       label: mi.iron,       unit: "mg" },
        { key: "magnesium_mg",  label: mi.magnesium,  unit: "mg" },
        { key: "potassium_mg",  label: mi.potassium,  unit: "mg" },
        { key: "phosphorus_mg", label: mi.phosphorus, unit: "mg" },
        { key: "zinc_mg",       label: mi.zinc,       unit: "mg" },
        { key: "sodium_mg",     label: mi.sodium,     unit: "mg" },
        { key: "copper_mg",     label: mi.copper,     unit: "mg" },
      ],
    },
    {
      label: t.micronutrients.groups.fats,
      items: [
        { key: "saturated_fat_g",       label: mi.saturated,       unit: "g" },
        { key: "monounsaturated_fat_g",  label: mi.monounsaturated, unit: "g" },
        { key: "polyunsaturated_fat_g",  label: mi.polyunsaturated, unit: "g" },
        { key: "omega3_g",              label: mi.omega3,          unit: "g" },
        { key: "cholesterol_mg",        label: mi.cholesterol,     unit: "mg" },
      ],
    },
  ];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function round1(n: number) { return Math.round(n * 10) / 10; }

// Maps a standalone diary entry onto the FoodNutrientModal's prop shape. DiaryEntry already
// carries every micronutrient field the modal renders; missing ones (undefined) are normalized
// to null so FoodNutrientModal's own "—" placeholder handling picks them up uniformly.
function diaryEntryToNutrientEntry(entry: DiaryEntry): FoodNutrientEntry {
  return {
    food_name: entry.food_name,
    calories: entry.calories,
    protein_g: entry.protein_g,
    carbs_g: entry.carbs_g,
    fat_g: entry.fat_g,
    fiber_g: entry.fiber_g ?? null,
    sugar_g: entry.sugar_g ?? null,
    sodium_mg: entry.sodium_mg ?? null,
    saturated_fat_g: entry.saturated_fat_g ?? null,
    monounsaturated_fat_g: entry.monounsaturated_fat_g ?? null,
    polyunsaturated_fat_g: entry.polyunsaturated_fat_g ?? null,
    omega3_g: entry.omega3_g ?? null,
    cholesterol_mg: entry.cholesterol_mg ?? null,
    vitamin_a_mcg: entry.vitamin_a_mcg ?? null,
    vitamin_c_mg: entry.vitamin_c_mg ?? null,
    vitamin_d_mcg: entry.vitamin_d_mcg ?? null,
    vitamin_e_mg: entry.vitamin_e_mg ?? null,
    vitamin_k_mcg: entry.vitamin_k_mcg ?? null,
    thiamin_mg: entry.thiamin_mg ?? null,
    riboflavin_mg: entry.riboflavin_mg ?? null,
    niacin_mg: entry.niacin_mg ?? null,
    vitamin_b6_mg: entry.vitamin_b6_mg ?? null,
    folate_mcg: entry.folate_mcg ?? null,
    vitamin_b12_mcg: entry.vitamin_b12_mcg ?? null,
    calcium_mg: entry.calcium_mg ?? null,
    iron_mg: entry.iron_mg ?? null,
    magnesium_mg: entry.magnesium_mg ?? null,
    phosphorus_mg: entry.phosphorus_mg ?? null,
    potassium_mg: entry.potassium_mg ?? null,
    zinc_mg: entry.zinc_mg ?? null,
    copper_mg: entry.copper_mg ?? null,
  };
}

// Ingredient rows inside an expanded meal only ever carry the subset of fields built at meal-log
// time (see how `meal_items` gets constructed) — no micronutrient columns. That's expected: the
// rest render as "—" via FoodNutrientModal's own missing-field handling, not backfilled here.
function mealItemToNutrientEntry(item: NonNullable<DiaryEntry["meal_items"]>[number]): FoodNutrientEntry {
  return {
    food_name: item.food_name,
    calories: item.calories,
    protein_g: item.protein_g,
    carbs_g: item.carbs_g,
    fat_g: item.fat_g,
    fiber_g: item.fiber_g ?? null,
  };
}

function computeTotals(entries: DiaryEntry[]) {
  const food = entries.filter(e => e.meal_type !== "water");
  const sum = (key: keyof DiaryEntry) =>
    round1(food.reduce((s, e) => s + ((e[key] as number) ?? 0), 0));

  return {
    calories:            Math.round(food.reduce((s, e) => s + e.calories, 0)),
    protein_g:           sum("protein_g"),
    carbs_g:             sum("carbs_g"),
    fat_g:               sum("fat_g"),
    fiber_g:             sum("fiber_g"),
    sugar_g:             sum("sugar_g"),
    sodium_mg:           sum("sodium_mg"),
    vitamin_a_mcg:       sum("vitamin_a_mcg"),
    vitamin_c_mg:        sum("vitamin_c_mg"),
    vitamin_d_mcg:       sum("vitamin_d_mcg"),
    vitamin_e_mg:        sum("vitamin_e_mg"),
    vitamin_k_mcg:       sum("vitamin_k_mcg"),
    thiamin_mg:          sum("thiamin_mg"),
    riboflavin_mg:       sum("riboflavin_mg"),
    niacin_mg:           sum("niacin_mg"),
    vitamin_b6_mg:       sum("vitamin_b6_mg"),
    folate_mcg:          sum("folate_mcg"),
    vitamin_b12_mcg:     sum("vitamin_b12_mcg"),
    calcium_mg:          sum("calcium_mg"),
    iron_mg:             sum("iron_mg"),
    magnesium_mg:        sum("magnesium_mg"),
    phosphorus_mg:       sum("phosphorus_mg"),
    potassium_mg:        sum("potassium_mg"),
    zinc_mg:             sum("zinc_mg"),
    copper_mg:           sum("copper_mg"),
    saturated_fat_g:         sum("saturated_fat_g"),
    monounsaturated_fat_g:   sum("monounsaturated_fat_g"),
    polyunsaturated_fat_g:   sum("polyunsaturated_fat_g"),
    omega3_g:                sum("omega3_g"),
    cholesterol_mg:          sum("cholesterol_mg"),
  };
}

function formatDate(iso: string, language: "en" | "no"): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString(localeTag(language), { weekday: "long", day: "numeric", month: "long" });
}

function prevDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function pct(val: number, max: number) {
  return Math.min(100, max > 0 ? Math.round((val / max) * 100) : 0);
}

// ── SVG Ring ─────────────────────────────────────────────────────────────────

function CalRing({ value, max, size = 100, stroke = 9 }: { value: number; max: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const fill = max > 0 ? Math.min(1, value / max) : 0;
  const offset = circ * (1 - fill);
  const cx = size / 2;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(var(--overlay-rgb),.07)" strokeWidth={stroke} />
      <circle
        cx={cx} cy={cx} r={r} fill="none"
        stroke={fill >= 1 ? "var(--amber)" : "var(--accent)"}
        strokeWidth={stroke}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cx})`}
        style={{ transition: "stroke-dashoffset .5s ease" }}
      />
    </svg>
  );
}

// ── Macro bar ────────────────────────────────────────────────────────────────

function MacroBar({ label, value, max, color, unit = "g" }: { label: string; value: number; max: number; color: string; unit?: string }) {
  const p = pct(value, max);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
        <span style={{ color: "var(--muted)" }}>{label}</span>
        <span style={{ color, fontWeight: 700 }}>{value}{unit} <span style={{ color: "var(--dim)", fontWeight: 400 }}>/ {max}{unit}</span></span>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${p}%`, background: color }} />
      </div>
    </div>
  );
}

// ── Micro row ────────────────────────────────────────────────────────────────

function MicroRow({ label, value, rda, unit }: { label: string; value: number; rda: number; unit: string }) {
  const p = Math.min(120, pct(value, rda));
  const over = p >= 110;
  const met = p >= 95;
  const low = p < 40;
  const barColor = over ? "var(--amber)" : met ? "var(--green)" : low ? "rgba(var(--red-rgb),.6)" : "var(--accent)";
  const valColor = over ? "var(--amber)" : met ? "var(--green)" : low ? "var(--red)" : "var(--muted)";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", width: 90, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ height: 4, background: "rgba(var(--overlay-rgb),.07)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${p}%`, background: barColor, borderRadius: 2, transition: "width .4s ease" }} />
        </div>
      </div>
      <div style={{ fontSize: 10, color: valColor, width: 52, textAlign: "right", flexShrink: 0, fontWeight: met || over ? 700 : 400 }}>
        {value > 0 ? `${value}${unit}` : "—"}
        {over ? " ↑" : met ? " ✓" : ""}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

type MealRecommendation = {
  id?: string;
  date?: string;
  meal_type: string;
  name: string;
  description?: string | null;
  ingredients: Array<{
    food_name: string; quantity_g: number;
    serving_qty?: number | null; serving_label?: string | null;
    calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number;
  }>;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number;
  micros?: Record<string, number>;
};

export function NutritionClient({
  initialDate,
  initialEntries,
  target,
  dayType: initialDayType,
  mealRecommendations: initialMealRecommendations,
}: {
  initialDate: string;
  initialEntries: DiaryEntry[];
  target: NutritionTarget | null;
  dayType: string;
  mealRecommendations: MealRecommendation[];
}) {
  const nt = useT().nutrition;
  const [language] = useLanguage();
  const MEALS = getMeals(nt);
  const DAY_TYPE_LABELS = getDayTypeLabels(nt);
  const MICRO_GROUPS = getMicroGroups(nt);
  const formatQty = useFormatQty();
  const [date, setDate] = useState(initialDate);
  const [entries, setEntries] = useState<DiaryEntry[]>(initialEntries);
  const [loadingEntries, setLoadingEntries] = useState(false);

  // Nutrient detail modal state — which entry (standalone row or meal ingredient) is open, if any
  const [nutrientModalEntry, setNutrientModalEntry] = useState<FoodNutrientEntry | null>(null);

  // Search modal state
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeMeal, setActiveMeal] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<USDAFood[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedFood, setSelectedFood] = useState<USDAFood | null>(null);
  const [addQty, setAddQty] = useState(100);
  const [addServingQty, setAddServingQty] = useState<number | null>(null);
  const [addServingLabel, setAddServingLabel] = useState<string | null>(null);
  const [portionsLoading, setPortionsLoading] = useState(false);
  const [addingFood, setAddingFood] = useState(false);
  const [recentFoods, setRecentFoods] = useState<RecentFood[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const recentFetchedAt = useRef<number>(0);

  // Quick-add (just numbers) state
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickMeal, setQuickMeal] = useState("");
  const [quickForm, setQuickForm] = useState({ name: "", calories: 0, protein: 0, carbs: 0, fat: 0, servingQty: "", servingLabel: "" });

  // Water logging (drag-to-fill bottle + slider)
  const [waterLogOpen, setWaterLogOpen] = useState(false);
  const [waterSliderMl, setWaterSliderMl] = useState(250);
  const [waterDragging, setWaterDragging] = useState(false);
  const [addingWater, setAddingWater] = useState(false);
  const waterBottleRef = useRef<HTMLDivElement>(null);

  // Photo AI
  const [photoOpen, setPhotoOpen] = useState(false);
  const [photoMeal, setPhotoMeal] = useState("");

  // Barcode scanner
  const [scannerOpen, setScannerOpen] = useState(false);
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [barcodeError, setBarcodeError] = useState<string | null>(null);

  // Copy from previous day
  const [copyOpen, setCopyOpen] = useState(false);
  const [copying, setCopying] = useState(false);

  // Mobile top-bar overflow menu (Copy day / units / Meals / Meal Plan / Regenerate)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

  // Custom foods
  const [customFoods, setCustomFoods] = useState<CustomFood[]>([]);
  const customFoodsLoaded = useRef(false);
  const [customFoodModalOpen, setCustomFoodModalOpen] = useState(false);
  const [editingCustomFood, setEditingCustomFood] = useState<CustomFood | null>(null);

  // Meal templates
  const [mealTemplates, setMealTemplates] = useState<MealTemplate[]>([]);
  const mealsLoaded = useRef(false);
  const [mealBuilderOpen, setMealBuilderOpen] = useState(false);
  const [mealBuilderDraft, setMealBuilderDraft] = useState<MealDraft | null>(null);
  const [mealManagerOpen, setMealManagerOpen] = useState(false);
  const [loggingMealId, setLoggingMealId] = useState<string | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const [expandedRecs, setExpandedRecs] = useState<Set<string>>(new Set());
  const [mealPlanOpen, setMealPlanOpen] = useState(false);

  // Targets config modal
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [targetForm, setTargetForm] = useState({
    day_type: initialDayType === "default" ? "default" : initialDayType,
    calories: target?.calories ?? 2200,
    protein_g: target?.protein_g ?? 160,
    carbs_g: target?.carbs_g ?? 250,
    fat_g: target?.fat_g ?? 75,
    fiber_g: target?.fiber_g ?? 30,
    water_ml: target?.water_ml ?? 2500,
  });
  const [targetSaving, setTargetSaving] = useState(false);
  const [targetGenerating, setTargetGenerating] = useState(false);
  const [targetGenNote, setTargetGenNote] = useState<string | null>(null);
  const generatedTargets = useRef<NutritionTarget[]>([]);

  // Per-day target state (client-driven so navigation is instant)
  const [dayType, setDayType] = useState(initialDayType);

  // Coach meal recommendations
  const [mealRecommendations, setMealRecommendations] = useState<MealRecommendation[]>(initialMealRecommendations);
  const [recsGenerating, setRecsGenerating] = useState(false);

  const [currentTarget, setCurrentTarget] = useState<NutritionTarget | null>(target);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Date navigation ────────────────────────────────────────────────────────

  const navigateDate = useCallback(async (newDate: string) => {
    setLoadingEntries(true);
    setDate(newDate);
    setMealRecommendations([]);
    try {
      const [diaryRes, dtRes, recsRes] = await Promise.all([
        fetch(`/api/nutrition/diary?date=${newDate}`).then(r => r.json()),
        fetch(`/api/nutrition/daily-target?date=${newDate}`).then(r => r.json()),
        fetch(`/api/nutrition/meal-recommendations?date=${newDate}`).then(r => r.json()),
      ]);
      setEntries(diaryRes.data ?? []);
      setDayType(dtRes.dayType ?? "default");
      setCurrentTarget(dtRes.target ?? null);
      setMealRecommendations(recsRes.data ?? []);
    } finally {
      setLoadingEntries(false);
    }
  }, []);

  // ── Computed values ────────────────────────────────────────────────────────

  const totals = useMemo(() => computeTotals(entries), [entries]);
  const waterEntries = useMemo(() => entries.filter(e => e.meal_type === "water"), [entries]);
  const waterMl = useMemo(() => waterEntries.reduce((s, e) => s + e.quantity_g, 0), [waterEntries]);
  const waterTarget = currentTarget?.water_ml ?? 2500;

  const calTarget = currentTarget?.calories ?? 0;
  const isOverCalories = calTarget > 0 && totals.calories > calTarget;
  const remaining = calTarget > 0 ? Math.max(0, calTarget - totals.calories) : 0;
  const isToday = date === todayISO();
  const isPastDay = date < todayISO();
  const dayMeta = DAY_TYPE_LABELS[dayType] ?? DAY_TYPE_LABELS.default;

  // Pre/post-workout protein timing — feeds the "day concluded" summary on past days.
  const workoutNutrition = useMemo(() => {
    const PRO_MIN = 20;
    const preMeals  = entries.filter(e => e.meal_type === "pre_workout");
    const postMeals = entries.filter(e => e.meal_type === "post_workout");
    const preP  = round1(preMeals.reduce((s, e)  => s + (e.protein_g ?? 0), 0));
    const preC  = round1(preMeals.reduce((s, e)  => s + (e.carbs_g  ?? 0), 0));
    const postP = round1(postMeals.reduce((s, e) => s + (e.protein_g ?? 0), 0));
    const preCal  = Math.round(preMeals.reduce((s, e)  => s + (e.calories ?? 0), 0));
    const postCal = Math.round(postMeals.reduce((s, e) => s + (e.calories ?? 0), 0));
    type Status = "ok" | "low" | "empty";
    const preStatus:  Status = preMeals.length  === 0 ? "empty" : preP  >= PRO_MIN ? "ok" : "low";
    const postStatus: Status = postMeals.length === 0 ? "empty" : postP >= PRO_MIN ? "ok" : "low";
    return { preStatus, postStatus, preP, preC, postP, preCal, postCal, PRO_MIN };
  }, [entries]);

  // ── Food search ───────────────────────────────────────────────────────────

  const handleSearch = useCallback((q: string) => {
    setSearchQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 2) { setSearchResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`/api/nutrition/search?q=${encodeURIComponent(q)}`);
        const { foods } = await res.json();
        setSearchResults(foods ?? []);
      } finally {
        setSearchLoading(false);
      }
    }, 400);
  }, []);

  // Selects a food for the quantity-entry step and fetches its USDA portion
  // options (foodPortions) in the background — grams stay usable immediately,
  // the piece-unit picker just populates a moment later once fetched.
  // Fallback for branded/packaged foods with no USDA foodPortions array but a
  // household-serving label (e.g. "1 slice"): synthesize a single portion so
  // the picker still offers a natural unit instead of grams-only.
  function impliedPortion(food: USDAFood): Portion[] {
    if (!food.servingLabel || !food.servingSize) return [];
    const noun = food.servingLabel.replace(/^[\d.]+\s*/, "").split("(")[0].trim();
    return [{ label: noun || "serving", gramWeight: food.servingSize }];
  }

  const selectSearchResult = useCallback(async (food: USDAFood) => {
    setSelectedFood(food);
    setAddQty(food.servingSize ? Math.round(food.servingSize) : 100);
    setAddServingQty(null);
    setAddServingLabel(null);
    if (food.isCustom || !food.fdcId) {
      // No USDA fdcId to look up (custom food or barcode/OFF item) — the food
      // object already carries any portions the caller synthesized (custom
      // foods) or none; fall back to an implied single serving if possible.
      if (!food.portions?.length) {
        setSelectedFood(prev => (prev ? { ...prev, portions: impliedPortion(food) } : prev));
      }
      return;
    }
    setPortionsLoading(true);
    try {
      const res = await fetch(`/api/nutrition/food-details?ids=${food.fdcId}`);
      const { foods } = await res.json() as { foods?: Array<{ fdcId: number; portions?: Portion[] }> };
      const portions = foods?.[0]?.portions?.length ? foods[0].portions : impliedPortion(food);
      setSelectedFood(prev => (prev && prev.fdcId === food.fdcId ? { ...prev, portions } : prev));
    } catch {
      // degrade to grams-only — non-fatal
    } finally {
      setPortionsLoading(false);
    }
  }, []);

  const handleBarcodeScan = useCallback(async (barcode: string) => {
    setScannerOpen(false);
    setBarcodeLoading(true);
    setBarcodeError(null);
    try {
      const res = await fetch(`/api/nutrition/barcode?code=${encodeURIComponent(barcode)}`);
      const { found, food } = await res.json();
      if (found && food) {
        // Map OFF food shape to USDAFood shape (they share the same fields now)
        selectSearchResult(food as USDAFood);
        setSearchOpen(true);
      } else {
        setBarcodeError(nt.barcodeLookup.notFound.replace("{code}", barcode));
        setSearchOpen(true);
      }
    } catch {
      setBarcodeError(nt.barcodeLookup.failed);
      setSearchOpen(true);
    } finally {
      setBarcodeLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectSearchResult]);

  const handlePhotoLog = useCallback(async (
    aiItems: Array<{ food_name: string; quantity_g: number; calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g?: number; usda_fdc_id?: number; }>
  ) => {
    const results = await Promise.all(
      aiItems.map(item =>
        fetch(`/api/nutrition/diary?date=${date}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meal_type:    photoMeal,
            food_name:    item.food_name,
            quantity_g:   item.quantity_g,
            calories:     item.calories,
            protein_g:    item.protein_g,
            carbs_g:      item.carbs_g,
            fat_g:        item.fat_g,
            fiber_g:      item.fiber_g ?? 0,
            usda_fdc_id:  item.usda_fdc_id ?? null,
          }),
        }).then(r => r.json())
      )
    );
    const newEntries = results.map(r => r.data).filter(Boolean);
    setEntries(prev => [...prev, ...newEntries]);
  }, [date, photoMeal]);

  function customToUSDA(food: CustomFood): USDAFood {
    const pieceUnit = food.serving_unit && food.serving_unit !== "g" ? food.serving_unit : null;
    return {
      fdcId: 0,
      description: food.name,
      brand: food.brand ?? null,
      category: nt.searchModal.myFoods,
      servingSize: food.serving_size_g,
      servingUnit: "g",
      servingLabel: food.serving_size_g !== 100 ? `1 serving (${food.serving_size_g}g)` : null,
      portions: pieceUnit ? [{ label: pieceUnit, gramWeight: food.serving_size_g }] : [],
      calories: food.calories_per_100g,
      protein: food.protein_per_100g,
      carbs: food.carbs_per_100g,
      fat: food.fat_per_100g,
      fiber: food.fiber_per_100g,
      sugar: food.sugar_per_100g,
      sodium: food.sodium_per_100mg,
      vitamin_a_mcg: 0, vitamin_c_mg: 0, vitamin_d_mcg: 0, vitamin_e_mg: 0, vitamin_k_mcg: 0,
      thiamin_mg: 0, riboflavin_mg: 0, niacin_mg: 0, vitamin_b6_mg: 0, folate_mcg: 0, vitamin_b12_mcg: 0,
      calcium_mg: 0, iron_mg: 0, magnesium_mg: 0, phosphorus_mg: 0, potassium_mg: 0, zinc_mg: 0, copper_mg: 0,
      saturated_fat_g: 0, monounsaturated_fat_g: 0, polyunsaturated_fat_g: 0, omega3_g: 0, cholesterol_mg: 0,
      isCustom: true,
      customFoodId: food.id,
    };
  }

  const deleteCustomFood = async (id: string) => {
    await fetch(`/api/nutrition/custom-foods/${id}`, { method: "DELETE" });
    setCustomFoods(prev => prev.filter(f => f.id !== id));
    if (selectedFood?.customFoodId === id) setSelectedFood(null);
  };

  const openSearch = (meal: string) => {
    setActiveMeal(meal);
    setSearchOpen(true);
    setSearchQuery("");
    setSearchResults([]);
    setSelectedFood(null);
    setAddQty(100);
    setTimeout(() => searchInputRef.current?.focus(), 50);
    // Load custom foods once per session
    if (!customFoodsLoaded.current) {
      customFoodsLoaded.current = true;
      fetch("/api/nutrition/custom-foods")
        .then(r => r.json())
        .then(({ foods }) => setCustomFoods(foods ?? []))
        .catch(() => {});
    }
    // Load meal templates once per session
    if (!mealsLoaded.current) {
      mealsLoaded.current = true;
      fetch("/api/nutrition/meals")
        .then(r => r.json())
        .then(({ meals }) => setMealTemplates(meals ?? []))
        .catch(() => {});
    }
    // Refresh recent foods if stale (older than 60 s)
    if (Date.now() - recentFetchedAt.current > 60_000) {
      setRecentLoading(true);
      fetch("/api/nutrition/recent")
        .then(r => r.json())
        .then(({ foods }) => { setRecentFoods(foods ?? []); recentFetchedAt.current = Date.now(); })
        .catch(() => {})
        .finally(() => setRecentLoading(false));
    }
  };

  const logRecentFood = async (food: RecentFood) => {
    setAddingFood(true);
    try {
      const res = await fetch(`/api/nutrition/diary?date=${date}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meal_type:      activeMeal,
          food_name:      food.food_name,
          quantity_g:     food.quantity_g,
          serving_qty:    food.serving_qty ?? null,
          serving_label:  food.serving_label ?? null,
          calories:    food.calories,
          protein_g:   food.protein_g,
          carbs_g:     food.carbs_g,
          fat_g:       food.fat_g,
          fiber_g:     food.fiber_g ?? 0,
          usda_fdc_id: food.usda_fdc_id ?? null,
        }),
      });
      const { data } = await res.json();
      if (data) setEntries(prev => [...prev, data]);
      recentFetchedAt.current = 0; // invalidate so next open refetches
      setSearchOpen(false);
    } finally {
      setAddingFood(false);
    }
  };

  const openRecentFoodDetail = (food: RecentFood) => {
    const qty = Math.max(food.quantity_g, 1);
    const scale = 100 / qty;
    const r1 = (v: number) => Math.round(v * scale * 10) / 10;
    const priorPortion: Portion[] = food.serving_qty && food.serving_label
      ? [{ label: food.serving_label, gramWeight: round1(qty / food.serving_qty) }]
      : [];
    const syntheticFood: USDAFood = {
      fdcId: food.usda_fdc_id ?? 0,
      description: food.food_name,
      brand: null, category: null,
      servingSize: qty, servingUnit: "g", servingLabel: `${qty}g (previous portion)`,
      portions: priorPortion,
      calories:  r1(food.calories),
      protein:   r1(food.protein_g),
      carbs:     r1(food.carbs_g),
      fat:       r1(food.fat_g),
      fiber:     r1(food.fiber_g ?? 0),
      sugar: 0, sodium: 0,
      vitamin_a_mcg: 0, vitamin_c_mg: 0, vitamin_d_mcg: 0, vitamin_e_mg: 0, vitamin_k_mcg: 0,
      thiamin_mg: 0, riboflavin_mg: 0, niacin_mg: 0, vitamin_b6_mg: 0, folate_mcg: 0, vitamin_b12_mcg: 0,
      calcium_mg: 0, iron_mg: 0, magnesium_mg: 0, phosphorus_mg: 0, potassium_mg: 0, zinc_mg: 0, copper_mg: 0,
      saturated_fat_g: 0, monounsaturated_fat_g: 0, polyunsaturated_fat_g: 0, omega3_g: 0, cholesterol_mg: 0,
    };
    selectSearchResult(syntheticFood);
  };

  const copyFromDate = async (fromDate: string) => {
    setCopyOpen(false);
    setCopying(true);
    try {
      const res = await fetch("/api/nutrition/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_date: fromDate, to_date: date }),
      });
      const { entries: newEntries } = await res.json();
      if (newEntries?.length) setEntries(prev => [...prev, ...newEntries]);
    } finally {
      setCopying(false);
    }
  };

  const logMealTemplate = async (template: MealTemplate) => {
    setLoggingMealId(template.id);
    const servings = Math.max(template.servings, 1);
    const scale = 1 / servings;
    const sc1 = (v: number) => Math.round(v * scale * 10) / 10;

    const items = template.meal_template_items.map(item => ({
      food_name:     item.food_name,
      quantity_g:    Math.round(item.quantity_g * scale),
      calories:      Math.round(item.calories   * scale),
      protein_g:     sc1(item.protein_g),
      carbs_g:       sc1(item.carbs_g),
      fat_g:         sc1(item.fat_g),
      fiber_g:       sc1(item.fiber_g ?? 0),
      usda_fdc_id:   item.usda_fdc_id ?? null,
    }));

    // Fetch full nutritional data (including micros) for USDA ingredients
    const fdcIds = items.map(it => it.usda_fdc_id).filter((id): id is number => Boolean(id));
    const fdcMap: Record<number, Record<string, number>> = {};
    if (fdcIds.length) {
      try {
        const r = await fetch(`/api/nutrition/food-details?ids=${fdcIds.join(",")}`);
        const { foods } = await r.json() as { foods: Array<Record<string, number>> };
        for (const f of foods ?? []) fdcMap[f.fdcId] = f;
      } catch { /* micros unavailable — proceed without */ }
    }

    // Aggregate macros + micros across all items
    type Agg = Record<string, number>;
    const agg: Agg = { quantity_g: 0, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0,
      sugar_g: 0, sodium_mg: 0, vitamin_a_mcg: 0, vitamin_c_mg: 0, vitamin_d_mcg: 0,
      vitamin_e_mg: 0, vitamin_k_mcg: 0, thiamin_mg: 0, riboflavin_mg: 0, niacin_mg: 0,
      vitamin_b6_mg: 0, folate_mcg: 0, vitamin_b12_mcg: 0, calcium_mg: 0, iron_mg: 0,
      magnesium_mg: 0, phosphorus_mg: 0, potassium_mg: 0, zinc_mg: 0, copper_mg: 0,
      saturated_fat_g: 0, monounsaturated_fat_g: 0, polyunsaturated_fat_g: 0, omega3_g: 0, cholesterol_mg: 0 };

    for (const item of items) {
      agg.quantity_g += item.quantity_g;
      agg.calories   += item.calories;
      agg.protein_g  += item.protein_g;
      agg.carbs_g    += item.carbs_g;
      agg.fat_g      += item.fat_g;
      agg.fiber_g    += item.fiber_g;
      const fd = item.usda_fdc_id ? fdcMap[item.usda_fdc_id] : null;
      if (fd) {
        const s = item.quantity_g / 100;
        agg.sugar_g             += (fd.sugar            ?? 0) * s;
        agg.sodium_mg           += (fd.sodium           ?? 0) * s;
        agg.vitamin_a_mcg       += (fd.vitamin_a_mcg    ?? 0) * s;
        agg.vitamin_c_mg        += (fd.vitamin_c_mg     ?? 0) * s;
        agg.vitamin_d_mcg       += (fd.vitamin_d_mcg    ?? 0) * s;
        agg.vitamin_e_mg        += (fd.vitamin_e_mg     ?? 0) * s;
        agg.vitamin_k_mcg       += (fd.vitamin_k_mcg    ?? 0) * s;
        agg.thiamin_mg          += (fd.thiamin_mg       ?? 0) * s;
        agg.riboflavin_mg       += (fd.riboflavin_mg    ?? 0) * s;
        agg.niacin_mg           += (fd.niacin_mg        ?? 0) * s;
        agg.vitamin_b6_mg       += (fd.vitamin_b6_mg    ?? 0) * s;
        agg.folate_mcg          += (fd.folate_mcg       ?? 0) * s;
        agg.vitamin_b12_mcg     += (fd.vitamin_b12_mcg  ?? 0) * s;
        agg.calcium_mg          += (fd.calcium_mg       ?? 0) * s;
        agg.iron_mg             += (fd.iron_mg          ?? 0) * s;
        agg.magnesium_mg        += (fd.magnesium_mg     ?? 0) * s;
        agg.phosphorus_mg       += (fd.phosphorus_mg    ?? 0) * s;
        agg.potassium_mg        += (fd.potassium_mg     ?? 0) * s;
        agg.zinc_mg             += (fd.zinc_mg          ?? 0) * s;
        agg.copper_mg           += (fd.copper_mg        ?? 0) * s;
        agg.saturated_fat_g     += (fd.saturated_fat_g     ?? 0) * s;
        agg.monounsaturated_fat_g += (fd.monounsaturated_fat_g ?? 0) * s;
        agg.polyunsaturated_fat_g += (fd.polyunsaturated_fat_g ?? 0) * s;
        agg.omega3_g            += (fd.omega3_g         ?? 0) * s;
        agg.cholesterol_mg      += (fd.cholesterol_mg   ?? 0) * s;
      }
    }

    const r1 = (v: number) => Math.round(v * 10) / 10;
    try {
      const res = await fetch(`/api/nutrition/diary?date=${date}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meal_type:              activeMeal,
          food_name:              template.name,
          quantity_g:             Math.round(agg.quantity_g),
          calories:               Math.round(agg.calories),
          protein_g:              r1(agg.protein_g),
          carbs_g:                r1(agg.carbs_g),
          fat_g:                  r1(agg.fat_g),
          fiber_g:                r1(agg.fiber_g),
          sugar_g:                r1(agg.sugar_g),
          sodium_mg:              r1(agg.sodium_mg),
          vitamin_a_mcg:          r1(agg.vitamin_a_mcg),
          vitamin_c_mg:           r1(agg.vitamin_c_mg),
          vitamin_d_mcg:          r1(agg.vitamin_d_mcg),
          vitamin_e_mg:           r1(agg.vitamin_e_mg),
          vitamin_k_mcg:          r1(agg.vitamin_k_mcg),
          thiamin_mg:             r1(agg.thiamin_mg),
          riboflavin_mg:          r1(agg.riboflavin_mg),
          niacin_mg:              r1(agg.niacin_mg),
          vitamin_b6_mg:          r1(agg.vitamin_b6_mg),
          folate_mcg:             r1(agg.folate_mcg),
          vitamin_b12_mcg:        r1(agg.vitamin_b12_mcg),
          calcium_mg:             r1(agg.calcium_mg),
          iron_mg:                r1(agg.iron_mg),
          magnesium_mg:           r1(agg.magnesium_mg),
          phosphorus_mg:          r1(agg.phosphorus_mg),
          potassium_mg:           r1(agg.potassium_mg),
          zinc_mg:                r1(agg.zinc_mg),
          copper_mg:              r1(agg.copper_mg),
          saturated_fat_g:        r1(agg.saturated_fat_g),
          monounsaturated_fat_g:  r1(agg.monounsaturated_fat_g),
          polyunsaturated_fat_g:  r1(agg.polyunsaturated_fat_g),
          omega3_g:               r1(agg.omega3_g),
          cholesterol_mg:         r1(agg.cholesterol_mg),
          meal_items:             items.map(({ usda_fdc_id: _, ...rest }) => rest),
        }),
      });
      const { data } = await res.json();
      if (data) setEntries(prev => [...prev, data]);
      setSearchOpen(false);
    } finally {
      setLoggingMealId(null);
    }
  };

  const logRecommendedMeal = async (rec: MealRecommendation, targetDate?: string) => {
    const logDate = targetDate ?? date;
    const res = await fetch(`/api/nutrition/diary?date=${logDate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        meal_type:   rec.meal_type,
        food_name:   rec.name,
        quantity_g:  rec.ingredients.reduce((s, i) => s + i.quantity_g, 0),
        calories:    rec.calories,
        protein_g:   rec.protein_g,
        carbs_g:     rec.carbs_g,
        fat_g:       rec.fat_g,
        fiber_g:     rec.fiber_g ?? 0,
        meal_items:  rec.ingredients,
        ...(rec.micros ?? {}),
      }),
    });
    const { data } = await res.json();
    if (data && logDate === date) setEntries(prev => [...prev, data]);
    return data;
  };

  const generateMealRecommendations = async (days: number, forDate?: string) => {
    setRecsGenerating(true);
    try {
      const res = await fetch("/api/nutrition/meal-recommendations/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: forDate ?? date, days }),
      });
      const json = await res.json();
      // The response may span several days (week planning) — only today's slice matters here.
      if (json.data) setMealRecommendations((json.data as MealRecommendation[]).filter(r => r.date === date));
    } finally {
      setRecsGenerating(false);
    }
  };

  // Auto-plan the coming week the first time this page loads with nothing generated yet,
  // so the coach recommendation is already there rather than requiring a manual click.
  const weekAutoPlanned = useRef(false);
  useEffect(() => {
    if (weekAutoPlanned.current) return;
    if (mealRecommendations.length > 0) { weekAutoPlanned.current = true; return; }
    const horizonEnd = (() => { const d = new Date(todayISO()); d.setDate(d.getDate() + 6); return d.toISOString().slice(0, 10); })();
    if (date < todayISO() || date > horizonEnd) return;
    weekAutoPlanned.current = true;
    // Fires an async POST that eventually calls setMealRecommendations/setRecsGenerating -
    // a genuine one-time action on mount, guarded by the ref above (not state, so it can't
    // itself trigger a re-render loop), not a value being synchronized from render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    generateMealRecommendations(7, todayISO());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openQuickAdd = (meal: string) => {
    setQuickMeal(meal);
    setQuickForm({ name: "", calories: 0, protein: 0, carbs: 0, fat: 0, servingQty: "", servingLabel: "" });
    setQuickOpen(true);
  };

  // ── Add food ──────────────────────────────────────────────────────────────

  const handleAddFood = async (food: USDAFood, meal: string, qty: number, servingQty?: number | null, servingLabel?: string | null) => {
    setAddingFood(true);
    const scale = qty / 100;
    const s = (v: number) => round1(v * scale);

    const entry = {
      meal_type:              meal,
      food_name:              food.description,
      brand:                  food.brand,
      quantity_g:             qty,
      serving_qty:            servingQty ?? null,
      serving_label:          servingLabel ?? null,
      calories:               Math.round(food.calories * scale),
      protein_g:              s(food.protein),
      carbs_g:                s(food.carbs),
      fat_g:                  s(food.fat),
      fiber_g:                s(food.fiber),
      sugar_g:                s(food.sugar),
      sodium_mg:              s(food.sodium),
      vitamin_a_mcg:          s(food.vitamin_a_mcg),
      vitamin_c_mg:           s(food.vitamin_c_mg),
      vitamin_d_mcg:          s(food.vitamin_d_mcg),
      vitamin_e_mg:           s(food.vitamin_e_mg),
      vitamin_k_mcg:          s(food.vitamin_k_mcg),
      thiamin_mg:             s(food.thiamin_mg),
      riboflavin_mg:          s(food.riboflavin_mg),
      niacin_mg:              s(food.niacin_mg),
      vitamin_b6_mg:          s(food.vitamin_b6_mg),
      folate_mcg:             s(food.folate_mcg),
      vitamin_b12_mcg:        s(food.vitamin_b12_mcg),
      calcium_mg:             s(food.calcium_mg),
      iron_mg:                s(food.iron_mg),
      magnesium_mg:           s(food.magnesium_mg),
      phosphorus_mg:          s(food.phosphorus_mg),
      potassium_mg:           s(food.potassium_mg),
      zinc_mg:                s(food.zinc_mg),
      copper_mg:              s(food.copper_mg),
      saturated_fat_g:        s(food.saturated_fat_g),
      monounsaturated_fat_g:  s(food.monounsaturated_fat_g),
      polyunsaturated_fat_g:  s(food.polyunsaturated_fat_g),
      omega3_g:               s(food.omega3_g),
      cholesterol_mg:         s(food.cholesterol_mg),
      usda_fdc_id:            String(food.fdcId),
    };

    try {
      const res = await fetch(`/api/nutrition/diary?date=${date}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      const { data } = await res.json();
      if (data) setEntries(prev => [...prev, data]);
      setSearchOpen(false);
    } finally {
      setAddingFood(false);
    }
  };

  const handleQuickAdd = async () => {
    if (!quickForm.name || quickForm.calories === 0) return;
    setAddingFood(true);
    try {
      const res = await fetch(`/api/nutrition/diary?date=${date}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meal_type:      quickMeal,
          food_name:      quickForm.name,
          quantity_g:     100,
          serving_qty:    quickForm.servingQty ? parseFloat(quickForm.servingQty) || null : null,
          serving_label:  quickForm.servingLabel.trim() || null,
          calories:   quickForm.calories,
          protein_g:  quickForm.protein,
          carbs_g:    quickForm.carbs,
          fat_g:      quickForm.fat,
        }),
      });
      const { data } = await res.json();
      if (data) setEntries(prev => [...prev, data]);
      setQuickOpen(false);
    } finally {
      setAddingFood(false);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    setEntries(prev => prev.filter(e => e.id !== id));
    await fetch(`/api/nutrition/diary/${id}`, { method: "DELETE" });
  };

  // ── Water ─────────────────────────────────────────────────────────────────

  const handleLogWater = async (amountMl: number) => {
    if (amountMl <= 0) return;
    setAddingWater(true);
    try {
      const res = await fetch(`/api/nutrition/diary?date=${date}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meal_type:  "water",
          food_name:  "Water",
          quantity_g: amountMl,
          calories:   0,
          protein_g:  0,
          carbs_g:    0,
          fat_g:      0,
        }),
      });
      const { data } = await res.json();
      if (data) setEntries(prev => [...prev, data]);
      setWaterLogOpen(false);
    } finally {
      setAddingWater(false);
    }
  };

  const handleRemoveWater = async () => {
    const last = [...waterEntries].pop();
    if (!last) return;
    setEntries(prev => prev.filter(e => e.id !== last.id));
    await fetch(`/api/nutrition/diary/${last.id}`, { method: "DELETE" });
  };

  // Reads the mL value implied by a pointer's vertical position within the bottle gauge.
  const waterMlFromPointer = useCallback((clientY: number) => {
    const el = waterBottleRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const fill = 1 - Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const raw = fill * WATER_LOG_MAX_ML;
    return Math.min(WATER_LOG_MAX_ML, Math.round(raw / WATER_LOG_STEP_ML) * WATER_LOG_STEP_ML);
  }, []);

  const handleBottlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setWaterDragging(true);
    setWaterSliderMl(waterMlFromPointer(e.clientY));
  };

  const handleBottlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!waterDragging) return;
    setWaterSliderMl(waterMlFromPointer(e.clientY));
  };

  // ── Save targets ──────────────────────────────────────────────────────────

  const handleSaveTargets = async () => {
    setTargetSaving(true);
    try {
      const res = await fetch("/api/nutrition/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetForm),
      });
      const { data } = await res.json();
      if (data) setCurrentTarget(data);
      setTargetsOpen(false);
    } finally {
      setTargetSaving(false);
    }
  };

  // ── AI-generate targets ───────────────────────────────────────────────────

  const handleGenerateTargets = async () => {
    setTargetGenerating(true);
    setTargetGenNote(null);
    try {
      const res = await fetch("/api/nutrition/targets/generate", { method: "POST" });
      const { targets, error } = await res.json();
      if (error) { setTargetGenNote(nt.targetsModal.errorPrefix.replace("{error}", error)); return; }
      generatedTargets.current = targets as NutritionTarget[];
      // Update form to show the day_type matching the current selection
      const match = (targets as NutritionTarget[]).find(t => t.day_type === targetForm.day_type)
        ?? (targets as NutritionTarget[])[0];
      if (match) {
        setTargetForm({
          day_type: match.day_type,
          calories: match.calories ?? 2200,
          protein_g: match.protein_g ?? 160,
          carbs_g: match.carbs_g ?? 250,
          fat_g: match.fat_g ?? 75,
          fiber_g: match.fiber_g ?? 30,
          water_ml: match.water_ml ?? 2500,
        });
        setCurrentTarget(match);
      }
      const note = match?.notes;
      setTargetGenNote(note ? nt.targetsModal.coachNote.replace("{note}", note) : nt.targetsModal.generatedSuccess);
    } finally {
      setTargetGenerating(false);
    }
  };

  // ── Keyboard shortcut (Cmd+K / Ctrl+K) ────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearch("snacks");
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setQuickOpen(false);
        setTargetsOpen(false);
        setCopyOpen(false);
        setMealBuilderOpen(false);
        setMealManagerOpen(false);
        setMealPlanOpen(false);
        setMoreMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="page" style={{ paddingBottom: 80 }}>

      {/* ── Top bar ───────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn-secondary" style={{ padding: "6px 10px" }} onClick={() => navigateDate(prevDate(date))}>‹</button>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{formatDate(date, language)}</div>
            {isToday && <div style={{ fontSize: 11, color: "var(--dim)" }}>{nt.dayNav.today}</div>}
          </div>
          <button className="btn-secondary" style={{ padding: "6px 10px" }} onClick={() => navigateDate(nextDate(date))} disabled={date >= todayISO()}>›</button>
        </div>

        {!isToday && (
          <button className="btn-soft" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => navigateDate(todayISO())}>
            {nt.dayNav.goToToday}
          </button>
        )}

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{
            fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 20,
            color: dayMeta.color, background: dayMeta.bg, border: `1px solid ${dayMeta.color}40`,
          }}>
            {dayMeta.label}
          </span>
          {currentTarget && (
            <span style={{ fontSize: 11, color: "var(--dim)" }}>
              {nt.topBar.target} <span style={{ color: "var(--accent)", fontWeight: 700 }}>{currentTarget.calories.toLocaleString(localeTag(language))} kcal</span>
            </span>
          )}
          {/* Secondary actions: inline row on desktop, collapsed behind a
              kebab menu on mobile (same dropdown-panel styling as the Copy
              day flyout below) — see .ntr-secondary-actions in globals.css. */}
          <div style={{ position: "relative" }}>
            <button
              className="btn-secondary ntr-more-btn"
              onClick={() => setMoreMenuOpen(o => !o)}
              title={nt.topBar.moreActions}
              aria-label={nt.topBar.moreActions}
              aria-expanded={moreMenuOpen}
            >
              <i className="ti ti-dots-vertical" aria-hidden="true" />
            </button>

            <div className={`ntr-secondary-actions${moreMenuOpen ? " ntr-secondary-open" : ""}`}>
              {/* Copy from previous day */}
              <div style={{ position: "relative" }}>
                <button
                  className="btn-secondary ntr-secondary-btn"
                  style={{ fontSize: 12, padding: "6px 12px", display: "flex", alignItems: "center", gap: 5 }}
                  onClick={() => setCopyOpen(o => !o)}
                  disabled={copying}
                  title={nt.topBar.copyDayTooltip}
                >
                  <i className="ti ti-copy" style={{ fontSize: 13 }} aria-hidden="true" />
                  {copying ? nt.actions.copying : nt.topBar.copyDay}
                </button>
                {copyOpen && (
                  <div style={{
                    position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 100,
                    background: "var(--surface)", border: "1px solid var(--border)",
                    borderRadius: "var(--radius)", minWidth: 200, boxShadow: "0 8px 32px rgba(0,0,0,.4)",
                    overflow: "hidden",
                  }}>
                    <div style={{ padding: "8px 14px 6px", fontSize: 10, fontWeight: 700, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".07em" }}>
                      {nt.topBar.copyFrom}
                    </div>
                    {Array.from({ length: 7 }, (_, i) => {
                      const d = new Date();
                      d.setDate(d.getDate() - (i + 1));
                      const ds = d.toISOString().split("T")[0];
                      const label = i === 0 ? nt.topBar.yesterday : i === 1 ? nt.topBar.twoDaysAgo : d.toLocaleDateString(localeTag(language), { weekday: "short", month: "short", day: "numeric" });
                      return (
                        <button
                          key={ds}
                          onClick={() => { copyFromDate(ds); setMoreMenuOpen(false); }}
                          className="ntr-search-row"
                          style={{ width: "100%", display: "flex", alignItems: "center", padding: "9px 14px", cursor: "pointer", background: "none", border: "none", color: "var(--text)", fontSize: 13, textAlign: "left", gap: 8, borderTop: "1px solid rgba(var(--overlay-rgb),.04)" }}
                        >
                          <i className="ti ti-calendar" style={{ fontSize: 13, color: "var(--dim)", flexShrink: 0 }} aria-hidden="true" />
                          {label}
                        </button>
                      );
                    })}
                    <div style={{ padding: "6px 14px 8px", fontSize: 10, color: "var(--dim)" }}>
                      {nt.topBar.waterNotCopied}
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={() => {
                  if (!mealsLoaded.current) {
                    mealsLoaded.current = true;
                    fetch("/api/nutrition/meals")
                      .then(r => r.json())
                      .then(({ meals }) => setMealTemplates(meals ?? []))
                      .catch(() => {});
                  }
                  setMealManagerOpen(true);
                  setMoreMenuOpen(false);
                }}
                className="ntr-secondary-btn"
                style={{ fontSize: 12, padding: "6px 14px", background: "rgba(var(--amber-rgb),.1)", border: "1px solid rgba(var(--amber-rgb),.3)", color: "var(--amber)", borderRadius: "var(--radius)", cursor: "pointer", fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}
              >
                <i className="ti ti-tools-kitchen-2" aria-hidden="true" style={{ fontSize: 13 }} />
                {nt.topBar.meals}
              </button>
              <button
                onClick={() => { setMealPlanOpen(true); setMoreMenuOpen(false); }}
                className="btn-secondary ntr-secondary-btn"
                style={{ fontSize: 12, padding: "6px 14px", display: "flex", alignItems: "center", gap: 5 }}
              >
                <i className="ti ti-calendar-week" aria-hidden="true" style={{ fontSize: 13 }} />
                {nt.topBar.mealPlan}
              </button>
              <button
                onClick={() => { generateMealRecommendations(1); setMoreMenuOpen(false); }}
                disabled={recsGenerating}
                title={nt.topBar.regenerateTooltip}
                className="btn-secondary ntr-secondary-btn"
                style={{ fontSize: 12, padding: "6px 14px", display: "flex", alignItems: "center", gap: 5, opacity: recsGenerating ? 0.7 : 1 }}
              >
                <i className="ti ti-brain" aria-hidden="true" style={{ fontSize: 13 }} />
                {recsGenerating ? nt.topBar.suggesting : nt.topBar.regenerateToday}
              </button>
            </div>
          </div>

          <button className="btn-primary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => openSearch("snacks")}>
            {nt.topBar.logFood}
          </button>
        </div>
      </div>

      {/* ── Week strip ────────────────────────────────────────────────── */}
      <WeekStrip
        selectedDate={date}
        onDateSelect={navigateDate}
      />

      {/* ── 3-column layout ───────────────────────────────────────────── */}
      <div className="nutrition-3col">

        {/* ── LEFT: Summary ─────────────────────────────────────────── */}
        <div className="nutrition-col-summary" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Calorie ring */}
          <div className="card" style={{ padding: 16 }}>
            <div className="card-title">{nt.calorieCard.title}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ position: "relative", display: "inline-block" }}>
                <CalRing value={totals.calories} max={calTarget || 2200} size={96} stroke={9} />
                <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", textAlign: "center", lineHeight: 1 }}>
                  <div style={{ fontSize: 11, color: "var(--dim)" }}>
                    {calTarget > 0 ? (isOverCalories ? nt.calorieCard.over : nt.calorieCard.remaining) : nt.calorieCard.logged}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: isOverCalories ? "var(--amber)" : "var(--text)", marginTop: 2 }}>
                    {calTarget > 0
                      ? (isOverCalories ? "+" : "") + (isOverCalories ? totals.calories - calTarget : remaining).toLocaleString(localeTag(language))
                      : totals.calories.toLocaleString(localeTag(language))}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--dim)" }}>kcal</div>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: "var(--dim)" }}>{nt.calorieCard.goal} </span>
                  <span style={{ fontWeight: 700 }}>{calTarget > 0 ? calTarget.toLocaleString(localeTag(language)) : "—"}</span>
                </div>
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: "var(--dim)" }}>{nt.calorieCard.loggedLabel} </span>
                  <span style={{ fontWeight: 700 }}>{totals.calories.toLocaleString(localeTag(language))}</span>
                </div>
                {calTarget > 0 && (
                  <div style={{ fontSize: 11, color: totals.calories > calTarget ? "var(--amber)" : "var(--green)", fontWeight: 700 }}>
                    {totals.calories > calTarget ? nt.calorieCard.overAmount.replace("{amount}", (totals.calories - calTarget).toLocaleString(localeTag(language))) : nt.calorieCard.onTrack}
                  </div>
                )}
                {!currentTarget && (
                  <button className="btn-soft" style={{ fontSize: 10, padding: "3px 8px", marginTop: 4 }} onClick={() => setTargetsOpen(true)}>
                    {nt.calorieCard.setTargets}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Water */}
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div className="card-title" style={{ margin: 0 }}>{nt.hydrationCard.title}</div>
              <button
                className="btn-soft"
                style={{ fontSize: 11, padding: "4px 10px" }}
                onClick={() => { setWaterSliderMl(250); setWaterLogOpen(true); }}
              >
                {nt.hydrationCard.addDrink}
              </button>
            </div>
            <div className="progress-bar" style={{ marginBottom: 8 }}>
              <div className="progress-fill" style={{ width: `${pct(waterMl, waterTarget)}%`, background: "var(--accent)" }} />
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>
                <span style={{ color: "var(--accent)", fontWeight: 700 }}>{(waterMl / 1000).toFixed(2)}L</span>
                <span style={{ color: "var(--dim)" }}> / {(waterTarget / 1000).toFixed(2)}L</span>
              </span>
              {waterEntries.length > 0 && (
                <button
                  onClick={handleRemoveWater}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--dim)", fontSize: 10, padding: 0, textDecoration: "underline" }}
                >
                  {nt.hydrationCard.undoLast}
                </button>
              )}
            </div>
          </div>

          {/* Body weight */}
          <WeightCard date={date} />

          {/* Totals summary */}
          {totals.calories > 0 && (
            <div className="card" style={{ padding: 16 }}>
              <div className="card-title">{nt.totalsCard.title}</div>
              {[
                [nt.macroLabels.sugar, totals.sugar_g, "g"],
                [nt.macroLabels.sodium, totals.sodium_mg, "mg"],
                [nt.totalsCard.satFat, totals.saturated_fat_g, "g"],
                [nt.totalsCard.cholesterol, totals.cholesterol_mg, "mg"],
              ].map(([label, val, unit]) => (
                <div key={label as string} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, paddingBottom: 6, borderBottom: "1px solid var(--border)", marginBottom: 6 }}>
                  <span style={{ color: "var(--muted)" }}>{label}</span>
                  <span style={{ fontWeight: 600 }}>{val as number > 0 ? `${val}${unit}` : "—"}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── CENTER: Meal diary ─────────────────────────────────────── */}
        <div className="nutrition-col-diary" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {loadingEntries && (
            <div style={{ textAlign: "center", padding: 40, color: "var(--dim)", fontSize: 13 }}>{nt.actions.loading}</div>
          )}

          {!loadingEntries && MEALS.map(meal => {
            const mealEntries = entries.filter(e => e.meal_type === meal.key);
            const mealCal = Math.round(mealEntries.reduce((s, e) => s + e.calories, 0));
            const mealP = round1(mealEntries.reduce((s, e) => s + (e.protein_g ?? 0), 0));
            const mealC = round1(mealEntries.reduce((s, e) => s + (e.carbs_g ?? 0), 0));
            const mealF = round1(mealEntries.reduce((s, e) => s + (e.fat_g ?? 0), 0));

            return (
              <div key={meal.key} className="card" style={{ padding: 0, overflow: "hidden" }}>
                {/* Meal header */}
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: 6, padding: "10px 14px", borderBottom: mealEntries.length > 0 ? "1px solid var(--border)" : "none" }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{meal.emoji} {meal.label}</span>
                  {mealEntries.length > 0 && (
                    <div style={{ display: "flex", gap: 5, marginLeft: 10 }}>
                      {[
                        { v: `${mealP}g`, c: "var(--accent)" },
                        { v: `${mealC}g`, c: "var(--blue)" },
                        { v: `${mealF}g`, c: "var(--amber)" },
                      ].map((p, i) => (
                        <span key={i} style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 10, background: `${p.c}18`, color: p.c }}>{p.v}</span>
                      ))}
                    </div>
                  )}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {mealCal > 0 && <span style={{ fontSize: 11, color: "var(--dim)" }}><span style={{ color: "var(--muted)", fontWeight: 600 }}>{mealCal}</span> kcal</span>}
                    <button
                      onClick={() => { setPhotoMeal(meal.key); setPhotoOpen(true); }}
                      title={nt.diary.photoAiTooltip}
                      style={{ background: "none", border: "1px solid rgba(124,92,255,.25)", borderRadius: 6, cursor: "pointer", color: "var(--accent)", fontSize: 13, padding: "3px 7px", transition: "color .12s", lineHeight: 1 }}
                    >
                      <i className="ti ti-camera" aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => { setActiveMeal(meal.key); setScannerOpen(true); setBarcodeError(null); }}
                      title={nt.diary.scanBarcodeTooltip}
                      style={{ background: "none", border: "1px solid rgba(var(--blue-rgb),.25)", borderRadius: 6, cursor: "pointer", color: "var(--blue)", fontSize: 13, padding: "3px 7px", transition: "color .12s", lineHeight: 1 }}
                    >
                      <i className="ti ti-scan" aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => openSearch(meal.key)}
                      style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", color: "var(--dim)", fontSize: 11, padding: "3px 8px", transition: "color .12s" }}
                    >
                      {nt.diary.addBtn}
                    </button>
                  </div>
                </div>

                {/* Coach recommendation — only shown before anything's logged for this slot */}
                {mealEntries.length === 0 && (() => {
                  const rec = mealRecommendations.find(r => r.meal_type === meal.key);
                  if (!rec) return null;
                  const isRecExpanded = expandedRecs.has(meal.key);
                  return (
                    <div style={{ background: "rgba(124,92,255,.06)", borderBottom: "1px solid rgba(124,92,255,.15)", padding: "8px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                        <i className="ti ti-brain" aria-hidden="true" style={{ fontSize: 12, color: "var(--accent)" }} />
                        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".05em" }}>{nt.diary.coachRecommends}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <button
                          onClick={() => setExpandedRecs(prev => {
                            const next = new Set(prev);
                            if (next.has(meal.key)) next.delete(meal.key); else next.add(meal.key);
                            return next;
                          })}
                          style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 13, padding: 0, flexShrink: 0, transform: isRecExpanded ? "rotate(90deg)" : "none", transition: "transform .15s", lineHeight: 1 }}
                          title={isRecExpanded ? nt.diary.collapseIngredients : nt.diary.expandIngredients}
                        >›</button>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{rec.name}</div>
                      </div>
                      {rec.description && (
                        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, marginLeft: 19 }}>{rec.description}</div>
                      )}
                      {isRecExpanded && (
                        <div style={{ marginTop: 6, marginLeft: 19, padding: "6px 0", borderTop: "1px solid rgba(124,92,255,.12)" }}>
                          {rec.ingredients.map((item, idx) => (
                            <div key={idx} style={{ display: "flex", alignItems: "center", padding: "4px 0", borderBottom: idx < rec.ingredients.length - 1 ? "1px solid rgba(var(--overlay-rgb),.04)" : "none", gap: 8 }}>
                              <div style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--muted)" }}>
                                {item.food_name}
                              </div>
                              <div style={{ fontSize: 10, color: "var(--dim)", flexShrink: 0 }}>{formatQty(item.quantity_g, item.serving_qty, item.serving_label)}</div>
                              <div style={{ display: "flex", gap: 8, fontSize: 10, flexShrink: 0 }}>
                                <span style={{ color: "var(--accent)" }}>{item.protein_g}g</span>
                                <span style={{ color: "var(--blue)" }}>{item.carbs_g}g</span>
                                <span style={{ color: "var(--amber)" }}>{item.fat_g}g</span>
                              </div>
                              <div style={{ fontSize: 10, fontWeight: 600, width: 32, textAlign: "right", flexShrink: 0 }}>{item.calories}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, marginLeft: 19 }}>
                        <span style={{ fontSize: 10, color: "var(--dim)" }}>
                          {rec.calories} kcal · P{rec.protein_g}g C{rec.carbs_g}g F{rec.fat_g}g
                        </span>
                        <button
                          className="btn-soft"
                          style={{ fontSize: 10, padding: "3px 10px" }}
                          onClick={() => logRecommendedMeal(rec)}
                        >
                          {nt.diary.useRecommended}
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* Food rows */}
                {mealEntries.map(entry => {
                  const isMeal = entry.meal_items && entry.meal_items.length > 0;
                  const isExpanded = expandedEntries.has(entry.id);
                  return (
                    <div key={entry.id} style={{ borderBottom: "1px solid rgba(var(--overlay-rgb),.04)" }}>
                      <div
                        className="ntr-food-row"
                        role="button"
                        tabIndex={0}
                        onClick={() => setNutrientModalEntry(diaryEntryToNutrientEntry(entry))}
                        onKeyDown={e => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setNutrientModalEntry(diaryEntryToNutrientEntry(entry));
                          }
                        }}
                        style={{ display: "flex", alignItems: "center", padding: "8px 14px", cursor: "pointer" }}
                      >
                        {/* Expand toggle for meal entries */}
                        {isMeal ? (
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              setExpandedEntries(prev => {
                                const next = new Set(prev);
                                if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                                return next;
                              });
                            }}
                            style={{ background: "none", border: "none", color: "var(--amber)", cursor: "pointer", fontSize: 13, padding: "0 4px 0 0", flexShrink: 0, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform .15s", lineHeight: 1 }}
                            title={isExpanded ? nt.diary.collapseIngredients : nt.diary.expandIngredients}
                          >›</button>
                        ) : <div style={{ width: 14 }} />}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
                            {isMeal && <i className="ti ti-tools-kitchen-2" style={{ fontSize: 11, flexShrink: 0, marginTop: 2 }} aria-hidden="true" />}
                            <div style={{ fontSize: 12, fontWeight: 600, color: isMeal ? "var(--amber)" : "var(--text)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-word" }}>
                              {entry.food_name}
                            </div>
                          </div>
                          <div style={{ fontSize: 10, color: "var(--dim)" }}>
                            {isMeal ? `${nt.mealManager.ingredientsCountPlain.replace("{count}", String(entry.meal_items!.length))} · ${formatQty(entry.quantity_g, entry.serving_qty, entry.serving_label)}` : `${formatQty(entry.quantity_g, entry.serving_qty, entry.serving_label)}${entry.brand ? ` · ${entry.brand}` : ""}`}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", marginLeft: 10 }}>
                          <div style={{ fontSize: 10, color: "var(--dim)", textAlign: "right" }}>
                            P<span style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--accent)" }}>{entry.protein_g}g</span>
                          </div>
                          <div style={{ fontSize: 10, color: "var(--dim)", textAlign: "right" }}>
                            C<span style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--blue)" }}>{entry.carbs_g}g</span>
                          </div>
                          <div style={{ fontSize: 10, color: "var(--dim)", textAlign: "right" }}>
                            F<span style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--amber)" }}>{entry.fat_g}g</span>
                          </div>
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", width: 38, textAlign: "right", marginLeft: 8 }}>
                          {entry.calories}
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); handleDelete(entry.id); }}
                          className="ntr-del-btn"
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--dim)", fontSize: 14, padding: "0 0 0 8px", lineHeight: 1, opacity: 0 }}
                        >✕</button>
                      </div>
                      {/* Expanded ingredient list */}
                      {isMeal && isExpanded && (
                        <div style={{ background: "rgba(var(--amber-rgb),.04)", borderTop: "1px solid rgba(var(--amber-rgb),.1)", padding: "6px 14px 8px 32px" }}>
                          {entry.meal_items!.map((item, idx) => (
                            <div
                              key={idx}
                              role="button"
                              tabIndex={0}
                              onClick={() => setNutrientModalEntry(mealItemToNutrientEntry(item))}
                              onKeyDown={e => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setNutrientModalEntry(mealItemToNutrientEntry(item));
                                }
                              }}
                              style={{ display: "flex", alignItems: "flex-start", padding: "4px 0", borderBottom: idx < entry.meal_items!.length - 1 ? "1px solid rgba(var(--overlay-rgb),.04)" : "none", gap: 8, cursor: "pointer" }}
                            >
                              <div style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 500, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-word", color: "var(--muted)" }}>
                                {item.food_name}
                              </div>
                              <div style={{ fontSize: 10, color: "var(--dim)", flexShrink: 0 }}>{formatQty(item.quantity_g, item.serving_qty, item.serving_label)}</div>
                              <div style={{ display: "flex", gap: 8, fontSize: 10, flexShrink: 0 }}>
                                <span style={{ color: "var(--accent)" }}>{item.protein_g}g</span>
                                <span style={{ color: "var(--blue)" }}>{item.carbs_g}g</span>
                                <span style={{ color: "var(--amber)" }}>{item.fat_g}g</span>
                              </div>
                              <div style={{ fontSize: 10, fontWeight: 600, width: 32, textAlign: "right", flexShrink: 0 }}>{item.calories}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Quick add row */}
                <div
                  onClick={() => openQuickAdd(meal.key)}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", cursor: "pointer", color: "var(--dim)", fontSize: 11 }}
                  className="ntr-quick-row"
                >
                  <div style={{ width: 16, height: 16, borderRadius: 4, border: "1px dashed currentColor", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>+</div>
                  {nt.diary.quickAddRow}
                </div>

                {/* Meal totals */}
                {mealEntries.length > 0 && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderTop: "1px solid var(--border)" }}>
                    {[
                      { label: nt.macroLabels.cal, val: mealCal, unit: "" },
                      { label: nt.macroLabels.protein, val: mealP, unit: "g", color: "var(--accent)" },
                      { label: nt.macroLabels.carbs,  val: mealC, unit: "g", color: "var(--blue)" },
                      { label: nt.macroLabels.fat,    val: mealF, unit: "g", color: "var(--amber)" },
                    ].map(cell => (
                      <div key={cell.label} style={{ padding: "7px 14px", textAlign: "center", borderRight: "1px solid var(--border)" }}>
                        <div style={{ fontSize: 9, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{cell.label}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: (cell as {color?: string}).color ?? "var(--text)" }}>{cell.val}{cell.unit}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── RIGHT: Micronutrients ──────────────────────────────────── */}
        <div className="nutrition-col-micro" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Score pills */}
          {totals.calories > 0 && (() => {
            const protScore = calTarget > 0 ? Math.min(100, Math.round(pct(totals.protein_g, (currentTarget?.protein_g ?? 150)))) : null;
            const microCount = MICRO_GROUPS.flatMap(g => g.items).filter(({ key }) => {
              const rda = RDA[key];
              const val = totals[key as keyof typeof totals] as number;
              return rda && val > 0 && val >= rda * 0.8;
            }).length;
            const microScore = Math.round((microCount / 22) * 100);
            return (
              <div className="card" style={{ padding: 14 }}>
                <div className="card-title">{nt.daySummary.title}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
                  {[
                    { label: nt.macroLabels.protein, score: protScore, color: "var(--accent)" },
                    { label: nt.daySummary.micros,  score: microScore, color: "var(--blue)" },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign: "center", background: "rgba(var(--overlay-rgb),.04)", borderRadius: 8, padding: "10px 6px" }}>
                      <div style={{
                        fontSize: 20, fontWeight: 800,
                        color: s.score == null ? "var(--dim)" : s.score >= 80 ? "var(--green)" : s.score >= 50 ? "var(--amber)" : "var(--red)",
                      }}>
                        {s.score ?? "—"}
                      </div>
                      <div style={{ fontSize: 9, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".06em", marginTop: 2 }}>{s.label}</div>
                    </div>
                  ))}
                </div>

                {/* Pre/post-workout timing — only meaningful once the day is over */}
                {isPastDay && dayType !== "rest" && (() => {
                  const { preStatus, postStatus, preP, preC, postP, preCal, postCal } = workoutNutrition;
                  const colors: Record<string, string> = { ok: "var(--green)", low: "var(--amber)", empty: "var(--dim)" };
                  const icons:  Record<string, string> = { ok: "ti-circle-check", low: "ti-alert-triangle", empty: "ti-circle-dashed" };
                  return (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                      <div style={{ fontSize: 9, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>
                        {nt.daySummary.workoutNutrition}
                      </div>
                      {(["pre", "post"] as const).map(w => {
                        const isPost   = w === "post";
                        const status   = isPost ? postStatus : preStatus;
                        const proteinG = isPost ? postP : preP;
                        const cal      = isPost ? postCal : preCal;
                        const label    = isPost ? nt.daySummary.postWorkout : nt.daySummary.preWorkout;
                        return (
                          <div key={w} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: isPost ? 0 : 5 }}>
                            <i className={`ti ${icons[status]}`} aria-hidden="true" style={{ fontSize: 13, color: colors[status], flexShrink: 0 }} />
                            <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>{label}</span>
                            <span style={{ fontSize: 10, color: status === "empty" ? "var(--dim)" : "var(--muted)" }}>
                              {status === "empty" ? nt.daySummary.notLogged : `P${proteinG}g${!isPost ? ` C${preC}g` : ""} · ${cal} kcal`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                <DayEnergyBalance date={date} caloriesEaten={totals.calories} />
              </div>
            );
          })()}

          {/* Macros */}
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div className="card-title" style={{ margin: 0 }}>{nt.macrosCard.title}</div>
              {currentTarget && (
                <button style={{ background: "none", border: "none", cursor: "pointer", color: "var(--dim)", fontSize: 11 }} onClick={() => setTargetsOpen(true)}>
                  {nt.actions.edit}
                </button>
              )}
            </div>

            {/* Macro pills */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 14 }}>
              {[
                { label: nt.macrosCard.pillProtein, val: totals.protein_g, color: "var(--accent)" },
                { label: nt.macrosCard.pillCarbs, val: totals.carbs_g,   color: "var(--blue)" },
                { label: nt.macrosCard.pillFat, val: totals.fat_g,     color: "var(--amber)" },
              ].map(m => (
                <div key={m.label} style={{ textAlign: "center", background: "rgba(var(--overlay-rgb),.04)", borderRadius: 8, padding: "8px 4px" }}>
                  <div style={{ fontSize: 10, color: "var(--dim)", marginBottom: 2 }}>{m.label}</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: m.color }}>{m.val}</div>
                  <div style={{ fontSize: 9, color: "var(--dim)" }}>g</div>
                </div>
              ))}
            </div>

            <MacroBar
              label={nt.macroLabels.protein} value={totals.protein_g}
              max={currentTarget?.protein_g ?? Math.max(1, Math.round(totals.protein_g * 1.2))}
              color="var(--accent)"
            />
            <MacroBar
              label={nt.macroLabels.carbs} value={totals.carbs_g}
              max={currentTarget?.carbs_g ?? Math.max(1, Math.round(totals.carbs_g * 1.2))}
              color="var(--blue)"
            />
            <MacroBar
              label={nt.macroLabels.fat} value={totals.fat_g}
              max={currentTarget?.fat_g ?? Math.max(1, Math.round(totals.fat_g * 1.2))}
              color="var(--amber)"
            />
            <MacroBar
              label={nt.macroLabels.fiber} value={totals.fiber_g}
              max={currentTarget?.fiber_g ?? 30}
              color="var(--green)"
            />
          </div>

          {/* Micronutrients */}
          <div className="card" style={{ padding: 14 }}>
            <div className="card-title">{nt.micronutrients.title}</div>
            {totals.calories === 0 ? (
              <div style={{ fontSize: 12, color: "var(--dim)", textAlign: "center", padding: "16px 0" }}>
                {nt.micronutrients.emptyState}
              </div>
            ) : (
              MICRO_GROUPS.map(group => (
                <div key={group.label} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--dim)", marginBottom: 8 }}>
                    {group.label}
                  </div>
                  {group.items.map(({ key, label, unit }) => {
                    const val = round1((totals[key as keyof typeof totals] as number) ?? 0);
                    const rda = RDA[key] ?? 100;
                    return (
                      <MicroRow key={key} label={label} value={val} rda={rda} unit={unit} />
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ── Food search modal ──────────────────────────────────────────── */}
      {searchOpen && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 200,
            background: "rgba(0,0,0,.70)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            paddingTop: 80,
          }}
          onClick={e => { if (e.target === e.currentTarget) setSearchOpen(false); }}
        >
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
            width: "100%", maxWidth: 620, maxHeight: "calc(100vh - 120px)",
            display: "flex", flexDirection: "column", overflow: "hidden",
          }}>
            {/* Modal header */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--dim)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".06em" }}>
                  {nt.searchModal.addTo.replace("{meal}", MEALS.find(m => m.key === activeMeal)?.label ?? "")}
                </div>
                <input
                  ref={searchInputRef}
                  className="input"
                  placeholder={nt.searchModal.searchPlaceholder}
                  value={searchQuery}
                  onChange={e => handleSearch(e.target.value)}
                  style={{ fontSize: 14 }}
                />
              </div>
              <button
                onClick={() => { setSearchOpen(false); setPhotoMeal(activeMeal); setPhotoOpen(true); }}
                title={nt.diary.photoAiTooltip}
                style={{
                  background: "rgba(124,92,255,.1)", border: "1px solid rgba(124,92,255,.3)",
                  color: "var(--accent)", borderRadius: 8, cursor: "pointer",
                  padding: "9px 12px", lineHeight: 1, flexShrink: 0,
                  display: "flex", alignItems: "center", gap: 5,
                }}
              >
                <i className="ti ti-camera" aria-hidden="true" style={{ fontSize: 16 }} />
                <span style={{ fontSize: 11, fontWeight: 700 }}>{nt.searchModal.aiLabel}</span>
              </button>
              <button
                onClick={() => { setSearchOpen(false); setScannerOpen(true); setBarcodeError(null); }}
                title={nt.diary.scanBarcodeTooltip}
                style={{
                  background: "rgba(var(--blue-rgb),.1)", border: "1px solid rgba(var(--blue-rgb),.3)",
                  color: "var(--blue)", borderRadius: 8, cursor: "pointer",
                  padding: "9px 13px", lineHeight: 1, flexShrink: 0,
                  display: "flex", alignItems: "center",
                }}
              >
                <i className="ti ti-scan" aria-hidden="true" style={{ fontSize: 16 }} />
              </button>
              <button
                onClick={() => { setSearchOpen(false); setMealManagerOpen(true); }}
                title={nt.searchModal.viewSavedMealsTooltip}
                style={{
                  background: "rgba(var(--amber-rgb),.1)", border: "1px solid rgba(var(--amber-rgb),.3)",
                  color: "var(--amber)", borderRadius: 8, cursor: "pointer",
                  padding: "9px 12px", lineHeight: 1, flexShrink: 0,
                  display: "flex", alignItems: "center", gap: 4,
                }}
              >
                <i className="ti ti-tools-kitchen-2" aria-hidden="true" style={{ fontSize: 14 }} />
                <span style={{ fontSize: 10, fontWeight: 700 }}>{nt.searchModal.mealLabel}</span>
              </button>
              <button
                onClick={() => { setEditingCustomFood(null); setCustomFoodModalOpen(true); }}
                title={nt.searchModal.createCustomFoodTooltip}
                style={{
                  background: "rgba(var(--green-rgb),.1)", border: "1px solid rgba(var(--green-rgb),.3)",
                  color: "var(--green)", borderRadius: 8, cursor: "pointer",
                  padding: "9px 12px", lineHeight: 1, flexShrink: 0,
                  display: "flex", alignItems: "center", gap: 4,
                }}
              >
                <i className="ti ti-plus" aria-hidden="true" style={{ fontSize: 14 }} />
                <span style={{ fontSize: 10, fontWeight: 700 }}>{nt.searchModal.foodLabel}</span>
              </button>
              <button
                onClick={() => setSearchOpen(false)}
                style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer", color: "var(--muted)", padding: "8px 12px", fontSize: 13, flexShrink: 0 }}
              >
                ✕
              </button>
            </div>

            {/* Barcode error banner */}
            {barcodeError && (
              <div style={{ padding: "10px 20px", background: "rgba(var(--red-rgb),.08)", borderBottom: "1px solid rgba(var(--red-rgb),.2)", fontSize: 12, color: "var(--red)", display: "flex", gap: 8, alignItems: "center" }}>
                <span>⚠</span>
                <span style={{ flex: 1 }}>{barcodeError}</span>
                <button onClick={() => setBarcodeError(null)} style={{ background: "none", border: "none", color: "var(--dim)", cursor: "pointer", fontSize: 14 }}>✕</button>
              </div>
            )}

            {/* Search results or food detail */}
            <div style={{ flex: 1, overflow: "auto" }}>
              {selectedFood ? (
                <div style={{ padding: 20 }}>
                  <button
                    onClick={() => setSelectedFood(null)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 12, marginBottom: 14, padding: 0 }}
                  >
                    {nt.searchModal.backToResults}
                  </button>

                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 2 }}>{selectedFood.description}</div>
                    {selectedFood.brand && <div style={{ fontSize: 12, color: "var(--dim)" }}>{selectedFood.brand}</div>}
                  </div>

                  {/* Serving size input */}
                  <div style={{ marginBottom: 20 }}>
                    <label className="field-label">{nt.searchModal.quantity}</label>
                    <QuantityInput
                      key={selectedFood.fdcId || selectedFood.customFoodId || selectedFood.description}
                      initialGrams={addQty}
                      portions={selectedFood.portions ?? []}
                      loading={portionsLoading}
                      onChange={(g, sQty, sLabel) => { setAddQty(g); setAddServingQty(sQty); setAddServingLabel(sLabel); }}
                    />
                  </div>

                  {/* Nutrition preview (scaled) */}
                  <div style={{ background: "rgba(var(--overlay-rgb),.04)", borderRadius: 10, padding: 14, marginBottom: 20 }}>
                    <div style={{ fontSize: 11, color: "var(--dim)", marginBottom: 10 }}>{nt.searchModal.nutritionFor.replace("{qty}", String(addQty))}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 12 }}>
                      {[
                        { label: nt.macroLabels.cal,     val: Math.round(selectedFood.calories * addQty / 100),    unit: "",  color: "var(--text)" },
                        { label: nt.macroLabels.protein, val: round1(selectedFood.protein * addQty / 100),          unit: "g", color: "var(--accent)" },
                        { label: nt.macroLabels.carbs,   val: round1(selectedFood.carbs   * addQty / 100),          unit: "g", color: "var(--blue)" },
                        { label: nt.macroLabels.fat,     val: round1(selectedFood.fat     * addQty / 100),          unit: "g", color: "var(--amber)" },
                      ].map(m => (
                        <div key={m.label} style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 18, fontWeight: 800, color: m.color }}>{m.val}</div>
                          <div style={{ fontSize: 9, color: "var(--dim)" }}>{m.label}{m.unit}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                      {[
                        { label: nt.macroLabels.fiber,  val: round1(selectedFood.fiber * addQty / 100), unit: "g" },
                        { label: nt.macroLabels.sugar,  val: round1(selectedFood.sugar * addQty / 100), unit: "g" },
                        { label: nt.macroLabels.sodium, val: Math.round(selectedFood.sodium * addQty / 100), unit: "mg" },
                      ].map(m => (
                        <div key={m.label} style={{ fontSize: 11, color: "var(--muted)" }}>
                          {m.label}: <span style={{ color: "var(--text)" }}>{m.val}{m.unit}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <button
                    className="btn-primary"
                    style={{ width: "100%" }}
                    disabled={addingFood || addQty <= 0}
                    onClick={() => handleAddFood(selectedFood, activeMeal, addQty, addServingQty, addServingLabel)}
                  >
                    {addingFood
                      ? nt.actions.adding
                      : nt.searchModal.addQtyTo
                          .replace("{qty}", formatQty(addQty, addServingQty, addServingLabel))
                          .replace("{meal}", MEALS.find(m => m.key === activeMeal)?.label ?? "")}
                  </button>
                  {selectedFood?.isCustom && selectedFood.customFoodId && (
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                      <button className="btn-secondary" style={{ flex: 1, fontSize: 12 }}
                        onClick={() => {
                          const cf = customFoods.find(f => f.id === selectedFood.customFoodId);
                          if (cf) { setEditingCustomFood(cf); setCustomFoodModalOpen(true); }
                        }}
                      >
                        <i className="ti ti-edit" style={{ marginRight: 5 }} aria-hidden="true" />{nt.searchModal.editFood}
                      </button>
                      <button className="btn-secondary" style={{ fontSize: 12, color: "var(--red)", borderColor: "rgba(var(--red-rgb),.3)" }}
                        onClick={() => selectedFood.customFoodId && deleteCustomFood(selectedFood.customFoodId)}
                      >
                        <i className="ti ti-trash" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {searchQuery.length === 0 && (
                    <div>
                      {recentLoading ? (
                        <div style={{ padding: 24, textAlign: "center", color: "var(--dim)", fontSize: 12 }}>{nt.searchModal.loadingRecent}</div>
                      ) : recentFoods.length > 0 ? (
                        <>
                          <div style={{ padding: "10px 20px 6px", fontSize: 10, fontWeight: 700, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".07em", display: "flex", alignItems: "center", gap: 6 }}>
                            <i className="ti ti-history" style={{ fontSize: 12 }} aria-hidden="true" />
                            {nt.searchModal.recentFoods}
                          </div>
                          {recentFoods.map((food, i) => {
                            const daysAgo = daysSince(food.date);
                            const dateLabel = daysAgo === 0 ? nt.dayNav.today : daysAgo === 1 ? nt.topBar.yesterday : daysAgo <= 6 ? nt.searchModal.daysAgoShort.replace("{n}", String(daysAgo)) : new Date(food.date).toLocaleDateString(localeTag(language), { month: "short", day: "numeric" });
                            return (
                              <div
                                key={i}
                                className="ntr-search-row"
                                style={{ display: "flex", alignItems: "center", padding: "9px 20px", cursor: "pointer", borderBottom: "1px solid rgba(var(--overlay-rgb),.04)", gap: 10 }}
                                onClick={() => openRecentFoodDetail(food)}
                              >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {food.food_name}
                                  </div>
                                  <div style={{ fontSize: 11, color: "var(--dim)", display: "flex", gap: 6, alignItems: "center" }}>
                                    <span>{dateLabel}</span>
                                    {food.use_count > 1 && <span style={{ color: "var(--accent)", fontWeight: 700 }}>{food.use_count}×</span>}
                                    <span>·</span>
                                    <span>{formatQty(food.quantity_g, food.serving_qty, food.serving_label)}</span>
                                  </div>
                                </div>
                                <div style={{ display: "flex", gap: 8, fontSize: 11, flexShrink: 0 }}>
                                  <span style={{ color: "var(--text)", fontWeight: 700 }}>{food.calories} kcal</span>
                                  <span style={{ color: "var(--accent)" }}>P{round1(food.protein_g)}g</span>
                                  <span style={{ color: "var(--blue)" }}>C{round1(food.carbs_g)}g</span>
                                  <span style={{ color: "var(--amber)" }}>F{round1(food.fat_g)}g</span>
                                </div>
                                <button
                                  onClick={e => { e.stopPropagation(); logRecentFood(food); }}
                                  disabled={addingFood}
                                  title={nt.searchModal.logQtyTo
                                    .replace("{qty}", formatQty(food.quantity_g, food.serving_qty, food.serving_label))
                                    .replace("{meal}", MEALS.find(m => m.key === activeMeal)?.label ?? "")}
                                  style={{
                                    background: "rgba(124,92,255,.12)", border: "1px solid rgba(124,92,255,.3)",
                                    color: "var(--accent)", borderRadius: 7, width: 28, height: 28,
                                    cursor: "pointer", fontSize: 16, lineHeight: 1, flexShrink: 0,
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                  }}
                                >
                                  +
                                </button>
                              </div>
                            );
                          })}
                          {customFoods.length > 0 && (
                            <>
                              <div style={{ padding: "10px 20px 4px", fontSize: 10, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".07em", borderTop: "1px solid var(--border)" }}>
                                {nt.searchModal.myFoods}
                              </div>
                              {customFoods.slice(0, 5).map(food => (
                                <div key={food.id} className="ntr-search-row"
                                  style={{ display: "flex", alignItems: "center", padding: "9px 20px", cursor: "pointer", borderBottom: "1px solid rgba(var(--overlay-rgb),.04)", gap: 8 }}
                                  onClick={() => selectSearchResult(customToUSDA(food))}
                                >
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{food.name}</div>
                                    <div style={{ fontSize: 11, color: "var(--dim)" }}>{food.brand ?? nt.searchModal.customFallback} · {nt.searchModal.servingSuffix.replace("{qty}", String(food.serving_size_g))}</div>
                                  </div>
                                  <div style={{ fontSize: 11, flexShrink: 0, display: "flex", gap: 6 }}>
                                    <span style={{ color: "var(--text)", fontWeight: 700 }}>{food.calories_per_100g} kcal</span>
                                    <span style={{ color: "var(--accent)" }}>P{food.protein_per_100g}g</span>
                                  </div>
                                  <button onClick={e => { e.stopPropagation(); setEditingCustomFood(food); setCustomFoodModalOpen(true); }}
                                    style={{ background: "none", border: "none", color: "var(--dim)", cursor: "pointer", fontSize: 16, padding: "0 2px", flexShrink: 0 }} title={nt.actions.edit}>⋮</button>
                                </div>
                              ))}
                            </>
                          )}
                          <div style={{ padding: "10px 20px", fontSize: 11, color: "var(--dim)", textAlign: "center" }}>
                            {nt.searchModal.typeToSearchHint}
                          </div>
                        </>
                      ) : (
                        <div style={{ padding: 32, textAlign: "center", color: "var(--dim)", fontSize: 13 }}>
                          <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
                          {nt.searchModal.typeToSearchEmpty}
                          <div style={{ fontSize: 11, marginTop: 6 }}>{nt.searchModal.emptyStateDetail}</div>
                        </div>
                      )}
                    </div>
                  )}
                  {/* ── My Foods (custom) matching the query ─────────── */}
                  {searchQuery.length > 0 && (() => {
                    const q = searchQuery.toLowerCase();
                    const matches = customFoods.filter(f =>
                      f.name.toLowerCase().includes(q) || f.brand?.toLowerCase().includes(q)
                    );
                    if (!matches.length) return null;
                    return (
                      <>
                        <div style={{ padding: "10px 20px 4px", fontSize: 10, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".07em" }}>
                          {nt.searchModal.myFoods}
                        </div>
                        {matches.map(food => (
                          <div key={food.id} className="ntr-search-row"
                            style={{ display: "flex", alignItems: "center", padding: "10px 20px", cursor: "pointer", borderBottom: "1px solid rgba(var(--overlay-rgb),.04)", gap: 8 }}
                            onClick={() => { setSelectedFood(customToUSDA(food)); setAddQty(food.serving_size_g); }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{food.name}</div>
                              <div style={{ fontSize: 11, color: "var(--dim)" }}>{food.brand ?? nt.searchModal.customFallback} · {nt.searchModal.servingSuffix.replace("{qty}", String(food.serving_size_g))}</div>
                            </div>
                            <div style={{ display: "flex", gap: 8, fontSize: 11, flexShrink: 0 }}>
                              <span style={{ color: "var(--text)", fontWeight: 700 }}>{food.calories_per_100g} kcal</span>
                              <span style={{ color: "var(--accent)" }}>P{food.protein_per_100g}g</span>
                              <span style={{ color: "var(--blue)" }}>C{food.carbs_per_100g}g</span>
                              <span style={{ color: "var(--amber)" }}>F{food.fat_per_100g}g</span>
                              <span style={{ color: "var(--dim)" }}>/ 100g</span>
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); setEditingCustomFood(food); setCustomFoodModalOpen(true); }}
                              style={{ background: "none", border: "none", color: "var(--dim)", cursor: "pointer", fontSize: 16, padding: "0 2px", flexShrink: 0 }}
                              title={nt.actions.edit}
                            >⋮</button>
                          </div>
                        ))}
                        {searchResults.length > 0 && (
                          <div style={{ padding: "6px 20px 4px", fontSize: 10, fontWeight: 700, color: "var(--dim)", textTransform: "uppercase", letterSpacing: ".07em", borderTop: "1px solid var(--border)" }}>
                            {nt.searchModal.searchResultsHeader}
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {searchLoading && (
                    <div style={{ padding: 32, textAlign: "center", color: "var(--dim)", fontSize: 13 }}>{nt.actions.searching}</div>
                  )}
                  {!searchLoading && searchQuery.length > 0 && searchResults.length === 0 && (() => {
                    const q = searchQuery.toLowerCase();
                    const hasCustom = customFoods.some(f => f.name.toLowerCase().includes(q) || f.brand?.toLowerCase().includes(q));
                    if (hasCustom) return null;
                    return (
                      <div style={{ padding: 32, textAlign: "center", color: "var(--dim)", fontSize: 13 }}>
                        {nt.searchModal.noResults.replace("{query}", searchQuery)}
                        <div style={{ marginTop: 10 }}>
                          <button className="btn-soft" style={{ fontSize: 12 }} onClick={() => { setCustomFoodModalOpen(true); setEditingCustomFood(null); }}>
                            {nt.searchModal.createAsCustom.replace("{query}", searchQuery)}
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                  {searchResults.map((food, idx) => (
                    <div
                      key={food.fdcId ? `usda-${food.fdcId}` : `off-${idx}`}
                      onClick={() => selectSearchResult(food)}
                      className="ntr-search-row"
                      style={{ display: "flex", alignItems: "center", padding: "10px 20px", cursor: "pointer", borderBottom: "1px solid rgba(var(--overlay-rgb),.04)" }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {food.description}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--dim)" }}>
                          {food.brand ?? food.category ?? nt.searchModal.genericCategory}
                          {food.servingLabel ? ` · ${food.servingLabel}` : ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, marginLeft: 12, fontSize: 11, flexShrink: 0 }}>
                        <span style={{ color: "var(--text)", fontWeight: 700 }}>{food.calories} kcal</span>
                        <span style={{ color: "var(--accent)" }}>P{food.protein}g</span>
                        <span style={{ color: "var(--blue)" }}>C{food.carbs}g</span>
                        <span style={{ color: "var(--amber)" }}>F{food.fat}g</span>
                        <span style={{ color: "var(--dim)" }}>/ 100g</span>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Quick add modal ────────────────────────────────────────────── */}
      {quickOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.70)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setQuickOpen(false); }}
        >
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", width: "100%", maxWidth: 400, padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 18 }}>
              {nt.quickAddModal.title.replace("{meal}", MEALS.find(m => m.key === quickMeal)?.label ?? "")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="field">
                <label className="field-label">{nt.quickAddModal.foodName}</label>
                <input className="input" value={quickForm.name} onChange={e => setQuickForm(p => ({ ...p, name: e.target.value }))} placeholder={nt.quickAddModal.foodNamePlaceholder} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                {[
                  { key: "calories", label: nt.macroLabels.calories, unit: "kcal" },
                  { key: "protein",  label: nt.macroLabels.protein,  unit: "g" },
                  { key: "carbs",    label: nt.macroLabels.carbs,    unit: "g" },
                  { key: "fat",      label: nt.macroLabels.fat,      unit: "g" },
                ].map(f => (
                  <div className="field" key={f.key}>
                    <label className="field-label">{f.label}</label>
                    <input
                      type="number" className="input" min={0}
                      value={quickForm[f.key as keyof typeof quickForm]}
                      onChange={e => setQuickForm(p => ({ ...p, [f.key]: Number(e.target.value) }))}
                      placeholder={f.unit}
                    />
                  </div>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
                <div className="field">
                  <label className="field-label">{nt.quickAddModal.qtyOptional}</label>
                  <input
                    type="number" className="input" min={0} step={0.5}
                    value={quickForm.servingQty}
                    onChange={e => setQuickForm(p => ({ ...p, servingQty: e.target.value }))}
                    placeholder={nt.quickAddModal.qtyPlaceholder}
                  />
                </div>
                <div className="field">
                  <label className="field-label">{nt.quickAddModal.unitOptional}</label>
                  <input
                    className="input"
                    value={quickForm.servingLabel}
                    onChange={e => setQuickForm(p => ({ ...p, servingLabel: e.target.value }))}
                    placeholder={nt.quickAddModal.unitPlaceholder}
                  />
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setQuickOpen(false)}>{nt.actions.cancel}</button>
              <button className="btn-primary" style={{ flex: 1 }} disabled={!quickForm.name || addingFood} onClick={handleQuickAdd}>
                {addingFood ? nt.actions.adding : nt.actions.add}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Water log modal ────────────────────────────────────────────── */}
      {waterLogOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.70)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setWaterLogOpen(false); }}
        >
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", width: "100%", maxWidth: 340, padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 18 }}>{nt.waterModal.title}</div>

            <div style={{ display: "flex", gap: 20, alignItems: "center", justifyContent: "center" }}>
              {/* Drag-to-fill bottle gauge */}
              <div
                ref={waterBottleRef}
                onPointerDown={handleBottlePointerDown}
                onPointerMove={handleBottlePointerMove}
                onPointerUp={() => setWaterDragging(false)}
                style={{
                  position: "relative", width: 84, height: 220, borderRadius: 16,
                  border: "2px solid var(--border)", overflow: "hidden",
                  background: "rgba(var(--overlay-rgb),.04)", cursor: "ns-resize", touchAction: "none",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    position: "absolute", bottom: 0, left: 0, right: 0,
                    height: `${pct(waterSliderMl, WATER_LOG_MAX_ML)}%`,
                    background: "linear-gradient(180deg, rgba(var(--accent-rgb),.85), rgba(var(--accent-rgb),.55))",
                    transition: waterDragging ? "none" : "height .15s ease",
                  }}
                />
                {/* Quarter-litre gridlines */}
                {[0.25, 0.5, 0.75].map(f => (
                  <div key={f} style={{ position: "absolute", left: 0, right: 0, bottom: `${f * 100}%`, height: 1, background: "rgba(var(--overlay-rgb),.12)" }} />
                ))}
              </div>

              {/* Live readout + slider */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 26, fontWeight: 800, textAlign: "center", marginBottom: 10, color: "var(--text)" }}>
                  {waterSliderMl}
                  <span style={{ fontSize: 12, fontWeight: 500, color: "var(--dim)", marginLeft: 3 }}>ml</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={WATER_LOG_MAX_ML}
                  step={WATER_LOG_STEP_ML}
                  value={waterSliderMl}
                  onChange={e => setWaterSliderMl(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--dim)", marginTop: 2 }}>
                  <span>0ml</span>
                  <span>{(WATER_LOG_MAX_ML / 1000).toFixed(1)}L</span>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setWaterLogOpen(false)}>{nt.actions.cancel}</button>
              <button
                className="btn-primary"
                style={{ flex: 1 }}
                disabled={waterSliderMl <= 0 || addingWater}
                onClick={() => handleLogWater(waterSliderMl)}
              >
                {addingWater ? nt.actions.logging : nt.waterModal.logAmount.replace("{amount}", String(waterSliderMl))}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Targets modal ─────────────────────────────────────────────── */}
      {targetsOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.70)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setTargetsOpen(false); }}
        >
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", width: "100%", maxWidth: 460, padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{nt.targetsModal.title}</div>
              <button
                onClick={handleGenerateTargets}
                disabled={targetGenerating}
                style={{ background: "rgba(124,92,255,.12)", border: "1px solid rgba(124,92,255,.35)", color: "var(--accent)", borderRadius: 8, cursor: "pointer", padding: "6px 12px", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", gap: 5, flexShrink: 0, opacity: targetGenerating ? 0.7 : 1 }}
              >
                <i className="ti ti-sparkles" aria-hidden="true" style={{ fontSize: 13 }} />
                {targetGenerating ? nt.actions.generating : nt.targetsModal.generateWithAi}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: targetGenNote ? 10 : 20 }}>{nt.targetsModal.subtitle}</div>
            {targetGenNote && (
              <div style={{ fontSize: 11, background: "rgba(124,92,255,.08)", border: "1px solid rgba(124,92,255,.2)", borderRadius: 8, padding: "8px 12px", color: "var(--accent)", marginBottom: 16, lineHeight: 1.5 }}>
                <i className="ti ti-brain" aria-hidden="true" style={{ marginRight: 5 }} />
                {targetGenNote}
              </div>
            )}

            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">{nt.targetsModal.dayType}</label>
              <select className="select-input" value={targetForm.day_type} onChange={e => {
                const dt = e.target.value;
                const gen = generatedTargets.current.find(t => t.day_type === dt);
                if (gen) {
                  setTargetForm({ day_type: dt, calories: gen.calories ?? 2200, protein_g: gen.protein_g ?? 160, carbs_g: gen.carbs_g ?? 250, fat_g: gen.fat_g ?? 75, fiber_g: gen.fiber_g ?? 30, water_ml: gen.water_ml ?? 2500 });
                  setTargetGenNote(gen.notes ? nt.targetsModal.coachNote.replace("{note}", gen.notes) : null);
                } else {
                  setTargetForm(p => ({ ...p, day_type: dt }));
                  setTargetGenNote(null);
                }
              }}>
                <option value="default">{nt.targetsModal.dayTypeOptions.default}</option>
                <option value="hard">{nt.targetsModal.dayTypeOptions.hard}</option>
                <option value="easy">{nt.targetsModal.dayTypeOptions.easy}</option>
                <option value="rest">{nt.targetsModal.dayTypeOptions.rest}</option>
                <option value="race">{nt.targetsModal.dayTypeOptions.race}</option>
              </select>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 14 }}>
              {[
                { key: "calories", label: nt.macroLabels.calories, unit: "kcal" },
                { key: "protein_g", label: nt.macroLabels.protein, unit: "g" },
                { key: "carbs_g", label: nt.macroLabels.carbs, unit: "g" },
                { key: "fat_g", label: nt.macroLabels.fat, unit: "g" },
                { key: "fiber_g", label: nt.macroLabels.fiber, unit: "g" },
                { key: "water_ml", label: nt.targetsModal.water, unit: "ml" },
              ].map(f => (
                <div className="field" key={f.key}>
                  <label className="field-label">{f.label} ({f.unit})</label>
                  <input
                    type="number" className="input" min={0}
                    value={targetForm[f.key as keyof typeof targetForm]}
                    onChange={e => setTargetForm(p => ({ ...p, [f.key]: Number(e.target.value) }))}
                  />
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setTargetsOpen(false)}>{nt.actions.cancel}</button>
              <button className="btn-primary" style={{ flex: 1 }} disabled={targetSaving} onClick={handleSaveTargets}>
                {targetSaving ? nt.actions.saving : nt.targetsModal.saveTargets}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── AI photo capture ───────────────────────────────────────────── */}
      {photoOpen && (
        <PhotoFoodCapture
          meal={photoMeal}
          mealLabel={MEALS.find(m => m.key === photoMeal)?.label ?? photoMeal}
          onLog={handlePhotoLog}
          onClose={() => setPhotoOpen(false)}
        />
      )}

      {/* ── Custom food create/edit modal ────────────────────────────── */}
      {customFoodModalOpen && (
        <CustomFoodModal
          editFood={editingCustomFood}
          onSave={food => {
            setCustomFoods(prev => {
              const idx = prev.findIndex(f => f.id === food.id);
              return idx >= 0 ? prev.map((f, i) => i === idx ? food : f) : [food, ...prev];
            });
            setCustomFoodModalOpen(false);
            // Open detail view for the saved food so the user can log it immediately
            if (!editingCustomFood) {
              setSelectedFood(customToUSDA(food));
              setAddQty(food.serving_size_g);
              setSearchOpen(true);
            }
          }}
          onClose={() => setCustomFoodModalOpen(false)}
        />
      )}

      {/* ── Meal manager modal ───────────────────────────────────────── */}
      {mealManagerOpen && (
        <MealManagerModal
          meals={mealTemplates}
          onUpdate={updated => setMealTemplates(prev => prev.map(m => m.id === updated.id ? updated : m))}
          onDelete={id => setMealTemplates(prev => prev.filter(m => m.id !== id))}
          onClose={() => setMealManagerOpen(false)}
          onBuild={() => { setMealBuilderDraft(null); setMealManagerOpen(false); setMealBuilderOpen(true); }}
          onImportUrl={draft => { setMealBuilderDraft(draft); setMealManagerOpen(false); setMealBuilderOpen(true); }}
          onLog={logMealTemplate}
          loggingMealId={loggingMealId}
          activeMealLabel={MEALS.find(m => m.key === activeMeal)?.label}
        />
      )}

      {/* ── Weekly meal plan modal ───────────────────────────────────── */}
      {mealPlanOpen && (
        <WeeklyMealPlanModal
          onClose={() => setMealPlanOpen(false)}
          onLog={logRecommendedMeal}
        />
      )}

      {/* ── Meal builder modal ───────────────────────────────────────── */}
      {mealBuilderOpen && (
        <MealBuilderModal
          initial={mealBuilderDraft ?? undefined}
          onSave={meal => {
            setMealTemplates(prev => [meal, ...prev]);
            mealsLoaded.current = true;
            setMealBuilderOpen(false);
            setMealBuilderDraft(null);
            // Log the new meal immediately into the active meal slot
            logMealTemplate(meal);
          }}
          onClose={() => { setMealBuilderOpen(false); setMealBuilderDraft(null); }}
        />
      )}

      {/* ── Food nutrient detail modal ──────────────────────────────────── */}
      {nutrientModalEntry && (
        <FoodNutrientModal
          entry={nutrientModalEntry}
          onClose={() => setNutrientModalEntry(null)}
        />
      )}

      {/* ── Barcode scanner (full-screen) ─────────────────────────────── */}
      {scannerOpen && (
        <BarcodeScanner
          onScan={handleBarcodeScan}
          onClose={() => { setScannerOpen(false); setSearchOpen(true); }}
        />
      )}

      {/* ── Barcode lookup loading overlay ─────────────────────────────── */}
      {barcodeLoading && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 250,
          background: "rgba(0,0,0,.65)", backdropFilter: "blur(4px)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14,
        }}>
          <i className="ti ti-scan" aria-hidden="true" style={{ fontSize: 36, color: "var(--blue)" }} />
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--blue)" }}>{nt.barcodeLookup.title}</div>
          <div style={{ fontSize: 12, color: "var(--dim)" }}>{nt.barcodeLookup.subtitle}</div>
        </div>
      )}

      {/* ── Keyboard shortcut hint ─────────────────────────────────────── */}
      <div style={{
        position: "fixed", bottom: 20, right: 20,
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 10, padding: "8px 14px", fontSize: 11, color: "var(--dim)",
        display: "flex", gap: 8, alignItems: "center",
      }}>
        <span style={{ background: "rgba(var(--overlay-rgb),.08)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px", fontSize: 10, color: "var(--muted)" }}>⌘K</span>
        {nt.keyboardHint.quickLogFood}
      </div>

      <style>{`
        .ntr-food-row:hover .ntr-del-btn { opacity: 1 !important; }
        .ntr-search-row:hover { background: rgba(var(--overlay-rgb),.04); }
        .ntr-quick-row:hover { color: var(--accent) !important; }
      `}</style>
    </div>
  );
}
