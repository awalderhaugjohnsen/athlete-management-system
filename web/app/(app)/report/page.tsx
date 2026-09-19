import { createServerClient, getUserId } from "@/lib/supabase-server";
import { getAthleteProfile } from "@/app/actions/athlete-profile";
import { daysAgoISO } from "@/lib/dates";
import type { CompletedActivity, CompletedExerciseSet, ScheduledDay } from "@/lib/types";
import { getAuthenticatedLanguage } from "@/lib/i18n/getServerLanguage";
import { dictionaries } from "@/lib/i18n/dictionaries";
import ProgressTabs, { type TrendSeries, type ZoneBand, type ZoneLine } from "./ProgressTabs";

export default async function ProgressPage() {
  const sb = createServerClient();
  const uid = await getUserId();
  const language = await getAuthenticatedLanguage(uid);
  const t = dictionaries[language].report;

  const activityHistoryStart = daysAgoISO(365);

  const [
    latestRes, dailyMetricsRes, fallbackTrendRes, weeklyReviewRes, athleteProfile,
    completedActivitiesRes, benchRes, completedExerciseSetsRes, scheduledDaysRes,
  ] = await Promise.all([
    sb
      .from("analyses")
      .select("analysis_html, planning_html, report_date")
      .eq("user_id", uid)
      .order("report_date", { ascending: false })
      .limit(1),

    sb
      .from("daily_metrics")
      // No .limit() — with ascending order, a limit here silently drops the MOST
      // RECENT days once the account has more than the limit's worth of rows (this
      // account is already past 365), the opposite of what "recent trend" needs.
      .select("date, ctl, atl, tsb, acwr, ramp_7d, vo2max_running, vo2max_cycling, rhr, hrv_overnight, sleep_score, sleep_hours, body_battery, weight_kg, stress_avg, total_calories, predicted_5k_secs, predicted_10k_secs, predicted_half_marathon_secs, predicted_marathon_secs")
      .eq("user_id", uid)
      .order("date", { ascending: true }),

    sb
      .from("analyses")
      .select("report_date, kpis")
      .eq("user_id", uid)
      .not("kpis", "is", null)
      .order("report_date", { ascending: true })
      .limit(90),

    sb
      .from("weekly_reviews")
      .select("summary_html, week_start, kpi_delta")
      .eq("user_id", uid)
      .order("week_start", { ascending: false })
      .limit(1),

    getAthleteProfile(),

    sb
      .from("completed_activities")
      .select("*")
      .eq("user_id", uid)
      .gte("date", activityHistoryStart),

    // Bench e1RM long-term trend — a per-report snapshot column on `analyses` (same
    // table the dashboard reads just the latest row from for its Goals card), so the
    // full history doubles as a ready-made time series with no new storage. Race-time
    // predictions used to live here too but moved to daily_metrics (see migration 038)
    // once dense daily history became available — Garmin recomputes a race prediction
    // every day, unlike bench e1RM which only exists on days a bench session was logged.
    sb
      .from("analyses")
      .select("report_date, bench_e1rm_kg")
      .eq("user_id", uid)
      .order("report_date", { ascending: true }),

    // Per-exercise progress tab (migration 031) — not queried anywhere else in web/.
    sb
      .from("completed_exercise_sets")
      .select("*")
      .eq("user_id", uid)
      .gte("date", activityHistoryStart),

    // Same window as completed_activities above — used to derive each completed run's
    // session_type by matching it to the scheduled_days row for the same date. Not scoped
    // to a single plan_id: a full year of history can span several regenerated plans, and
    // the date is what a completed run actually matches against.
    sb
      .from("scheduled_days")
      .select("*")
      .eq("user_id", uid)
      .gte("date", activityHistoryStart),
  ]);

  const latest = latestRes.data?.[0] ?? null;
  const completedActivities: CompletedActivity[] = completedActivitiesRes.data ?? [];
  const completedExerciseSets: CompletedExerciseSet[] = completedExerciseSetsRes.data ?? [];
  const scheduledDays: ScheduledDay[] = scheduledDaysRes.data ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dailyRows: Record<string, any>[] = dailyMetricsRes.data ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fallbackRows: { report_date: string; kpis: Record<string, any> }[] = fallbackTrendRes.data ?? [];
  const benchRows: { report_date: string; bench_e1rm_kg: number | null }[] = benchRes.data ?? [];
  const weeklyReview = weeklyReviewRes.data?.[0] ?? null;
  const events = (athleteProfile?.events ?? []).filter(
    (e: { date: string }) => e.date >= new Date().toISOString().slice(0, 10)
      || (new Date().getTime() - new Date(e.date).getTime()) < 30 * 24 * 60 * 60 * 1000,
  );

  const useDailyMetrics = dailyRows.length >= 3;

  // ── HRV personal baseline (dynamic) ──────────────────────────────────────
  const hrvValues = dailyRows
    .map(r => r.hrv_overnight as number | null)
    .filter((v): v is number => v != null);
  const hrvMean = hrvValues.length > 0
    ? hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length
    : null;
  const hrvStd = hrvMean != null && hrvValues.length > 1
    ? Math.sqrt(hrvValues.reduce((s, v) => s + (v - hrvMean) ** 2, 0) / hrvValues.length)
    : null;

  // ── Zone colour constants ─────────────────────────────────────────────────
  const Z = {
    green:   "rgba(34,197,94,0.16)",
    amber:   "rgba(245,158,11,0.15)",
    red:     "rgba(var(--red-rgb),.15)",
    neutral: "rgba(148,163,184,0.09)",
    lineG:   "rgba(34,197,94,0.8)",
    lineA:   "rgba(245,158,11,0.8)",
    lineR:   "rgba(239,68,68,0.8)",
  };

  const sv = t.trends.series;

  // ── Recovery composite (0–100): HRV×35% + sleep×30% + battery×25% + RHR×10%
  const recoveryData = dailyRows.map(r => {
    let score = 0, weight = 0;
    const hrv: number | null = r.hrv_overnight;
    const sleep: number | null = r.sleep_score;
    const battery: number | null = r.body_battery;
    const rhr: number | null = r.rhr;
    if (hrv != null && hrvMean != null && hrvMean > 0) {
      score  += Math.min(100, Math.max(0, (hrv / hrvMean) * 70 + 30)) * 0.35;
      weight += 0.35;
    }
    if (sleep != null)   { score += sleep * 0.30;   weight += 0.30; }
    if (battery != null) { score += battery * 0.25; weight += 0.25; }
    if (rhr != null) {
      score  += Math.min(100, Math.max(0, 100 - (rhr - 40) * 2)) * 0.10;
      weight += 0.10;
    }
    return { date: r.date as string, value: weight > 0 ? Math.round(score / weight) : null };
  });

  let trendSeries: TrendSeries[];

  if (useDailyMetrics) {
    trendSeries = [
      // ── ACWR — workload safety (from the article) ───────────────────────
      {
        key: "acwr",
        label: sv.acwr.label,
        unit: "",
        color: "#7c3aed",
        decimals: 2,
        zoneBands: [
          { min: -Infinity, max: 0.8,  fill: Z.amber, severity: "warning", label: sv.acwr.zones.underTraining.label, chartLabel: sv.acwr.zones.underTraining.chart },
          { min: 0.8,       max: 1.3,  fill: Z.green, severity: "optimal", label: sv.acwr.zones.optimal.label,       chartLabel: sv.acwr.zones.optimal.chart },
          { min: 1.3,       max: Infinity, fill: Z.red, severity: "danger", label: sv.acwr.zones.risk.label,         chartLabel: sv.acwr.zones.risk.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value: 0.8, label: "0.8", color: Z.lineG },
          { value: 1.3, label: "1.3", color: Z.lineR },
        ] satisfies ZoneLine[],
        data: dailyRows.map(r => ({ date: r.date, value: r.acwr ?? null })),
      },

      // ── CTL / ATL / TSB — shown together in PMC ─────────────────────────
      {
        key: "ctl",
        label: sv.ctl.label,
        unit: t.trends.units.load, color: "var(--accent)", decimals: 1, higherIsBetter: true,
        data: dailyRows.map(r => ({ date: r.date, value: r.ctl ?? null })),
      },
      {
        key: "tsb",
        label: sv.tsb.label,
        unit: "", color: "var(--accent)", decimals: 1,
        zoneBands: [
          { min: -Infinity, max: -30, fill: Z.red,     severity: "danger",  label: sv.tsb.zones.overreaching.label, chartLabel: sv.tsb.zones.overreaching.chart },
          { min: -30,       max: -10, fill: Z.amber,   severity: "warning", label: sv.tsb.zones.trainingLoad.label, chartLabel: sv.tsb.zones.trainingLoad.chart },
          { min: -10,       max: 5,   fill: Z.green,   severity: "optimal", label: sv.tsb.zones.raceReady.label,    chartLabel: sv.tsb.zones.raceReady.chart },
          { min: 5,         max: 25,  fill: Z.neutral, severity: "neutral", label: sv.tsb.zones.fresh.label,        chartLabel: sv.tsb.zones.fresh.chart },
          { min: 25, max: Infinity,   fill: Z.amber,   severity: "warning", label: sv.tsb.zones.overtapered.label,  chartLabel: sv.tsb.zones.overtapered.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value: -30, label: "-30", color: Z.lineR },
          { value: -10, label: "-10", color: Z.lineG },
          { value:   0, label: "0",   color: "rgba(148,163,184,0.5)" },
          { value:  25, label: "+25", color: Z.lineA },
        ] satisfies ZoneLine[],
        data: dailyRows.map(r => ({ date: r.date, value: r.tsb ?? null })),
      },
      {
        key: "atl",
        label: sv.atl.label,
        unit: t.trends.units.load, color: "var(--red)", decimals: 1,
        data: dailyRows.map(r => ({ date: r.date, value: r.atl ?? null })),
      },

      // ── Recovery composite ──────────────────────────────────────────────
      {
        key: "recovery",
        label: sv.recovery.label,
        unit: "/100", color: "#34d399", decimals: 0, higherIsBetter: true,
        zoneBands: [
          { min: -Infinity, max: 40,  fill: Z.red,   severity: "danger",  label: sv.recovery.zones.required.label, chartLabel: sv.recovery.zones.required.chart },
          { min: 40,        max: 65,  fill: Z.amber, severity: "warning", label: sv.recovery.zones.caution.label,  chartLabel: sv.recovery.zones.caution.chart },
          { min: 65,        max: Infinity, fill: Z.green, severity: "optimal", label: sv.recovery.zones.optimal.label, chartLabel: sv.recovery.zones.optimal.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value: 40, label: "40", color: Z.lineR },
          { value: 65, label: "65", color: Z.lineG },
        ] satisfies ZoneLine[],
        data: recoveryData,
      },

      // ── VO2max ──────────────────────────────────────────────────────────
      {
        key: "vo2max",
        label: sv.vo2max.label,
        unit: "ml/kg/min", color: "#10b981", decimals: 1, higherIsBetter: true,
        data: forwardFill(dailyRows.map(r => ({ date: r.date, value: r.vo2max_running ?? r.vo2max_cycling ?? null }))),
      },

      // ── HRV — personal baseline ─────────────────────────────────────────
      {
        key: "hrv",
        label: sv.hrv.label,
        unit: "ms", color: "#fbbf24", decimals: 0, higherIsBetter: true,
        zoneBands: hrvMean != null && hrvStd != null ? [
          { min: -Infinity,            max: hrvMean - hrvStd * 2, fill: Z.red,     severity: "danger",  label: sv.hrv.zones.suppressed.label, chartLabel: sv.hrv.zones.suppressed.chart },
          { min: hrvMean - hrvStd * 2, max: hrvMean - hrvStd,     fill: Z.amber,   severity: "warning", label: sv.hrv.zones.low.label,        chartLabel: sv.hrv.zones.low.chart },
          { min: hrvMean - hrvStd,     max: hrvMean + hrvStd,      fill: Z.green,  severity: "optimal", label: sv.hrv.zones.baseline.labelTemplate.replace("{value}", hrvMean.toFixed(0)), chartLabel: sv.hrv.zones.baseline.chart },
          { min: hrvMean + hrvStd,     max: Infinity,              fill: Z.neutral, severity: "neutral", label: sv.hrv.zones.elevated.label,   chartLabel: sv.hrv.zones.elevated.chart },
        ] satisfies ZoneBand[] : [],
        zoneLines: hrvMean != null && hrvStd != null ? [
          { value: hrvMean,          label: sv.hrv.lines.baselineTemplate.replace("{value}", hrvMean.toFixed(0)), color: Z.lineG },
          { value: hrvMean - hrvStd, label: "−1 SD",                              color: Z.lineA },
        ] satisfies ZoneLine[] : [],
        data: dailyRows.map(r => ({ date: r.date, value: r.hrv_overnight ?? null })),
      },

      // ── Sleep ────────────────────────────────────────────────────────────
      {
        key: "sleep_score",
        label: sv.sleepScore.label,
        unit: "/100", color: "#a78bfa", decimals: 0, higherIsBetter: true,
        zoneBands: [
          { min: -Infinity, max: 50,  fill: Z.red,   severity: "danger",  label: sv.sleepScore.zones.poor.label, chartLabel: sv.sleepScore.zones.poor.chart },
          { min: 50,        max: 70,  fill: Z.amber, severity: "warning", label: sv.sleepScore.zones.fair.label, chartLabel: sv.sleepScore.zones.fair.chart },
          { min: 70, max: Infinity,   fill: Z.green, severity: "optimal", label: sv.sleepScore.zones.good.label, chartLabel: sv.sleepScore.zones.good.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value: 50, label: "50", color: Z.lineR },
          { value: 70, label: "70", color: Z.lineG },
        ] satisfies ZoneLine[],
        data: dailyRows.map(r => ({ date: r.date, value: r.sleep_score ?? null })),
      },
      {
        key: "sleep_hours",
        label: sv.sleepHours.label,
        unit: t.trends.units.hours, color: "#818cf8", decimals: 1, higherIsBetter: true,
        zoneBands: [
          { min: -Infinity, max: 6, fill: Z.red,     severity: "danger",  label: sv.sleepHours.zones.tooLittle.label, chartLabel: sv.sleepHours.zones.tooLittle.chart },
          { min: 6,         max: 7, fill: Z.amber,   severity: "warning", label: sv.sleepHours.zones.marginal.label,  chartLabel: sv.sleepHours.zones.marginal.chart },
          { min: 7,         max: 9, fill: Z.green,   severity: "optimal", label: sv.sleepHours.zones.optimal.label,   chartLabel: sv.sleepHours.zones.optimal.chart },
          { min: 9, max: Infinity,  fill: Z.neutral, severity: "neutral", label: sv.sleepHours.zones.long.label,      chartLabel: sv.sleepHours.zones.long.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value: 6, label: `6 ${t.trends.units.hours}`, color: Z.lineR },
          { value: 7, label: `7 ${t.trends.units.hours}`, color: Z.lineG },
          { value: 9, label: `9 ${t.trends.units.hours}`, color: Z.lineA },
        ] satisfies ZoneLine[],
        data: dailyRows.map(r => ({ date: r.date, value: r.sleep_hours ?? null })),
      },

      // ── Physiological signals ────────────────────────────────────────────
      {
        key: "rhr",
        label: sv.rhr.label,
        unit: "bpm", color: "var(--red)", decimals: 0, higherIsBetter: false,
        zoneBands: [
          { min: -Infinity, max: 50,  fill: Z.green,   severity: "optimal", label: sv.rhr.zones.excellent.label, chartLabel: sv.rhr.zones.excellent.chart },
          { min: 50,        max: 60,  fill: Z.neutral, severity: "neutral", label: sv.rhr.zones.good.label,      chartLabel: sv.rhr.zones.good.chart },
          { min: 60,        max: 70,  fill: Z.amber,   severity: "warning", label: sv.rhr.zones.moderate.label,  chartLabel: sv.rhr.zones.moderate.chart },
          { min: 70, max: Infinity,   fill: Z.red,     severity: "danger",  label: sv.rhr.zones.elevated.label,  chartLabel: sv.rhr.zones.elevated.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value: 50, label: "50", color: Z.lineG },
          { value: 60, label: "60", color: Z.lineA },
          { value: 70, label: "70", color: Z.lineR },
        ] satisfies ZoneLine[],
        data: dailyRows.map(r => ({ date: r.date, value: r.rhr ?? null })),
      },
      {
        key: "body_battery",
        label: sv.bodyBattery.label,
        unit: "%", color: "#34d399", decimals: 0, higherIsBetter: true,
        zoneBands: [
          { min: -Infinity, max: 25,  fill: Z.red,   severity: "danger",  label: sv.bodyBattery.zones.depleted.label, chartLabel: sv.bodyBattery.zones.depleted.chart },
          { min: 25,        max: 50,  fill: Z.amber, severity: "warning", label: sv.bodyBattery.zones.low.label,      chartLabel: sv.bodyBattery.zones.low.chart },
          { min: 50, max: Infinity,   fill: Z.green, severity: "optimal", label: sv.bodyBattery.zones.good.label,     chartLabel: sv.bodyBattery.zones.good.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value: 25, label: "25%", color: Z.lineR },
          { value: 50, label: "50%", color: Z.lineG },
        ] satisfies ZoneLine[],
        data: dailyRows.map(r => ({ date: r.date, value: r.body_battery ?? null })),
      },
      {
        key: "stress",
        label: sv.stress.label,
        unit: "", color: "#fb923c", decimals: 0, higherIsBetter: false,
        zoneBands: [
          { min: -Infinity, max: 25,  fill: Z.green, severity: "optimal", label: sv.stress.zones.low.label,      chartLabel: sv.stress.zones.low.chart },
          { min: 25,        max: 50,  fill: Z.amber, severity: "warning", label: sv.stress.zones.moderate.label, chartLabel: sv.stress.zones.moderate.chart },
          { min: 50, max: Infinity,   fill: Z.red,   severity: "danger",  label: sv.stress.zones.high.label,     chartLabel: sv.stress.zones.high.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value: 25, label: "25", color: Z.lineG },
          { value: 50, label: "50", color: Z.lineR },
        ] satisfies ZoneLine[],
        data: dailyRows.map(r => ({ date: r.date, value: r.stress_avg ?? null })),
      },

      // ── Load adaptation rate (bar chart) ────────────────────────────────
      {
        key: "ramp_rate",
        label: sv.rampRate.label,
        unit: t.trends.units.ctlPerWeek, color: "var(--green)", decimals: 1, chartType: "bar",
        zoneBands: [
          { min: -Infinity, max: -5,  fill: Z.amber, severity: "warning", label: sv.rampRate.zones.detraining.label,   chartLabel: sv.rampRate.zones.detraining.chart },
          { min: -5,        max:  0,  fill: Z.neutral, severity: "neutral", label: sv.rampRate.zones.recovery.label,   chartLabel: sv.rampRate.zones.recovery.chart },
          { min:  0,        max:  7,  fill: Z.green, severity: "optimal", label: sv.rampRate.zones.optimalBuild.label, chartLabel: sv.rampRate.zones.optimalBuild.chart },
          { min:  7,        max: 12,  fill: Z.amber, severity: "warning", label: sv.rampRate.zones.caution.label,      chartLabel: sv.rampRate.zones.caution.chart },
          { min: 12, max: Infinity,   fill: Z.red,   severity: "danger",  label: sv.rampRate.zones.injuryRisk.label,   chartLabel: sv.rampRate.zones.injuryRisk.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value:  7, label: `7 — ${sv.rampRate.lines.caution}`,      color: Z.lineA },
          { value: 12, label: `12 — ${sv.rampRate.lines.injuryRisk}`,  color: Z.lineR },
        ] satisfies ZoneLine[],
        data: dailyRows.map(r => ({ date: r.date, value: r.ramp_7d ?? null })),
      },

      // ── Body weight ──────────────────────────────────────────────────────
      {
        key: "weight",
        label: sv.weight.label,
        unit: "kg", color: "var(--dim)", decimals: 1,
        data: dailyRows.map(r => ({ date: r.date, value: r.weight_kg ?? null })),
      },

      // ── Calories burned (Garmin measured daily expenditure) ─────────────
      {
        key: "calories",
        label: sv.calories.label,
        unit: "kcal", color: "#fb7185", decimals: 0, chartType: "bar",
        data: dailyRows.map(r => ({ date: r.date, value: r.total_calories ?? null })),
      },
    ];
  } else {
    // Fallback from analyses.kpis snapshots (limited zone support)
    trendSeries = [
      {
        key: "ctl",
        label: sv.ctl.label,
        unit: t.trends.units.load,
        color: "var(--accent)",
        decimals: 1,
        higherIsBetter: true,
        data: fallbackRows.map(r => ({ date: r.report_date, value: r.kpis?.training_load?.chronic_28d_avg ?? null })),
      },
      {
        key: "tsb",
        label: sv.tsb.label,
        unit: "",
        color: "var(--accent)",
        decimals: 1,
        zoneBands: [
          { min: -Infinity, max: -30, fill: Z.red,     severity: "danger",  label: sv.tsb.zones.overreaching.chart },
          { min: -30,       max: -10, fill: Z.amber,   severity: "warning", label: sv.tsb.zones.trainingLoad.chart },
          { min: -10,       max: 5,   fill: Z.green,   severity: "optimal", label: sv.tsb.zones.raceReady.chart },
          { min: 5,         max: Infinity, fill: Z.neutral, severity: "neutral", label: sv.tsb.zones.fresh.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value: -30, label: "-30", color: Z.lineR },
          { value: -10, label: "-10", color: Z.lineG },
          { value:   0, label: "0",   color: "rgba(148,163,184,0.5)" },
        ] satisfies ZoneLine[],
        data: fallbackRows.map(r => ({ date: r.report_date, value: r.kpis?.training_load?.tsb ?? null })),
      },
      {
        key: "vo2max",
        label: sv.vo2max.label,
        unit: "ml/kg/min",
        color: "#34d399",
        decimals: 1,
        higherIsBetter: true,
        data: fallbackRows.map(r => ({ date: r.report_date, value: r.kpis?.physiological?.vo2max_running ?? null })),
      },
      {
        key: "hrv",
        label: sv.hrv.shortLabel,
        unit: "ms",
        color: "#fbbf24",
        decimals: 0,
        higherIsBetter: true,
        data: fallbackRows.map(r => ({ date: r.report_date, value: r.kpis?.hrv?.weekly_avg ?? null })),
      },
      {
        key: "sleep_score",
        label: sv.sleepScore.label,
        unit: "/100",
        color: "#a78bfa",
        decimals: 0,
        higherIsBetter: true,
        zoneBands: [
          { min: -Infinity, max: 50,  fill: Z.red,   severity: "danger",  label: sv.sleepScore.zones.poor.chart },
          { min: 50,        max: 70,  fill: Z.amber, severity: "warning", label: sv.sleepScore.zones.fair.chart },
          { min: 70,        max: Infinity, fill: Z.green, severity: "optimal", label: sv.sleepScore.zones.good.chart },
        ] satisfies ZoneBand[],
        zoneLines: [
          { value: 50, label: "50", color: Z.lineR },
          { value: 70, label: "70", color: Z.lineG },
        ] satisfies ZoneLine[],
        data: fallbackRows.map(r => ({ date: r.report_date, value: r.kpis?.sleep?.avg_score ?? null })),
      },
      {
        key: "rhr",
        label: sv.rhr.label,
        unit: "bpm",
        color: "var(--red)",
        decimals: 0,
        higherIsBetter: false,
        data: fallbackRows.map(r => ({ date: r.report_date, value: r.kpis?.physiological?.rhr ?? null })),
      },
      {
        key: "weight",
        label: sv.weight.label,
        unit: "kg",
        color: "var(--dim)",
        decimals: 1,
        data: fallbackRows.map(r => ({ date: r.report_date, value: r.kpis?.body?.weight_kg ?? null })),
      },
    ];
  }

  // ── Bench e1RM (Epley) + Garmin race-time predictions — long-term goal trends,
  // independent of which branch built the series above. Bench comes from `analyses`
  // (one point per check-in, no daily equivalent); race predictions come from
  // `daily_metrics` (migration 038) — Garmin recomputes those every single day, so
  // this gets up to 365 real points per distance instead of one per weekly check-in.
  // No manual "enough data" gate here — ProgressTabs already drops any series with
  // fewer than 3 non-null points (`activeSeries` filter), so duplicating that
  // threshold here would just be a second place for it to drift out of sync.
  trendSeries.push({
    key: "bench_e1rm",
    label: sv.benchE1rm.label,
    unit: "kg", color: "#c084fc", decimals: 1, higherIsBetter: true,
    data: benchRows.map(r => ({ date: r.report_date, value: r.bench_e1rm_kg })),
  });
  trendSeries.push({
    key: "pred_5k",
    label: sv.pred5k.label,
    unit: "min", color: "#38bdf8", decimals: 1, higherIsBetter: false,
    data: dailyRows.map(r => ({ date: r.date, value: r.predicted_5k_secs != null ? r.predicted_5k_secs / 60 : null })),
  });
  trendSeries.push({
    key: "pred_10k",
    label: sv.pred10k.label,
    unit: "min", color: "#34d399", decimals: 1, higherIsBetter: false,
    data: dailyRows.map(r => ({ date: r.date, value: r.predicted_10k_secs != null ? r.predicted_10k_secs / 60 : null })),
  });
  trendSeries.push({
    key: "pred_half_marathon",
    label: sv.predHalfMarathon.label,
    unit: "min", color: "#f59e0b", decimals: 1, higherIsBetter: false,
    data: dailyRows.map(r => ({ date: r.date, value: r.predicted_half_marathon_secs != null ? r.predicted_half_marathon_secs / 60 : null })),
  });
  trendSeries.push({
    key: "pred_marathon",
    label: sv.predMarathon.label,
    unit: "min", color: "#f87171", decimals: 1, higherIsBetter: false,
    data: dailyRows.map(r => ({ date: r.date, value: r.predicted_marathon_secs != null ? r.predicted_marathon_secs / 60 : null })),
  });

  const [syncHistoryBefore, syncHistoryAfter] = t.header.syncHistoryHint.split("{cmd}");

  return (
    <div className="page">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>{t.header.title}</h1>
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          {t.header.subtitle}
          {!useDailyMetrics && dailyRows.length === 0 && (
            <span style={{ color: "var(--amber)", marginLeft: 8 }}>
              · {syncHistoryBefore}<code style={{ fontFamily: "var(--mono)" }}>--sync-history</code>{syncHistoryAfter}
            </span>
          )}
        </p>
      </div>

      <ProgressTabs
        weeklyReview={weeklyReview}
        trendSeries={trendSeries}
        analysisHtml={latest?.analysis_html ?? null}
        planningHtml={latest?.planning_html ?? null}
        latestAnalysisDate={latest?.report_date ?? null}
        events={events}
        completedActivities={completedActivities}
        completedExerciseSets={completedExerciseSets}
        scheduledDays={scheduledDays}
      />
    </div>
  );
}

function forwardFill(
  series: { date: string; value: number | null }[],
): { date: string; value: number | null }[] {
  let last: number | null = null;
  return series.map(p => {
    if (p.value !== null) last = p.value;
    return { date: p.date, value: last };
  });
}
