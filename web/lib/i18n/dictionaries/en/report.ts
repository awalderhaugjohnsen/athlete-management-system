// Progress / Report page — app/(app)/report/page.tsx and app/(app)/report/ProgressTabs.tsx.
// Keep in sync with dictionaries/no/report.ts (exact same shape).
export const report = {
  header: {
    title: "Progress",
    subtitle: "Weekly reviews, long-term trends, and season analysis",
    // {cmd} is replaced with a <code>--sync-history</code> element, not plain text.
    syncHistoryHint: "Run {cmd} to load full Garmin history",
  },
  tabs: {
    thisWeek: "This week",
    trends: "Trends",
    seasonAnalysis: "Season analysis",
    exercises: "Exercises",
  },
  exercises: {
    strengthTitle: "Strength exercises",
    runningTitle: "Running session types",
    noExercises: "No completed strength sets yet.",
    noSessionTypes: "No completed runs matched to a scheduled session type yet.",
    onlyOneSession: "Only one logged session so far ({value}) — check back after your next one.",
  },
  week: {
    weekOf: "Week of {date}",
    emptyTitle: "No weekly review yet",
    emptyBody: "Generated automatically during each weekly check-in.",
    vsLastWeek: "vs last week",
    kpiDelta: {
      hrv: "HRV",
      rhr: "Resting HR",
      sleepHours: "Sleep",
    },
  },
  trends: {
    hint: "Colored dots show zone status · click any chart to expand",
    emptyTitle: "Not enough history yet",
    // {cmd} is replaced with a <code>--sync-history</code> element, not plain text.
    emptyBody: "Run {cmd} to backfill from Garmin.",
    notEnoughData: "Not enough data",
    daysCount: "{count} days",
    hoverToInspect: "Hover to inspect",
    hoverToInspectInline: "hover to inspect",
    anomaliesFlagged: "{count} anomalies flagged",
    anomalyLabel: "anomaly",
    perWeek: "/ 7d",
    close: "Close",
    status: {
      onTarget: "On target",
      optimal: "Optimal",
      caution: "Caution",
      risk: "Risk",
    },
    pmcStatus: {
      raceReady: "race-ready",
      caution: "caution",
      risk: "risk",
    },
    units: {
      load: "load",
      hours: "h",
      ctlPerWeek: "CTL/wk",
    },
    series: {
      acwr: {
        label: "Workload Ratio (ACWR)",
        zones: {
          underTraining: { label: "Under-training (<0.8)", chart: "Under-training" },
          optimal: { label: "Optimal zone (0.8–1.3)", chart: "Optimal Zone" },
          risk: { label: "Risk zone (>1.3)", chart: "Risk Zone" },
        },
      },
      ctl: { label: "Fitness (CTL)" },
      tsb: {
        label: "Form (TSB)",
        zones: {
          overreaching: { label: "Overreaching (<-30)", chart: "Overreaching" },
          trainingLoad: { label: "Training load (-30–-10)", chart: "Training load" },
          raceReady: { label: "Race-ready (-10 to +5)", chart: "Race-ready" },
          fresh: { label: "Fresh (+5 to +25)", chart: "Fresh" },
          overtapered: { label: "Overtapered (>+25)", chart: "Overtapered" },
        },
      },
      atl: { label: "Fatigue (ATL)" },
      recovery: {
        label: "Recovery Score",
        zones: {
          required: { label: "Recovery required (<40)", chart: "Recovery required" },
          caution: { label: "Caution zone (40–65)", chart: "Caution" },
          optimal: { label: "Optimal recovery (>65)", chart: "Optimal recovery" },
        },
      },
      vo2max: { label: "VO₂max" },
      hrv: {
        label: "HRV (overnight)",
        shortLabel: "HRV",
        zones: {
          suppressed: { label: "Suppressed (>2 SD below)", chart: "Suppressed" },
          low: { label: "Low (1–2 SD below)", chart: "Low" },
          baseline: { labelTemplate: "Baseline ±1 SD ({value} ms)", chart: "Baseline" },
          elevated: { label: "Elevated (>1 SD above)", chart: "Elevated" },
        },
        lines: {
          baselineTemplate: "Baseline {value} ms",
        },
      },
      sleepScore: {
        label: "Sleep Score",
        zones: {
          poor: { label: "Poor (<50)", chart: "Poor" },
          fair: { label: "Fair (50–70)", chart: "Fair" },
          good: { label: "Good (>70)", chart: "Good" },
        },
      },
      sleepHours: {
        label: "Sleep Hours",
        zones: {
          tooLittle: { label: "Too little (<6 h)", chart: "Too little" },
          marginal: { label: "Marginal (6–7 h)", chart: "Marginal" },
          optimal: { label: "Optimal (7–9 h)", chart: "Optimal" },
          long: { label: "Long (>9 h)", chart: "Long" },
        },
      },
      rhr: {
        label: "Resting Heart Rate",
        zones: {
          excellent: { label: "Excellent (<50)", chart: "Excellent" },
          good: { label: "Good (50–60)", chart: "Good" },
          moderate: { label: "Moderate (60–70)", chart: "Moderate" },
          elevated: { label: "Elevated (>70)", chart: "Elevated" },
        },
      },
      bodyBattery: {
        label: "Body Battery (EOD)",
        zones: {
          depleted: { label: "Depleted (<25)", chart: "Depleted" },
          low: { label: "Low (25–50)", chart: "Low" },
          good: { label: "Good (>50)", chart: "Good" },
        },
      },
      stress: {
        label: "Daily Stress",
        zones: {
          low: { label: "Low (<25)", chart: "Low" },
          moderate: { label: "Moderate (25–50)", chart: "Moderate" },
          high: { label: "High (>50)", chart: "High stress" },
        },
      },
      rampRate: {
        label: "Load Adaptation Rate",
        zones: {
          detraining: { label: "Detraining (<-5)", chart: "Detraining" },
          recovery: { label: "Recovery (-5–0)", chart: "Recovery" },
          optimalBuild: { label: "Optimal build (0–7)", chart: "Optimal build" },
          caution: { label: "Caution (7–12)", chart: "Caution" },
          injuryRisk: { label: "Injury risk (>12)", chart: "Injury risk" },
        },
        lines: {
          caution: "caution",
          injuryRisk: "injury risk",
        },
      },
      weight: { label: "Body Weight" },
      calories: { label: "Calories Burned" },
      benchE1rm: { label: "Bench e1RM (Epley)" },
      pred5k: { label: "Predicted 5K" },
      pred10k: { label: "Predicted 10K" },
      predHalfMarathon: { label: "Predicted Half Marathon" },
      predMarathon: { label: "Predicted Marathon" },
    },
  },
  pmc: {
    title: "Performance Management",
    legendDefinitions: "CTL = chronic fitness load · ATL = acute fatigue load · TSB = form (CTL − ATL)",
    fitnessAndFatigue: "Fitness & Fatigue",
  },
  analysis: {
    generatedOn: "Generated {date}",
    analysisTab: "Analysis",
    planningTab: "Training plan",
  },
};
