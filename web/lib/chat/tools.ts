import type Anthropic from "@anthropic-ai/sdk";
import { createServerClient } from "@/lib/supabase-server";
import { getAthleteProfile } from "@/app/actions/athlete-profile";
import { todayISO, daysAgoISO, weekBounds } from "@/lib/dates";

// Tools for the Chat tab's coaching assistant. Every handler takes the server-resolved
// `uid` as its first argument — never a model-supplied parameter — so the assistant is
// structurally unable to read (or write) another athlete's data. All tools but one are
// read-only; `propose_memory_fact` is the single, narrow exception, and it still can't
// alter the plan or profile directly — it only inserts a `pending` row into
// athlete_memory_suggestions, the same review queue check-in/reschedule/new-season notes
// already feed (see services/supabase/athlete_memory_suggestions.py, migration 047). The
// athlete accepts/dismisses it later from the dashboard pop-up or /setup — nothing this
// tool does ever reaches athlete_memory or athlete_profile on its own.

const MEMORY_CATEGORIES = ["injuries", "preferences", "equipment", "schedule", "observations", "goals"] as const;
type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DAILY_METRIC_COLUMNS = [
  "ctl", "atl", "tsb", "acwr", "ramp_7d", "monotony", "strain",
  "vo2max_running", "vo2max_cycling", "rhr", "hrv_overnight",
  "sleep_score", "sleep_hours", "sleep_deep_h", "sleep_rem_h",
  "stress_avg", "body_battery", "weight_kg",
] as const;
type DailyMetricColumn = (typeof DAILY_METRIC_COLUMNS)[number];

export const CHAT_TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "get_athlete_profile",
    description:
      "Get the athlete's goals, training background, benchmarks, schedule constraints, injuries, and preferences.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_current_plan_rationale",
    description:
      "Get the coach's stated rationale for the athlete's current training plan: the active program spec's periodization rationale, and the most recent weekly check-in's assessment of what was adjusted and why.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_readiness_and_kpis",
    description:
      "Get the athlete's latest computed KPIs (training readiness, training load, body battery, HRV) and the most recent day's recovery metrics — the best answer to 'how am I doing right now'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_metric_trend",
    description:
      "Get a raw daily time series for one recovery/training-load metric over a recent window, to answer trend questions ('how has my HRV been lately'). Returns real numbers, not a summary — read the series yourself rather than assuming a direction.",
    input_schema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: [...DAILY_METRIC_COLUMNS] },
        days: { type: "integer", minimum: 1, maximum: 180, default: 30 },
      },
      required: ["metric"],
    },
  },
  {
    name: "get_workout_history",
    description: "Get the athlete's actually-completed workouts (not planned sessions) over a recent window.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 180, default: 30 },
      },
    },
  },
  {
    name: "get_current_week_plan",
    description: "Get what's actually scheduled for the athlete this week (planned sessions, strength prescriptions).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_nutrition_history",
    description: "Get the athlete's logged nutrition (calories, protein, carbs, fat) over a recent window.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 90, default: 7 },
      },
    },
  },
  {
    name: "propose_memory_fact",
    description:
      "Flag a durable fact (an injury, an equipment/schedule change, or a strongly stated preference) for " +
      "the athlete's coach to review. Only call this AFTER the athlete has explicitly said yes to a direct " +
      "question from you asking whether to save it — never on your own inference, and never for something " +
      "transient (today's soreness, a single missed session, mood). This does not save anything by itself: " +
      "it only queues a pending suggestion the athlete still has to accept from the dashboard or /setup " +
      "before it affects any future plan.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: [...MEMORY_CATEGORIES] },
        key: { type: "string", description: "Short snake_case identifier, e.g. 'shin_splints' or 'tuesday_running_club'." },
        value: { type: "string", description: "The durable fact itself, restated in one plain sentence." },
      },
      required: ["category", "key", "value"],
    },
  },
];

async function getCurrentPlanRationale(uid: string) {
  const sb = createServerClient();
  const [specRes, reviewRes] = await Promise.all([
    sb.from("program_specs").select("spec, rationale, effective_from")
      .eq("user_id", uid).eq("status", "active").limit(1),
    sb.from("weekly_reviews").select("summary_html, week_start, kpi_delta")
      .eq("user_id", uid).order("week_start", { ascending: false }).limit(1),
  ]);
  return {
    active_program_spec: specRes.data?.[0] ?? null,
    latest_weekly_review: reviewRes.data?.[0] ?? null,
  };
}

async function getReadinessAndKpis(uid: string) {
  const sb = createServerClient();
  const [analysisRes, metricsRes] = await Promise.all([
    sb.from("analyses").select("kpis, report_date").eq("user_id", uid)
      .order("report_date", { ascending: false }).limit(1),
    sb.from("daily_metrics").select("*").eq("user_id", uid)
      .order("date", { ascending: false }).limit(1),
  ]);
  return {
    latest_kpis: analysisRes.data?.[0] ?? null,
    latest_daily_metrics: metricsRes.data?.[0] ?? null,
  };
}

