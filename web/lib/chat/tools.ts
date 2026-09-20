import type Anthropic from "@anthropic-ai/sdk";
import { createServerClient } from "@/lib/supabase-server";
import { getAthleteProfile } from "@/app/actions/athlete-profile";
import { todayISO, daysAgoISO, weekBounds } from "@/lib/dates";

// Read-only tools for the Chat tab's coaching assistant. Every handler takes the
// server-resolved `uid` as its first argument — never a model-supplied parameter —
// so the assistant is structurally unable to read (or write) another athlete's data,
// and has no write tools at all, so it cannot alter the plan or any other DB state.
// This is the control mechanism for the feature: enforced by which tools exist, not
// by a prompt instruction asking the model to behave.

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

export async function runChatTool(name: string, uid: string, input: Record<string, unknown>): Promise<unknown> {
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
