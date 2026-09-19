"use client";

// See .claude/backlog/per-exercise-progress-tab.md. Per-exercise and per-running-session-type
// history — lists distinct strength exercises (grouped by display_name) and running session
// types (derived by matching completed runs to scheduled_days for the same date), and renders
// a progress chart for whichever one is selected. Reuses ExpandedChart, the same hand-rolled
// inline-SVG chart already used by the Trends tab, rather than adding a charting library.
import { useMemo, useState } from "react";
import type { CompletedActivity, CompletedExerciseSet, ScheduledDay } from "@/lib/types";
import { groupSetsByExercise, deriveRunningSessionTypeHistory } from "@/lib/exerciseProgress";
import { ExpandedChart, type TrendSeries } from "./ProgressTabs";
import { useT } from "@/lib/i18n/LanguageContext";

export interface ExerciseProgressTabProps {
  completedSets: CompletedExerciseSet[];
  completedActivities: CompletedActivity[];
  scheduledDays: ScheduledDay[];
}

type Selection = { kind: "exercise" | "running"; name: string } | null;

/** Picks the most informative metric the data actually supports, uniformly across every
 * point in a session-type's history — pace when every point has both distance and duration,
 * falling back to distance, then duration, so a chart never mixes units across its own points. */
function runningMetric(points: { distanceMeters: number | null; durationSecs: number | null }[]): {
  label: string;
  unit: string;
  decimals: number;
  higherIsBetter: boolean;
  values: (number | null)[];
} {
  const allHavePace = points.length > 0 && points.every(p =>
    p.distanceMeters != null && p.distanceMeters > 0 && p.durationSecs != null);
  if (allHavePace) {
    return {
      label: "Pace", unit: "min/km", decimals: 2, higherIsBetter: false,
      values: points.map(p => (p.durationSecs! / 60) / (p.distanceMeters! / 1000)),
    };
  }
  const anyHaveDistance = points.some(p => p.distanceMeters != null);
  if (anyHaveDistance) {
    return {
      label: "Distance", unit: "km", decimals: 2, higherIsBetter: true,
      values: points.map(p => p.distanceMeters != null ? p.distanceMeters / 1000 : null),
    };
  }
  return {
    label: "Duration", unit: "min", decimals: 1, higherIsBetter: true,
    values: points.map(p => p.durationSecs != null ? p.durationSecs / 60 : null),
  };
}

/** Single explicit state for <2 points — allowed outright by the acceptance criteria rather
 * than forcing ExpandedChart's axis/scale math (which assumes at least 2 points) to cope. */
function InsufficientDataChart({ pointCount, label, valueLabel }: { pointCount: number; label: string; valueLabel: string | null }) {
  const t = useT().report;
  return (
    <div className="card" data-testid="exercise-chart" data-point-count={pointCount}
      style={{ padding: "24px", textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{label}</div>
      {pointCount === 1 && valueLabel ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          {t.exercises.onlyOneSession.replace("{value}", valueLabel)}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--dim)" }}>{t.trends.notEnoughData}</div>
      )}
    </div>
  );
}

function ProgressChart({ series, pointCount }: { series: TrendSeries; pointCount: number }) {
  if (pointCount < 2) {
    const only = series.data.find(d => d.value != null);
    const valueLabel = only ? `${only.value!.toFixed(series.decimals ?? 1)}${series.unit ? ` ${series.unit}` : ""}` : null;
    return <InsufficientDataChart pointCount={pointCount} label={series.label} valueLabel={valueLabel} />;
  }
  return (
    <div data-testid="exercise-chart" data-point-count={pointCount}>
      <ExpandedChart series={series} events={[]} showAnomalies={false} />
    </div>
  );
}

export function ExerciseProgressTab({ completedSets, completedActivities, scheduledDays }: ExerciseProgressTabProps) {
  const t = useT().report;
  const [selection, setSelection] = useState<Selection>(null);

  const exerciseHistory = useMemo(() => groupSetsByExercise(completedSets), [completedSets]);
  const runningHistory = useMemo(
    () => deriveRunningSessionTypeHistory(completedActivities, scheduledDays),
    [completedActivities, scheduledDays],
  );

  const exerciseNames = useMemo(() => [...exerciseHistory.keys()].sort((a, b) => a.localeCompare(b)), [exerciseHistory]);
  const sessionTypes = useMemo(() => [...runningHistory.keys()].sort((a, b) => a.localeCompare(b)), [runningHistory]);

  let series: TrendSeries | null = null;
  let pointCount = 0;
  if (selection?.kind === "exercise") {
    const points = exerciseHistory.get(selection.name) ?? [];
    pointCount = points.length;
    series = {
      label: selection.name,
      unit: "kg",
      color: "var(--accent)",
      decimals: 1,
      higherIsBetter: true,
      data: points.map(p => ({ date: p.date, value: p.topWeightKg })),
    };
  } else if (selection?.kind === "running") {
    const points = runningHistory.get(selection.name) ?? [];
    pointCount = points.length;
    const metric = runningMetric(points);
    series = {
      label: `${selection.name[0]?.toUpperCase()}${selection.name.slice(1)} — ${metric.label}`,
      unit: metric.unit,
      color: "#38bdf8",
      decimals: metric.decimals,
      higherIsBetter: metric.higherIsBetter,
      data: points.map((p, i) => ({ date: p.date, value: metric.values[i] })),
    };
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16, marginBottom: 16 }}>
        <section>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t.exercises.strengthTitle}</div>
          {exerciseNames.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--dim)" }}>{t.exercises.noExercises}</div>
          ) : (
            <ul data-testid="exercise-list" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {exerciseNames.map(name => (
                <li key={name}>
                  <button
                    onClick={() => setSelection(sel => sel?.kind === "exercise" && sel.name === name ? null : { kind: "exercise", name })}
                    style={{
                      width: "100%", textAlign: "left", cursor: "pointer", fontSize: 13,
                      padding: "7px 10px", borderRadius: "var(--radius-sm)",
                      background: selection?.kind === "exercise" && selection.name === name ? "var(--accent)" : "none",
                      color: selection?.kind === "exercise" && selection.name === name ? "white" : "var(--text)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t.exercises.runningTitle}</div>
          {sessionTypes.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--dim)" }}>{t.exercises.noSessionTypes}</div>
          ) : (
            <ul data-testid="session-type-list" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {sessionTypes.map(type => (
                <li key={type}>
                  <button
                    onClick={() => setSelection(sel => sel?.kind === "running" && sel.name === type ? null : { kind: "running", name: type })}
                    style={{
                      width: "100%", textAlign: "left", cursor: "pointer", fontSize: 13,
                      padding: "7px 10px", borderRadius: "var(--radius-sm)",
                      background: selection?.kind === "running" && selection.name === type ? "var(--accent)" : "none",
                      color: selection?.kind === "running" && selection.name === type ? "white" : "var(--text)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {type}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {series && <ProgressChart series={series} pointCount={pointCount} />}
    </div>
  );
}