async function getMetricTrend(uid: string, input: { metric?: string; days?: number }) {
  const metric = input.metric as DailyMetricColumn;
  if (!DAILY_METRIC_COLUMNS.includes(metric)) {
    throw new Error(`Unknown metric "${input.metric}". Valid metrics: ${DAILY_METRIC_COLUMNS.join(", ")}`);
  }
  const days = input.days ?? 30;
  const sb = createServerClient();
  const { data } = await sb.from("daily_metrics").select(`date, ${metric}`)
    .eq("user_id", uid).gte("date", daysAgoISO(days)).order("date", { ascending: true });
  return { metric, days, series: data ?? [] };
}

async function getWorkoutHistory(uid: string, input: { days?: number }) {
  const days = input.days ?? 30;
  const sb = createServerClient();
  const { data } = await sb
    .from("completed_activities")
    .select("date, activity_type, activity_name, duration_secs, distance_meters, avg_heart_rate, max_heart_rate, calories, activity_training_load")
    .eq("user_id", uid).gte("date", daysAgoISO(days)).order("date", { ascending: false });
  return { days, activities: data ?? [] };
}

async function getCurrentWeekPlan(uid: string) {
  const sb = createServerClient();
  const today = todayISO();
  const { start, end } = weekBounds(today);
  const planRes = await sb.from("plans").select("id").eq("user_id", uid)
    .order("created_at", { ascending: false }).limit(1);
  const planId = planRes.data?.[0]?.id ?? null;
  if (!planId) return { week_start: start, week_end: end, scheduled_days: [], strength_sessions: [] };

  const [daysRes, strengthRes] = await Promise.all([
    sb.from("scheduled_days").select("*").eq("user_id", uid).eq("plan_id", planId)
      .gte("date", start).lte("date", end).order("date"),
    sb.from("strength_sessions").select("*, exercises(*)").eq("user_id", uid).eq("plan_id", planId)
      .gte("date", start).lte("date", end),
  ]);
  return {
    week_start: start,
    week_end: end,
    scheduled_days: daysRes.data ?? [],
    strength_sessions: strengthRes.data ?? [],
  };
}

async function getNutritionHistory(uid: string, input: { days?: number }) {
  const days = input.days ?? 7;
  const sb = createServerClient();
  const { data } = await sb.from("nutrition_diary")
    .select("date, calories, protein_g, carbs_g, fat_g")
    .eq("user_id", uid).neq("meal_type", "water").gte("date", daysAgoISO(days)).order("date", { ascending: true });
  return { days, entries: data ?? [] };
}

async function proposeMemoryFact(
  uid: string,
  input: { category?: string; key?: string; value?: string },
  sourceNote: string,
) {
  const category = input.category as MemoryCategory;
  if (!MEMORY_CATEGORIES.includes(category)) {
    throw new Error(`Unknown category "${input.category}". Valid categories: ${MEMORY_CATEGORIES.join(", ")}`);
  }
  const key = (input.key ?? "").trim();
  const value = (input.value ?? "").trim();
  if (!key || !value) throw new Error("Both key and value are required.");

  const sb = createServerClient();
  // Mirrors services/supabase/athlete_memory_suggestions.py::insert_suggestions — skip if an
  // identical fact is already pending review, rather than piling up duplicate rows.
  const { data: existing } = await sb
    .from("athlete_memory_suggestions")
    .select("id")
    .eq("user_id", uid).eq("status", "pending")
    .eq("category", category).eq("key", key).eq("value", value)
    .limit(1);
  if (existing && existing.length > 0) {
    return { queued: false, reason: "An identical suggestion is already pending review." };
  }

  const { error } = await sb.from("athlete_memory_suggestions").insert({
    user_id: uid,
    category,
    key,
    value,
    source_note: sourceNote,
  });
  if (error) throw new Error(error.message);
  return { queued: true };
}

export async function runChatTool(
  name: string,
  uid: string,
  input: Record<string, unknown>,
  sourceNote?: string,
): Promise<unknown> {
  switch (name) {
    case "get_athlete_profile":
      return getAthleteProfile();
    case "get_current_plan_rationale":
      return getCurrentPlanRationale(uid);
    case "get_readiness_and_kpis":
      return getReadinessAndKpis(uid);
    case "get_metric_trend":
      return getMetricTrend(uid, input);
    case "get_workout_history":
      return getWorkoutHistory(uid, input);
    case "get_current_week_plan":
      return getCurrentWeekPlan(uid);
    case "get_nutrition_history":
      return getNutritionHistory(uid, input);
    case "propose_memory_fact":
      return proposeMemoryFact(uid, input, sourceNote ?? "");
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
