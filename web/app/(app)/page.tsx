import type React from "react";
import { createServerClient, getUserId, getUserFirstName } from "@/lib/supabase-server";
import { todayISO, daysAgoISO, daysUntil, weekBounds, formatLong, formatShort, formatWeekday, daysBetween, mesocycleWeek, mesocycleTotalWeeks } from "@/lib/dates";
import { parseDayMeta } from "@/lib/plan-parser";
import { buildStrengthMap, getWeightRecommendation, type CompletedSetRow, type WeightRecommendation } from "@/lib/strength";
import type { CompletedActivity, Plan, ScheduledDay, StrengthSession } from "@/lib/types";
import { DashboardActions } from "./DashboardActions";
import { CheckInCTA } from "./CheckInCTA";
import { MiniMonthCalendar } from "./MiniMonthCalendar";
import { RecentSessionsList } from "./RecentSessionsList";
import { TodaySessionCard, TODAY_SESSION_CARD_HEIGHT } from "./TodaySessionCard";
import { WeeklyMacrosCard } from "./WeeklyMacrosCard";
import { SicknessWatchCard } from "./SicknessWatchCard";
import type { DayData } from "./SessionDetailModal";
import { FitnessTrendChart } from "./FitnessTrendChart";
import { getAthleteProfile } from "@/app/actions/athlete-profile";
import { getReplanJobs } from "@/app/actions/replan";
import { RefreshDataButton } from "./RefreshDataButton";
import type { TrendSeries } from "./report/ProgressTabs";
import { GoalProgressGrid } from "./GoalProgressGrid";
import { getAuthenticatedLanguage } from "@/lib/i18n/getServerLanguage";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { localeTag } from "@/lib/i18n/language";
import type { Dictionary } from "@/lib/i18n/types";

function greeting(hour: number, name: string, t: Dictionary["dashboard"]["greeting"]): string {
  const part = hour < 5 ? t.night : hour < 12 ? t.morning : hour < 18 ? t.afternoon : t.evening;
  return t.template.replace("{part}", part).replace("{name}", name);
}

// Maps a `var(--x)` color token to its `-rgb` companion for use inside rgba().
// Concatenating a hex-alpha suffix onto a var() (e.g. `${"var(--green)"}18`)
// produces an invalid CSS string the browser silently drops — found live on
// the ReadinessStrip pills and the Goals priority badge, both rendering with
// zero background/border despite the code intending a tinted chip.
const RGB_VAR: Record<string, string> = {
  "var(--green)": "var(--green-rgb)",
  "var(--cyan)": "var(--cyan-rgb)",
  "var(--amber)": "var(--amber-rgb)",
  "var(--red)": "var(--red-rgb)",
  "var(--accent)": "var(--accent-rgb)",
  "var(--blue)": "var(--blue-rgb)",
};
function rgbVar(colorToken: string): string {
  return RGB_VAR[colorToken] ?? "var(--dim-rgb, 124,138,144)";
}

export default async function DashboardPage() {
  const today = todayISO();
  const { start: weekStart, end: weekEnd } = weekBounds(today);
  const sb = createServerClient();
  const uid = await getUserId();
  const language = await getAuthenticatedLanguage(uid);
  const t = dictionaries[language].dashboard;
  const locale = localeTag(language);

  const planRes = await sb.from("plans").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(1);
  const plan: Plan | null = planRes.data?.[0] ?? null;
  const planId = plan?.id ?? null;

  const sixtyDaysAgo = daysAgoISO(60);
  const heatmapWindowStart = daysAgoISO(182);
  const fitnessTrendStart = daysAgoISO(90);
  const sicknessWindowStart = daysAgoISO(28);
  // Garmin's race predictor only exposes up to 366 days of daily history per call
  // (see services/garmin/data_extractor.py's get_race_prediction_history) — matches
  // that same window here rather than fetching an unbounded range.
  const raceHistoryStart = daysAgoISO(366);

  // Window for the dashboard's MiniMonthCalendar (prev/current/next month, so
  // its prev/next arrows work against already-fetched data with no extra round trip).
  const todayDateObj = new Date(today + "T00:00:00");
  const calWindowStart = new Date(todayDateObj.getFullYear(), todayDateObj.getMonth() - 1, 1).toISOString().slice(0, 10);
  const calWindowEnd = new Date(todayDateObj.getFullYear(), todayDateObj.getMonth() + 2, 0).toISOString().slice(0, 10);

  const [dayRes, weekRes, weekSessRes, nextKeyRes, metricsRes, lastCheckinRes, athleteProfile, completedSetsRes, completedActivitiesRes, firstName, fitnessTrendRes, calDaysRes, calStrengthRes, weekMacrosRes, sicknessRes, replanJobs, benchRes, raceHistoryRes] = await Promise.all([
    planId
      ? sb.from("scheduled_days").select("*").eq("user_id", uid).eq("plan_id", planId).eq("date", today).limit(1)
      : Promise.resolve({ data: [] }),
    planId
      ? sb.from("scheduled_days").select("*").eq("user_id", uid).eq("plan_id", planId).gte("date", weekStart).lte("date", weekEnd).order("date")
      : Promise.resolve({ data: [] }),
    planId
      ? sb.from("strength_sessions").select("*, exercises(*)").eq("user_id", uid).eq("plan_id", planId).gte("date", weekStart).lte("date", weekEnd)
      : Promise.resolve({ data: [] }),
    planId
      ? sb.from("scheduled_days").select("*").eq("user_id", uid).eq("plan_id", planId).eq("is_key", true).gt("date", today).order("date").limit(1)
      : Promise.resolve({ data: [] }),
    sb.from("analyses").select("bench_e1rm_kg, kpis, report_date, updated_at").eq("user_id", uid)
      .order("report_date", { ascending: false }).order("updated_at", { ascending: false }).limit(1),
    sb.from("replan_jobs").select("completed_at").eq("user_id", uid).eq("type", "replan").eq("status", "done").order("completed_at", { ascending: false }).limit(1),
    getAthleteProfile(),
    sb.from("completed_exercise_sets").select("exercise_id, date, reps, weight_kg, prescribed_reps_min")
      .eq("user_id", uid).gte("date", sixtyDaysAgo).order("date", { ascending: false }),
    sb.from("completed_activities").select("*").eq("user_id", uid).gte("date", heatmapWindowStart).lte("date", today),
    getUserFirstName(),
    sb.from("daily_metrics").select("date, ctl, atl").eq("user_id", uid).gte("date", fitnessTrendStart).order("date", { ascending: true }),
    planId
      ? sb.from("scheduled_days").select("*").eq("user_id", uid).eq("plan_id", planId).gte("date", calWindowStart).lte("date", calWindowEnd).order("date")
      : Promise.resolve({ data: [] }),
    planId
      ? sb.from("strength_sessions").select("*, exercises(*)").eq("user_id", uid).eq("plan_id", planId).gte("date", calWindowStart).lte("date", calWindowEnd)
      : Promise.resolve({ data: [] }),
    sb.from("nutrition_diary").select("date, calories, protein_g, carbs_g, fat_g")
      .eq("user_id", uid).neq("meal_type", "water").gte("date", weekStart).lte("date", weekEnd),
    sb.from("daily_metrics").select("date, hrv_overnight, rhr, respiration_avg, sleep_stress_avg, body_battery_overnight_gain, sleep_hours")
      .eq("user_id", uid).gte("date", sicknessWindowStart).order("date", { ascending: true }),
    getReplanJobs(),
    // Bench e1RM stays on analyses (one point per check-in — no daily equivalent exists,
    // unlike the race predictions below which Garmin recomputes every single day).
    sb.from("analyses").select("report_date, bench_e1rm_kg").eq("user_id", uid).order("report_date", { ascending: true }),
    // Dense daily race-time predictions, backed by daily_metrics (see migration 038 +
    // services/garmin/history_sync.py) instead of the sparse per-check-in analyses
    // columns — Garmin recomputes these every day, so this gives up to 366 real points
    // per distance instead of one point per weekly check-in.
    sb.from("daily_metrics").select("date, predicted_5k_secs, predicted_10k_secs, predicted_half_marathon_secs, predicted_marathon_secs")
      .eq("user_id", uid).gte("date", raceHistoryStart).order("date", { ascending: true }),
  ]);

  const completedActivities: CompletedActivity[] = completedActivitiesRes.data ?? [];
  const fitnessTrendData = (fitnessTrendRes.data ?? []) as { date: string; ctl: number | null; atl: number | null }[];

  const today_day: ScheduledDay | null = dayRes.data?.[0] ?? null;
  const weekDays: ScheduledDay[] = weekRes.data ?? [];
  const nextKey: ScheduledDay | null = nextKeyRes.data?.[0] ?? null;

  // Week strength sessions, for today's session card (the week range contains today).
  const weekStrengthMap: Record<string, StrengthSession> = buildStrengthMap(weekSessRes.data);
  const session: StrengthSession | null = weekStrengthMap[today] ?? null;

  // Weekly macro totals per day (Mon–Sun), for WeeklyMacrosCard — aggregated in JS
  // since Supabase JS has no GROUP BY, same pattern as /api/nutrition/trends.
  const macrosByDate = new Map<string, { calories: number; protein_g: number; carbs_g: number; fat_g: number }>();
  for (const row of weekMacrosRes.data ?? []) {
    const existing = macrosByDate.get(row.date) ?? { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    existing.calories += row.calories ?? 0;
    existing.protein_g += row.protein_g ?? 0;
    existing.carbs_g += row.carbs_g ?? 0;
    existing.fat_g += row.fat_g ?? 0;
    macrosByDate.set(row.date, existing);
  }
  const weeklyMacros = Array.from({ length: 7 }, (_, i) => {
    // Manually formatted (not .toISOString()) — toISOString() converts to UTC,
    // which silently shifts the date back a day in timezones ahead of UTC
    // (e.g. CEST), the same trap buildMonthCells() in lib/calendar.ts avoids.
    const date = new Date(weekStart + "T00:00:00");
    date.setDate(date.getDate() + i);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { date: iso, ...(macrosByDate.get(iso) ?? { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }) };
  });

  // Prev/current/next month of scheduled days + completed activities, for the
  // dashboard's MiniMonthCalendar — same DayData shape SessionDetailModal expects.
  const calActivityMap: Record<string, CompletedActivity[]> = {};
  for (const a of completedActivities) (calActivityMap[a.date] ??= []).push(a);
  const calDayMap: Record<string, DayData> = Object.fromEntries(
    ((calDaysRes.data ?? []) as ScheduledDay[]).map(d => {
      const meta = parseDayMeta(plan?.markdown ?? "", d.date);
      return [d.date, { ...d, purpose: meta.purpose, adaptation: meta.adaptation, completedActivities: calActivityMap[d.date] ?? [] }];
    })
  );
  const calStrengthMap: Record<string, StrengthSession> = buildStrengthMap(calStrengthRes.data);

  // Sickness watch — five signals, each compared against their own personal
  // 28-day baseline (mean ± 1 SD). No single metric alone is a reliable
  // early-illness signal, but 2+ moving off-baseline together is a real
  // pattern wearables (Whoop, Oura) lean on — see SicknessWatchCard.
  // Body Battery is scored on its overnight *recharge* (wake level minus
  // sleep-start level), not the raw end-of-day number — a single absolute
  // reading doesn't say much on its own, since it's just wherever the level
  // happened to land relative to whatever the day's activity was.
  const sicknessRows: {
    date: string;
    hrv_overnight: number | null;
    rhr: number | null;
    respiration_avg: number | null;
    sleep_stress_avg: number | null;
    body_battery_overnight_gain: number | null;
    sleep_hours: number | null;
  }[] = sicknessRes.data ?? [];
  const sicknessLatest = sicknessRows[sicknessRows.length - 1] ?? null;
  const sicknessBaselineRows = sicknessRows.slice(0, -1); // exclude today so it can't skew its own baseline
  function baselineStats(values: (number | null)[]): { mean: number; std: number } | null {
    const nums = values.filter((v): v is number => v != null);
    if (nums.length < 7) return null; // not enough history for a meaningful SD
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const variance = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length;
    return { mean, std: Math.sqrt(variance) };
  }
  // Same daily_metrics.hrv_overnight baseline used by the Sickness Watch signal
  // below — reused here so the dashboard pill agrees with Sickness Watch and
  // Progress instead of the old kpis.hrv.weekly_avg (a different Garmin field,
  // pinned to whenever the last check-in report ran).
  const hrvBaseline = baselineStats(sicknessBaselineRows.map(r => r.hrv_overnight));
  function sicknessSignal(label: string, value: number | null, unit: string, baseline: { mean: number; std: number } | null, direction: "above" | "below") {
    const flagged = value != null && baseline != null
      ? (direction === "below" ? value < baseline.mean - baseline.std : value > baseline.mean + baseline.std)
      : false;
    return { label, value, unit, baselineMean: baseline?.mean ?? null, direction, flagged };
  }
  const sicknessSignals = [
    sicknessSignal(t.sicknessSignals.hrvOvernight, sicknessLatest?.hrv_overnight ?? null, "ms", baselineStats(sicknessBaselineRows.map(r => r.hrv_overnight)), "below"),
    sicknessSignal(t.sicknessSignals.restingHr, sicknessLatest?.rhr ?? null, "bpm", baselineStats(sicknessBaselineRows.map(r => r.rhr)), "above"),
    sicknessSignal(t.sicknessSignals.respirationRate, sicknessLatest?.respiration_avg ?? null, "br/min", baselineStats(sicknessBaselineRows.map(r => r.respiration_avg)), "above"),
    sicknessSignal(t.sicknessSignals.sleepStress, sicknessLatest?.sleep_stress_avg ?? null, "/100", baselineStats(sicknessBaselineRows.map(r => r.sleep_stress_avg)), "above"),
    sicknessSignal(t.sicknessSignals.bodyBatteryRecharge, sicknessLatest?.body_battery_overnight_gain ?? null, "pts", baselineStats(sicknessBaselineRows.map(r => r.body_battery_overnight_gain)), "below"),
  ];

  // Weight recommendation per exercise_id, from actual completed performance history —
  // supersedes the 1RM-formula estimate wherever real data exists for that specific exercise.
  const completedSetsByExercise = new Map<string, CompletedSetRow[]>();
  for (const row of completedSetsRes.data ?? []) {
    if (!row.exercise_id) continue;
    if (!completedSetsByExercise.has(row.exercise_id)) completedSetsByExercise.set(row.exercise_id, []);
    completedSetsByExercise.get(row.exercise_id)!.push({
      date: row.date, reps: row.reps, weight_kg: row.weight_kg, prescribed_reps_min: row.prescribed_reps_min,
    });
  }
  const weightRecommendations: Record<string, WeightRecommendation> = {};
  for (const [exerciseId, sets] of completedSetsByExercise) {
    weightRecommendations[exerciseId] = getWeightRecommendation(sets);
  }

  const meso = plan
    ? {
        week: mesocycleWeek(plan.start_date, today),
        totalWeeks: mesocycleTotalWeeks(plan.start_date, plan.end_date),
        daysLeft: Math.max(0, daysBetween(today, plan.end_date)),
        pct: Math.min(100, Math.max(0, Math.round((daysBetween(plan.start_date, today) / daysBetween(plan.start_date, plan.end_date)) * 100))),
        end: plan.end_date,
      }
    : null;

  const seasonEnded = plan ? today > plan.end_date : false;

  const lastCheckinDate: Date | null = lastCheckinRes.data?.[0]?.completed_at
    ? new Date(lastCheckinRes.data[0].completed_at)
    : plan ? new Date(plan.created_at) : null;
  const nextCheckinDate = lastCheckinDate
    ? new Date(lastCheckinDate.getTime() + 7 * 24 * 60 * 60 * 1000)
    : null;
  const daysUntilCheckin = nextCheckinDate ? daysUntil(nextCheckinDate) : null;
  const checkinOverdue = daysUntilCheckin !== null && daysUntilCheckin <= 0 && !seasonEnded;
  const daysSinceCheckin = daysUntilCheckin !== null && daysUntilCheckin < 0 ? Math.abs(daysUntilCheckin) : 0;

  const sessionCount = weekDays.filter(d => !d.is_rest).length;
  const keyCount = weekDays.filter(d => d.is_key).length;

  const latestMetrics = metricsRes.data?.[0] ?? null;
  const benchE1rm: number | null = latestMetrics?.bench_e1rm_kg ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kpis: Record<string, any> | null = latestMetrics?.kpis ?? null;
  const lastSyncedAt: string | null = latestMetrics?.updated_at ?? null;

  // Dense daily race-time history from daily_metrics (see migration 038) — Garmin
  // recomputes a prediction every single day, unlike bench e1RM which only exists on
  // days a bench session was logged, so this gets up to 366 real points per distance
  // instead of one point per weekly check-in.
  const raceHistoryRows = (raceHistoryRes.data ?? []) as {
    date: string; predicted_5k_secs: number | null; predicted_10k_secs: number | null;
    predicted_half_marathon_secs: number | null; predicted_marathon_secs: number | null;
  }[];
  function latestRaceValue(key: keyof (typeof raceHistoryRows)[number]): number | null {
    for (let i = raceHistoryRows.length - 1; i >= 0; i--) {
      const v = raceHistoryRows[i][key];
      if (v != null) return v as number;
    }
    return null;
  }
  const predicted5kSecs = latestRaceValue("predicted_5k_secs");
  const predicted10kSecs = latestRaceValue("predicted_10k_secs");
  const predictedHalfMarathonSecs = latestRaceValue("predicted_half_marathon_secs");
  const predictedMarathonSecs = latestRaceValue("predicted_marathon_secs");

  // Upcoming events from athlete profile (sorted by date, future only)
  const events = (athleteProfile?.events ?? [])
    .filter((ev: { name: string; date: string; priority: string; target_time: string }) => ev.name?.trim())
    .sort((a: { date: string }, b: { date: string }) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date < b.date ? -1 : 1;
    });

  const hasGoals = events.length > 0 || benchE1rm != null || predicted5kSecs != null
    || predicted10kSecs != null || predictedHalfMarathonSecs != null || predictedMarathonSecs != null;

  // Bench e1RM: full history from analyses, one point per check-in (no daily equivalent).
  const benchRows = (benchRes.data ?? []) as { report_date: string; bench_e1rm_kg: number | null }[];
  const benchSeries: TrendSeries = {
    label: t.benchGoal.chartLabel, unit: "kg", color: "#c084fc", decimals: 1, higherIsBetter: true,
    data: benchRows.map(r => ({ date: r.report_date, value: r.bench_e1rm_kg })),
  };
  // Race-time series are charted in decimal minutes (raw seconds reads badly on an axis
  // next to the other decimal-scale charts) — same conversion the original 5K chart used.
  const predicted5kSeries: TrendSeries = {
    label: t.racePredictions.chart5k, unit: "min", color: "#38bdf8", decimals: 1, higherIsBetter: false,
    data: raceHistoryRows.map(r => ({ date: r.date, value: r.predicted_5k_secs != null ? r.predicted_5k_secs / 60 : null })),
  };
  const predicted10kSeries: TrendSeries = {
    label: t.racePredictions.chart10k, unit: "min", color: "#34d399", decimals: 1, higherIsBetter: false,
    data: raceHistoryRows.map(r => ({ date: r.date, value: r.predicted_10k_secs != null ? r.predicted_10k_secs / 60 : null })),
  };
  const predictedHalfMarathonSeries: TrendSeries = {
    label: t.racePredictions.chartHalf, unit: "min", color: "#f59e0b", decimals: 1, higherIsBetter: false,
    data: raceHistoryRows.map(r => ({ date: r.date, value: r.predicted_half_marathon_secs != null ? r.predicted_half_marathon_secs / 60 : null })),
  };
  const predictedMarathonSeries: TrendSeries = {
    label: t.racePredictions.chartMarathon, unit: "min", color: "#f87171", decimals: 1, higherIsBetter: false,
    data: raceHistoryRows.map(r => ({ date: r.date, value: r.predicted_marathon_secs != null ? r.predicted_marathon_secs / 60 : null })),
  };
  const benchChartReady = benchSeries.data.filter(d => d.value !== null).length >= 3;
  const predicted5kChartReady = predicted5kSeries.data.filter(d => d.value !== null).length >= 3;
  const predicted10kChartReady = predicted10kSeries.data.filter(d => d.value !== null).length >= 3;
  const predictedHalfMarathonChartReady = predictedHalfMarathonSeries.data.filter(d => d.value !== null).length >= 3;
  const predictedMarathonChartReady = predictedMarathonSeries.data.filter(d => d.value !== null).length >= 3;
  const anyRaceChartReady = predicted5kChartReady || predicted10kChartReady || predictedHalfMarathonChartReady || predictedMarathonChartReady;

  // Average pace the athlete would need to hold for the full distance to hit each
  // predicted time — a race-time number alone doesn't say much without this.
  const goalCharts: { key: string; series: TrendSeries; ready: boolean; caption?: string }[] = [
    { key: "bench", series: benchSeries, ready: benchChartReady },
    { key: "5k", series: predicted5kSeries, ready: predicted5kChartReady, caption: predicted5kSecs != null ? t.racePredictions.targetPace.replace("{pace}", fmtPace(predicted5kSecs, 5)) : undefined },
    { key: "10k", series: predicted10kSeries, ready: predicted10kChartReady, caption: predicted10kSecs != null ? t.racePredictions.targetPace.replace("{pace}", fmtPace(predicted10kSecs, 10)) : undefined },
    { key: "half", series: predictedHalfMarathonSeries, ready: predictedHalfMarathonChartReady, caption: predictedHalfMarathonSecs != null ? t.racePredictions.targetPace.replace("{pace}", fmtPace(predictedHalfMarathonSecs, 21.0975)) : undefined },
    { key: "marathon", series: predictedMarathonSeries, ready: predictedMarathonChartReady, caption: predictedMarathonSecs != null ? t.racePredictions.targetPace.replace("{pace}", fmtPace(predictedMarathonSecs, 42.195)) : undefined },
  ].filter(g => g.ready);

  return (
    <div className="page">

      {/* ── Row 1: greeting + readiness + today's session (left column),
          month calendar + This Week stacked (right column). Stacking two
          cards on the right instead of pairing 1:1 gets the two columns'
          natural heights close enough that align-items: start reads as
          "aligned" without resorting to grid-stretch padding — see
          DESIGN.md for why forced stretch was rejected here. ── */}
      <div className="dashboard-hero-grid">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h1 className="dashboard-greeting" style={{ fontFamily: "var(--font-display)", fontWeight: 700, lineHeight: 1.1, letterSpacing: "-.5px", marginBottom: 4 }}>
                {greeting(new Date().getHours(), firstName, t.greeting)}
              </h1>
              <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".5px", textTransform: "uppercase", color: "var(--dim)" }}>
                {formatLong(today, language)}
              </p>
            </div>
            <RefreshDataButton lastSyncedAt={lastSyncedAt} initialJobs={replanJobs} />
          </div>

          {kpis && (
            <ReadinessStrip
              kpis={kpis}
              hrvOvernight={sicknessLatest?.hrv_overnight ?? null}
              hrvBaseline={hrvBaseline}
              sleepHours={sicknessLatest?.sleep_hours ?? null}
              t={t.readiness}
            />
          )}

          {today_day ? (
            <TodaySessionCard
              today_day={today_day}
              session={session}
              dayData={calDayMap[today] ?? null}
              bench1RMKg={athleteProfile?.bench_1rm_kg}
              weightRecommendations={weightRecommendations}
            />
          ) : (
            <div className="card" style={{ height: TODAY_SESSION_CARD_HEIGHT, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
              <div style={{
                width: 44, height: 44, borderRadius: "50%", margin: "0 auto 12px",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(var(--accent-rgb), .10)",
              }}>
                <i className="ti ti-moon-stars" style={{ fontSize: 22, color: "var(--accent)" }} aria-hidden="true" />
              </div>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 700, marginBottom: 6 }}>{t.restDay.title}</h2>
              <p style={{ color: "var(--muted)", fontSize: 14 }}>{t.restDay.description}</p>
            </div>
          )}

          <div className="card" style={{ marginTop: 0 }}>
            <div className="card-title" style={{ margin: "0 0 12px" }}>{t.thisWeek.title}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <MiniStat
                label={t.thisWeek.season}
                value={meso ? <>{t.thisWeek.week} {meso.week}<span style={{ fontWeight: 400, fontSize: 13, color: "var(--dim)" }}> /{meso.totalWeeks}</span></> : t.thisWeek.noPlan}
                note={meso ? t.thisWeek.daysLeft.replace("{days}", String(meso.daysLeft)) : undefined}
              />
              <MiniStat
                label={t.thisWeek.nextCheckin}
                value={daysUntilCheckin === null ? "—" : checkinOverdue ? t.thisWeek.due : t.thisWeek.daysCount.replace("{days}", String(daysUntilCheckin))}
                valueColor={checkinOverdue ? "var(--amber)" : undefined}
                note={
                  daysUntilCheckin === null ? undefined
                    : checkinOverdue ? <CheckInCTA daysSinceCheckin={daysSinceCheckin} />
                    : nextCheckinDate ? formatShort(nextCheckinDate.toISOString().slice(0, 10), language) : undefined
                }
              />
              <MiniStat
                label={t.thisWeek.thisWeekLabel}
                value={t.thisWeek.sessionsCount.replace("{count}", String(sessionCount))}
                note={keyCount > 0 ? `${keyCount} ${keyCount === 1 ? t.thisWeek.keySession : t.thisWeek.keySessions}` : t.thisWeek.noKeySessions}
              />
              <MiniStat
                label={t.thisWeek.nextKey}
                value={nextKey ? `${formatWeekday(nextKey.date, language)} · ${formatShort(nextKey.date, language)}` : t.thisWeek.noneUpcoming}
                note={nextKey ? (nextKey.focus ?? nextKey.session_type) : undefined}
              />
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <MiniMonthCalendar
            dayMap={calDayMap}
            strengthMap={calStrengthMap}
            today={today}
            bench1RMKg={athleteProfile?.bench_1rm_kg}
            weightRecommendations={weightRecommendations}
          />

          <WeeklyMacrosCard data={weeklyMacros} today={today} />
        </div>
      </div>

      {/* ── Row 2: fitness trend (large visual anchor) + recent sessions ──── */}
      <section className="section">
        <div className="dashboard-activity-grid">
          <FitnessTrendChart data={fitnessTrendData} />
          <RecentSessionsList activities={completedActivities} t={t.recentSessions} language={language} />
        </div>
      </section>

      {/* ── Sickness watch ────────────────────────────────────────────────── */}
      <section className="section">
        <SicknessWatchCard signals={sicknessSignals} />
      </section>

      {/* ── Action prompts (season-end only — check-in CTA lives in "This Week") ── */}
      <DashboardActions
        seasonEnded={seasonEnded}
        planEndDate={plan ? formatShort(plan.end_date, language) : ""}
      />

      {/* ── Goals ────────────────────────────────────────────────────────── */}
      {hasGoals && (
        <section className="section">
          <div className="goal-grid">

            {/* Event cards from athlete profile */}
            {events.map((ev: { name: string; date: string; priority: string; target_time: string }, i: number) => {
              const daysToEvent = ev.date ? daysUntil(ev.date) : null;
              const isPast = daysToEvent !== null && daysToEvent < 0;
              const priorityColor =
                ev.priority === "A" ? "var(--accent)" :
                ev.priority === "B" ? "var(--amber)" :
                "var(--dim)";
              return (
                <div key={i} className="card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8 }}>
                    {ev.priority && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
                        background: `rgba(${rgbVar(priorityColor)}, .12)`, color: priorityColor,
                        border: `1px solid rgba(${rgbVar(priorityColor)}, .32)`, flexShrink: 0,
                      }}>
                        {t.events.priorityRace.replace("{priority}", ev.priority)}
                      </span>
                    )}
                    {!isPast && daysToEvent !== null && (
                      <span style={{ fontSize: 12, color: "var(--dim)", marginLeft: "auto" }}>
                        {daysToEvent === 0 ? t.events.today : daysToEvent === 1 ? t.events.tomorrow : t.events.daysAway.replace("{days}", String(daysToEvent))}
                      </span>
                    )}
                    {isPast && <span className="badge">{t.events.completed}</span>}
                  </div>
                  <div className="card-title" style={{ margin: "0 0 4px", fontSize: 15 }}>{ev.name}</div>
                  {ev.date && (
                    <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
                      {new Date(ev.date).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" })}
                    </div>
                  )}
                  {ev.target_time && (
                    <div style={{ fontSize: 13 }}>
                      <span style={{ color: "var(--dim)" }}>{t.events.target} </span>
                      <span style={{ color: priorityColor, fontWeight: 700 }}>{ev.target_time}</span>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Bench press e1RM — compact card fallback only when there's not yet enough
                history (< 3 points) for the full-width evolution chart below. */}
            {benchE1rm != null && !benchChartReady && (
              <div className="card">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div className="card-title" style={{ margin: 0 }}>{t.benchGoal.title}</div>
                  <span className="badge badge-accent" style={{ fontSize: 10 }}>{t.benchGoal.estBadge}</span>
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span className="goal-current">{benchE1rm.toFixed(1)}</span>
                  <span style={{ color: "var(--muted)", fontSize: 13 }}>kg</span>
                </div>
                {athleteProfile?.bench_1rm_kg != null && (
                  <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>
                    {t.benchGoal.profileBaseline.replace("{value}", String(athleteProfile.bench_1rm_kg))}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 6 }}>
                  {t.benchGoal.footnote}
                </div>
              </div>
            )}

            {/* Race predictions — compact fallback listing only the distances that don't
                have a chart yet below (sourced from the dedicated predicted_*_secs columns,
                not kpis.race_predictions — that JSONB blob only gets populated on a full
                Check-In run, not the lightweight KPI-refresh sync, so it lags behind). */}
            {(predicted5kSecs != null && !predicted5kChartReady) ||
             (predicted10kSecs != null && !predicted10kChartReady) ||
             (predictedHalfMarathonSecs != null && !predictedHalfMarathonChartReady) ||
             (predictedMarathonSecs != null && !predictedMarathonChartReady) ? (
              <div className="card">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div className="card-title" style={{ margin: 0 }}>{t.racePredictions.title}</div>
                  <span className="badge badge-cyan" style={{ fontSize: 10 }}>{t.racePredictions.sourceBadge}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {predicted5kSecs != null && !predicted5kChartReady && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: "var(--dim)" }}>{t.racePredictions.fiveK}</span>
                      <span style={{ fontWeight: 700, fontFamily: "var(--mono)" }}>{fmtRaceTime(predicted5kSecs)}</span>
                    </div>
                  )}
                  {predicted10kSecs != null && !predicted10kChartReady && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: "var(--dim)" }}>{t.racePredictions.tenK}</span>
                      <span style={{ fontWeight: 700, fontFamily: "var(--mono)" }}>{fmtRaceTime(predicted10kSecs)}</span>
                    </div>
                  )}
                  {predictedHalfMarathonSecs != null && !predictedHalfMarathonChartReady && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: "var(--dim)" }}>{t.racePredictions.halfMarathon}</span>
                      <span style={{ fontWeight: 700, fontFamily: "var(--mono)" }}>{fmtRaceTime(predictedHalfMarathonSecs)}</span>
                    </div>
                  )}
                  {predictedMarathonSecs != null && !predictedMarathonChartReady && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: "var(--dim)" }}>{t.racePredictions.marathon}</span>
                      <span style={{ fontWeight: 700, fontFamily: "var(--mono)" }}>{fmtRaceTime(predictedMarathonSecs)}</span>
                    </div>
                  )}
                </div>
                {athleteProfile?.run_5k_time && (
                  <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 8 }}>
                    {t.racePredictions.profile5k.replace("{value}", athleteProfile.run_5k_time)}
                  </div>
                )}
              </div>
            ) : null}

          </div>

          {/* Full-history evolution charts for every goal estimate with enough data —
              bench e1RM plus whichever Garmin race-predictor distances have 3+ check-ins.
              One shared 1M/3M/6M/1Y toggle drives all of them, side by side. */}
          {(benchChartReady || anyRaceChartReady) && (
            <div style={{ marginTop: 16 }}>
              <GoalProgressGrid charts={goalCharts} events={events} />
            </div>
          )}
        </section>
      )}

    </div>
  );
}

// ── Readiness strip ───────────────────────────────────────────────────────────

function ReadinessStrip({ kpis, hrvOvernight, hrvBaseline, sleepHours, t }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kpis: Record<string, any>;
  hrvOvernight: number | null;
  hrvBaseline: { mean: number; std: number } | null;
  sleepHours: number | null;
  t: Dictionary["dashboard"]["readiness"];
}) {
  type Pill = { label: string; detail?: string; color: string; icon: string };
  const pills: Pill[] = [];

  const tsb = kpis.training_load?.tsb;
  if (tsb != null) {
    const label = tsb > 10 ? t.tsbFresh : tsb > -10 ? t.tsbBalanced : tsb > -30 ? t.tsbBuilding : t.tsbFatigued;
    const color = tsb > 10 ? "var(--green)" : tsb > -10 ? "var(--cyan)" : tsb > -30 ? "var(--amber)" : "var(--red)";
    pills.push({ label, detail: t.tsbDetail.replace("{value}", `${tsb > 0 ? "+" : ""}${Math.round(tsb)}`), color, icon: "ti-wave-sine" });
  }

  const acwr = kpis.training_load?.acwr_uncoupled;
  if (acwr != null) {
    const label = acwr > 1.5 ? t.acwrDanger : acwr > 1.3 ? t.acwrHigh : acwr >= 0.8 ? t.acwrOk : t.acwrUnder;
    const color = acwr > 1.5 ? "var(--red)" : acwr > 1.3 ? "var(--amber)" : acwr >= 0.8 ? "var(--green)" : "var(--cyan)";
    pills.push({ label, detail: t.acwrDetail.replace("{value}", acwr.toFixed(2)), color, icon: "ti-alert-triangle" });
  }

  const readiness = kpis.training_readiness?.score;
  if (readiness != null) {
    const color = readiness >= 70 ? "var(--green)" : readiness >= 40 ? "var(--amber)" : "var(--red)";
    pills.push({ label: t.ready.replace("{value}", String(Math.round(readiness))), color, icon: "ti-bolt" });
  }

  const bb = kpis.body_battery?.latest;
  if (bb != null) {
    const color = bb >= 60 ? "var(--green)" : bb >= 40 ? "var(--amber)" : "var(--red)";
    pills.push({ label: t.battery.replace("{value}", String(Math.round(bb))), color, icon: "ti-battery-2" });
  }

  // Last night's overnight HRV, same daily_metrics.hrv_overnight + baseline the
  // Sickness Watch card uses — was previously kpis.hrv.weekly_avg, a different
  // Garmin field (hrvSummary.weeklyAvg) pinned to whenever the last check-in
  // report ran, which is why this pill used to disagree with Sickness Watch
  // and Progress. Only "below baseline" is flagged, matching Sickness Watch's
  // own directionality — elevated HRV isn't a concern the same way low is.
  if (hrvOvernight != null) {
    const low = hrvBaseline != null && hrvOvernight < hrvBaseline.mean - hrvBaseline.std;
    const color = low ? "var(--amber)" : "var(--green)";
    const status = low ? t.hrvLow : t.hrvOk;
    pills.push({ label: status, detail: t.hrvDetail.replace("{value}", String(Math.round(hrvOvernight))), color, icon: "ti-heart-rate-monitor" });
  }

  // Last night's sleep duration, same daily_metrics.sleep_hours Sickness Watch
  // and Progress read — was previously kpis.sleep.avg_total_hours, a 56-day
  // mean mislabeled "7-day avg" in the report-generation code.
  if (sleepHours != null) {
    const color = sleepHours >= 7.5 ? "var(--green)" : sleepHours >= 6 ? "var(--amber)" : "var(--red)";
    pills.push({ label: t.sleep.replace("{value}", sleepHours.toFixed(1)), color, icon: "ti-moon" });
  }

  if (pills.length === 0) return null;

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {pills.map((p, i) => (
        <div
          key={i}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "4px 10px", borderRadius: 20,
            background: `rgba(${rgbVar(p.color)}, .12)`,
            border: `1px solid rgba(${rgbVar(p.color)}, .32)`,
          }}
        >
          <i className={`ti ${p.icon}`} style={{ fontSize: 11, color: p.color }} aria-hidden="true" />
          <span style={{ fontSize: 11, fontWeight: 700, color: p.color }}>{p.label}</span>
          {p.detail && (
            <span style={{ fontSize: 10, color: "var(--dim)" }}>· {p.detail}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── This Week mini stats (borderless — sits inside a card that already has a
//    boundary, so another nested bordered box per stat would just be clutter) ──

function MiniStat({
  label, value, note, valueColor, noteColor,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  valueColor?: string;
  noteColor?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".4px", textTransform: "uppercase", color: "var(--dim)", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 17, fontWeight: 800, color: valueColor, lineHeight: 1.2 }}>{value}</div>
      {note && <div style={{ fontSize: 11, color: noteColor ?? "var(--muted)", marginTop: 3 }}>{note}</div>}
    </div>
  );
}

// ── KPI layout helpers ────────────────────────────────────────────────────────

function fmtRaceTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

// Average per-km pace needed to hit a predicted race time over the given distance.
function fmtPace(totalSecs: number, km: number): string {
  const perKm = totalSecs / km;
  let m = Math.floor(perKm / 60);
  let s = Math.round(perKm - m * 60);
  if (s === 60) { s = 0; m += 1; }
  return `${m}:${s.toString().padStart(2, "0")}/km`;
}

