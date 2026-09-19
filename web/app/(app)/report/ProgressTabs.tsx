"use client";

import React, { useState, useRef } from "react";
import type { CompletedActivity, CompletedExerciseSet, ScheduledDay } from "@/lib/types";
import { ActivityHeatmap } from "../ActivityHeatmap";
import { ExerciseProgressTab } from "./ExerciseProgressTab";
import { useLanguage, useT } from "@/lib/i18n/LanguageContext";
import { localeTag, type Language } from "@/lib/i18n/language";

export interface TrendPoint {
  date: string;
  value: number | null;
}

export interface ZoneBand {
  min: number;
  max: number;
  fill: string;
  severity?: "optimal" | "warning" | "danger" | "neutral";
  label?: string;       // legend label
  chartLabel?: string;  // short label drawn inside the band on the chart
}

export interface ZoneLine {
  value: number;
  label: string;
  color: string;
}

export interface TrendSeries {
  label: string;
  // Stable, language-independent identifier used to match a series across renders/
  // language switches (e.g. to pick CTL/ATL/TSB out for the PMC chart). Optional so
  // callers outside this page (e.g. the dashboard's own TrendSeries literals) that
  // don't set it keep working — they just don't participate in that matching.
  key?: string;
  unit?: string;
  color: string;
  data: TrendPoint[];
  decimals?: number;
  higherIsBetter?: boolean;
  zoneBands?: ZoneBand[];
  zoneLines?: ZoneLine[];
  chartType?: "line" | "bar";
}

export interface RaceEvent {
  name: string;
  date: string;
  priority?: string;
}

// ── Shared constants ──────────────────────────────────────────────────────────

const SEV: Record<NonNullable<ZoneBand["severity"]>, string> = {
  optimal: "var(--green)",
  warning: "var(--amber)",
  danger:  "var(--red)",
  neutral: "var(--dim)",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getZoneSeverity(value: number | null, bands?: ZoneBand[]): ZoneBand["severity"] | null {
  if (value == null || !bands?.length) return null;
  const b = bands.find(b =>
    value >= (isFinite(b.min) ? b.min : -1e9) &&
    value <= (isFinite(b.max) ? b.max : 1e9),
  );
  return b?.severity ?? null;
}

function getZoneColor(value: number, bands?: ZoneBand[], fallback = "var(--dim)"): string {
  const sev = getZoneSeverity(value, bands);
  return sev ? SEV[sev] : fallback;
}

function fmtDate(iso: string, language: Language, long = false): string {
  return new Date(iso).toLocaleDateString(localeTag(language), long
    ? { day: "numeric", month: "long", year: "numeric" }
    : { day: "numeric", month: "short" });
}

/** Stable identifier for a series — falls back to its (possibly untranslated) label
 * for series that don't set `key`, e.g. ones built outside this page. */
function seriesKey(s: TrendSeries): string {
  return s.key ?? s.label;
}

function extractMain(html: string): string {
  const s = html.indexOf("<main"), e = html.lastIndexOf("</main>");
  if (s === -1 || e === -1) return html;
  return html.slice(html.indexOf(">", s) + 1, e);
}

// Each segment between two points colored by midpoint zone — line turns red in danger zones.
function coloredSegments(
  points: { value: number }[],
  xS: (i: number) => number,
  yS: (v: number) => number,
  bands?: ZoneBand[],
  fallback = "var(--dim)",
): Array<{ d: string; color: string }> {
  return points.slice(0, -1).map((p, i) => ({
    d: `M ${xS(i).toFixed(1)} ${yS(p.value).toFixed(1)} L ${xS(i + 1).toFixed(1)} ${yS(points[i + 1].value).toFixed(1)}`,
    color: getZoneColor((p.value + points[i + 1].value) / 2, bands, fallback),
  }));
}

// Compute a nice y-axis with rounded tick values (multiples of 1, 2, 5, 10, 25, 50…)
function niceAxis(min: number, max: number, targetTicks = 5) {
  const range = max - min || 1;
  const roughStep = range / (targetTicks - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  let step = magnitude * 10;
  for (const n of [1, 2, 5, 10]) {
    if (magnitude * n >= roughStep) { step = magnitude * n; break; }
  }
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step * 0.001; v += step)
    ticks.push(Math.round(v * 1e9) / 1e9);
  return { min: niceMin, max: niceMax, step, ticks };
}

// Draw zone bands + optional in-chart labels
function ZoneBands({
  bands, yC, plotLeft, plotWidth, plotTop, plotH, effMin: _effMin, effMax: _effMax,
}: {
  bands: ZoneBand[];
  yC: (v: number) => number;
  plotLeft: number; plotWidth: number; plotTop: number; plotH: number;
  effMin: number; effMax: number;
}) {
  return (
    <>
      {bands.map((band, i) => {
        const y1 = band.max === Infinity ? plotTop : yC(band.max);
        const y2 = band.min === -Infinity ? plotTop + plotH : yC(band.min);
        if (y2 <= y1) return null;
        const hasLabel = band.chartLabel && y2 - y1 >= 18;
        return (
          <g key={i}>
            <rect x={plotLeft} y={y1} width={plotWidth} height={y2 - y1} fill={band.fill} />
            {hasLabel && (
              <text
                x={plotLeft + 7} y={y1 + Math.min(14, (y2 - y1) / 2 + 4)}
                fontSize={10} fontWeight={700}
                fill={band.severity ? SEV[band.severity] : "var(--dim)"}
                opacity={0.9}
              >
                {band.chartLabel}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

// Race/event vertical marker
function EventMarker({
  x, name, priority, top, bottom,
}: {
  x: number; name: string; priority?: string; top: number; bottom: number;
}) {
  const isA = priority === "A";
  return (
    <g>
      <line x1={x} y1={top} x2={x} y2={bottom}
        stroke={isA ? "var(--amber)" : "var(--dim)"}
        strokeWidth={isA ? 1.5 : 1}
        strokeDasharray="5,3" />
      <rect x={x - 1} y={top} width={name.length * 5.5 + 6} height={13}
        fill={isA ? "rgba(var(--amber-rgb),.13)" : "rgba(var(--dim-rgb),.13)"} rx={2} />
      <text x={x + 3} y={top + 9.5} fontSize={9} fontWeight={700}
        fill={isA ? "var(--amber)" : "var(--dim)"}>
        {name.length > 14 ? name.slice(0, 13) + "…" : name}
      </text>
    </g>
  );
}

// ── PMC: Performance Management Chart ────────────────────────────────────────

export function PMCChart({
  ctlData, atlData, tsbData, events,
}: {
  ctlData: TrendPoint[]; atlData: TrendPoint[]; tsbData: TrendPoint[];
  events: RaceEvent[];
}) {
  const t = useT().report;
  const [language] = useLanguage();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [timeframe, setTimeframe] = useState<"1M" | "3M" | "6M" | "1Y">("3M");

  const allDates = Array.from(new Set([
    ...ctlData.map(d => d.date),
    ...atlData.map(d => d.date),
    ...tsbData.map(d => d.date),
  ])).sort();

  if (allDates.length < 3) return null;

  const tfDays = { "1M": 30, "3M": 90, "6M": 180, "1Y": 365 }[timeframe];
  const cutoffMs = new Date(allDates.at(-1)!).getTime() - tfDays * 86400000;
  const visibleDates = allDates.filter(d => new Date(d).getTime() >= cutoffMs);

  const byDate = (data: TrendPoint[]) => {
    const m = new Map(data.map(d => [d.date, d.value]));
    return visibleDates.map(d => ({ date: d, value: m.get(d) ?? null }));
  };

  const ctl = byDate(ctlData), atl = byDate(atlData), tsb = byDate(tsbData);

  const ctlVals = ctl.flatMap(d => d.value != null ? [d.value] : []);
  const atlVals = atl.flatMap(d => d.value != null ? [d.value] : []);
  const tsbVals = tsb.flatMap(d => d.value != null ? [d.value] : []);
  if (ctlVals.length < 3) return null;

  const W = 900;
  const TOP_H = 200, BOT_H = 190;
  const TOP_PAD = { top: 20, right: 52, bottom: 12, left: 52 };
  const BOT_PAD = { top: 12, right: 52, bottom: 36, left: 52 };
  const plotW = W - TOP_PAD.left - TOP_PAD.right;
  const topPlotH = TOP_H - TOP_PAD.top - TOP_PAD.bottom;
  const botPlotH = BOT_H - BOT_PAD.top - BOT_PAD.bottom;

  // Time-proportional X axis
  const t0 = new Date(visibleDates[0]).getTime();
  const tEnd = new Date(visibleDates.at(-1)!).getTime();
  const tRange = tEnd - t0 || 1;
  const xS = (i: number) => TOP_PAD.left + ((new Date(visibleDates[i]).getTime() - t0) / tRange) * plotW;
  const xFromMs = (ms: number) => TOP_PAD.left + ((ms - t0) / tRange) * plotW;

  // CTL/ATL Y-axis
  const laMax = Math.ceil(Math.max(...ctlVals, ...atlVals) * 1.15 / 25) * 25;
  const laMin = 0;
  const laRange = laMax - laMin || 1;
  const yL = (v: number) => TOP_PAD.top + topPlotH - ((v - laMin) / laRange) * topPlotH;
  const yLTicks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(laMax * f));

  // TSB Y-axis: always covers full zone context (zone boundaries ±30 minimum)
  const tsbAbsMax = Math.max(...tsbVals.map(Math.abs), 35);
  const { min: tsbNiceMin, max: tsbNiceMax, ticks: tsbTicks } = niceAxis(-tsbAbsMax * 1.1, tsbAbsMax * 1.1, 7);
  const tsbNiceRange = tsbNiceMax - tsbNiceMin || 1;
  const yT = (v: number) => BOT_PAD.top + botPlotH - ((v - tsbNiceMin) / tsbNiceRange) * botPlotH;
  const yTC = (v: number) => Math.max(BOT_PAD.top, Math.min(BOT_PAD.top + botPlotH, yT(v)));
  const tsbZeroY = yTC(0);

  const tsbZones = t.trends.series.tsb.zones;
  const tsbBands: ZoneBand[] = [
    { min: -Infinity, max: -30, fill: "rgba(239,68,68,0.16)",   severity: "danger",  chartLabel: tsbZones.overreaching.chart, label: tsbZones.overreaching.label },
    { min: -30,       max: -10, fill: "rgba(245,158,11,0.13)",  severity: "warning", chartLabel: tsbZones.trainingLoad.chart, label: tsbZones.trainingLoad.label },
    { min: -10,       max:   5, fill: "rgba(34,197,94,0.14)",   severity: "optimal", chartLabel: tsbZones.raceReady.chart,    label: tsbZones.raceReady.label },
    { min:   5,       max:  25, fill: "rgba(148,163,184,0.09)", severity: "neutral", chartLabel: tsbZones.fresh.chart,        label: tsbZones.fresh.label },
    { min:  25, max: Infinity,  fill: "rgba(245,158,11,0.11)",  severity: "warning", chartLabel: tsbZones.overtapered.chart,  label: tsbZones.overtapered.label },
  ];

  const ctlPts = ctl.flatMap((d, i) => d.value != null ? [{ idx: i, value: d.value }] : []);
  const atlPts = atl.flatMap((d, i) => d.value != null ? [{ idx: i, value: d.value }] : []);
  const tsbPts = tsb.flatMap((d, i) => d.value != null ? [{ idx: i, value: d.value }] : []);

  const ctlLine = ctlPts.length >= 2
    ? ctlPts.map((p, j) => `${j === 0 ? "M" : "L"} ${xS(p.idx).toFixed(1)} ${yL(p.value).toFixed(1)}`).join(" ")
    : null;
  const atlLine = atlPts.length >= 2
    ? atlPts.map((p, j) => `${j === 0 ? "M" : "L"} ${xS(p.idx).toFixed(1)} ${yL(p.value).toFixed(1)}`).join(" ")
    : null;
  // Gradient-fade area fills under CTL/ATL, matching the dashboard's
  // FitnessTrendChart (ctl-grad/atl-grad) so the two "same metric, two
  // places" charts read as the same visual language.
  const topBaseline = TOP_PAD.top + topPlotH;
  const ctlArea = ctlLine
    ? `${ctlLine} L ${xS(ctlPts[ctlPts.length - 1].idx).toFixed(1)} ${topBaseline.toFixed(1)} L ${xS(ctlPts[0].idx).toFixed(1)} ${topBaseline.toFixed(1)} Z`
    : null;
  const atlArea = atlLine
    ? `${atlLine} L ${xS(atlPts[atlPts.length - 1].idx).toFixed(1)} ${topBaseline.toFixed(1)} L ${xS(atlPts[0].idx).toFixed(1)} ${topBaseline.toFixed(1)} Z`
    : null;

  const spanDays = tRange / 86400000 || 1;
  const barW = Math.max(2, (plotW / spanDays) * 0.8);
  // Inset TSB bar scale so the outer edges of the first/last bar align with the plot boundary
  const tsbBarPlotW = plotW - barW;
  const tsbXS = (i: number) => BOT_PAD.left + barW / 2 + ((new Date(visibleDates[i]).getTime() - t0) / tRange) * tsbBarPlotW;

  // Monthly X-axis ticks (bottom chart only)
  const xMonthTicks: Array<{ x: number; label: string }> = [];
  {
    const cur = new Date(visibleDates[0]);
    cur.setDate(1); cur.setMonth(cur.getMonth() + 1);
    const end = new Date(visibleDates.at(-1)!);
    const spanDays = (tEnd - t0) / 86400000;
    const fmt: Intl.DateTimeFormatOptions = spanDays > 400
      ? { month: "short", year: "2-digit" }
      : { month: "short" };
    while (cur <= end) {
      const ms = cur.getTime();
      if (ms > t0 && ms < tEnd)
        xMonthTicks.push({ x: xFromMs(ms), label: cur.toLocaleDateString(localeTag(language), fmt) });
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    let closest = 0, dist = Infinity;
    visibleDates.forEach((_, i) => { const d = Math.abs(xS(i) - svgX); if (d < dist) { dist = d; closest = i; } });
    setHoverIdx(closest);
  }

  const hov = hoverIdx != null ? {
    date: visibleDates[hoverIdx],
    ctl: ctl[hoverIdx]?.value,
    atl: atl[hoverIdx]?.value,
    tsb: tsb[hoverIdx]?.value,
  } : null;
  const hovTsbSev = getZoneSeverity(hov?.tsb ?? null, tsbBands);

  const chartStart = visibleDates[0], chartEnd = visibleDates.at(-1)!;
  const visibleEvents = events.filter(e => e.date >= chartStart && e.date <= chartEnd);

  return (
    <div className="card" style={{ padding: "20px 24px", marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 2 }}>{t.pmc.title}</div>
          <div style={{ fontSize: 11, color: "var(--dim)", marginBottom: 6 }}>
            {t.pmc.legendDefinitions}
          </div>
          {hov ? (
            <div style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--dim)" }}>{fmtDate(hov.date, language, true)}</span>
              {hov.ctl != null && <span style={{ fontSize: 13, fontFamily: "var(--mono)", color: "var(--accent)" }}>CTL {hov.ctl.toFixed(1)}</span>}
              {hov.atl != null && <span style={{ fontSize: 13, fontFamily: "var(--mono)", color: "var(--red)" }}>ATL {hov.atl.toFixed(1)}</span>}
              {hov.tsb != null && (
                <span style={{ fontSize: 13, fontFamily: "var(--mono)", color: hovTsbSev ? SEV[hovTsbSev] : "var(--dim)", fontWeight: 700 }}>
                  TSB {hov.tsb > 0 ? "+" : ""}{hov.tsb.toFixed(1)}
                  {hovTsbSev && <span style={{ fontSize: 10, marginLeft: 5, fontFamily: "sans-serif" }}>
                    ({hovTsbSev === "optimal" ? t.trends.pmcStatus.raceReady : hovTsbSev === "warning" ? t.trends.pmcStatus.caution : t.trends.pmcStatus.risk})
                  </span>}
                </span>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--dim)" }}>{t.trends.hoverToInspect} · {t.trends.daysCount.replace("{count}", String(visibleDates.length))}</div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--muted)", alignItems: "center" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <svg width="20" height="3" style={{ display: "block" }}><line x1="0" y1="1.5" x2="20" y2="1.5" stroke="var(--accent)" strokeWidth="2.5" /></svg> CTL
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <svg width="20" height="3" style={{ display: "block" }}><line x1="0" y1="1.5" x2="20" y2="1.5" stroke="var(--red)" strokeWidth="2" strokeDasharray="4,2" /></svg> ATL
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(34,197,94,0.55)" }} /> TSB+
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(239,68,68,0.45)" }} /> TSB−
            </span>
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            {(["1M", "3M", "6M", "1Y"] as const).map(tf => (
              <button key={tf} onClick={() => { setTimeframe(tf); setHoverIdx(null); }} style={{
                background: timeframe === tf ? "var(--accent)" : "none",
                border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer",
                padding: "2px 9px", fontSize: 11, fontWeight: 700,
                color: timeframe === tf ? "white" : "var(--muted)",
                transition: "background .15s, color .15s",
              }}>
                {tf}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Top chart: CTL + ATL */}
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: "var(--dim)", fontWeight: 600, marginBottom: 4, paddingLeft: TOP_PAD.left }}>
          {t.pmc.fitnessAndFatigue}
        </div>
        <svg viewBox={`0 0 ${W} ${TOP_H}`} style={{ width: "100%", display: "block", cursor: "crosshair" }}
          preserveAspectRatio="xMidYMid meet"
          onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIdx(null)}>

          <defs>
            <linearGradient id="pmc-ctl-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.26" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="pmc-atl-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--red)" stopOpacity="0.20" />
              <stop offset="100%" stopColor="var(--red)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {ctlArea && <path d={ctlArea} fill="url(#pmc-ctl-grad)" />}
          {atlArea && <path d={atlArea} fill="url(#pmc-atl-grad)" />}

          {yLTicks.map((v, i) => (
            <g key={i}>
              <line x1={TOP_PAD.left} y1={yL(v)} x2={W - TOP_PAD.right} y2={yL(v)}
                stroke="var(--border)" strokeWidth={0.5}
                strokeDasharray={i === 0 || i === yLTicks.length - 1 ? undefined : "3,6"} />
              <text x={TOP_PAD.left - 6} y={yL(v) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{v}</text>
            </g>
          ))}

          {visibleEvents.map((ev, i) => {
            const idx = visibleDates.indexOf(ev.date);
            if (idx === -1) return null;
            return <EventMarker key={i} x={xS(idx)} name={ev.name} priority={ev.priority} top={TOP_PAD.top} bottom={TOP_PAD.top + topPlotH} />;
          })}

          {ctlLine && <path d={ctlLine} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}
          {atlLine && <path d={atlLine} fill="none" stroke="var(--red)" strokeWidth={2} strokeDasharray="6,3" strokeLinejoin="round" strokeLinecap="round" />}

          {hoverIdx != null && (() => {
            const hx = xS(hoverIdx);
            const ctlV = ctl[hoverIdx]?.value, atlV = atl[hoverIdx]?.value;
            return (
              <>
                <line x1={hx} y1={TOP_PAD.top} x2={hx} y2={TOP_PAD.top + topPlotH}
                  stroke="var(--muted)" strokeWidth={1} strokeDasharray="3,3" opacity={0.4} />
                {ctlV != null && <circle cx={hx} cy={yL(ctlV)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />}
                {atlV != null && <circle cx={hx} cy={yL(atlV)} r={4} fill="var(--red)" stroke="var(--surface)" strokeWidth={2} />}
              </>
            );
          })()}
        </svg>
      </div>

      {/* Bottom chart: TSB bars */}
      <div>
        <div style={{ fontSize: 11, color: "var(--dim)", fontWeight: 600, marginBottom: 4, paddingLeft: BOT_PAD.left }}>
          {t.trends.series.tsb.label}
        </div>
        <svg viewBox={`0 0 ${W} ${BOT_H}`} style={{ width: "100%", display: "block", cursor: "crosshair" }}
          preserveAspectRatio="xMidYMid meet"
          onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIdx(null)}>

          <ZoneBands bands={tsbBands} yC={yTC}
            plotLeft={BOT_PAD.left} plotWidth={plotW} plotTop={BOT_PAD.top} plotH={botPlotH}
            effMin={tsbNiceMin} effMax={tsbNiceMax} />

          {tsbTicks.map((v, i) => (
            <g key={i}>
              <line x1={BOT_PAD.left} y1={yTC(v)} x2={W - BOT_PAD.right} y2={yTC(v)}
                stroke="var(--border)" strokeWidth={0.5}
                strokeDasharray={v === 0 ? undefined : "3,6"} />
              <text x={BOT_PAD.left - 6} y={yTC(v) + 4} textAnchor="end" fontSize={10}
                fill={v === 0 ? "var(--muted)" : v < 0 ? "var(--red)" : "var(--green)"}
                fontWeight={v === 0 ? 700 : 400}>
                {v > 0 ? `+${v}` : v}
              </text>
            </g>
          ))}

          <line x1={BOT_PAD.left} y1={tsbZeroY} x2={W - BOT_PAD.right} y2={tsbZeroY}
            stroke="rgba(148,163,184,0.5)" strokeWidth={1} />

          {tsbPts.map(p => {
            const bx = tsbXS(p.idx) - barW / 2;
            const barColor = getZoneColor(p.value, tsbBands, p.value >= 0 ? "var(--green)" : "var(--red)");
            const barTop = p.value >= 0 ? yTC(p.value) : tsbZeroY;
            const barBot = p.value >= 0 ? tsbZeroY : yTC(p.value);
            return (
              <rect key={p.idx} x={bx.toFixed(1)} y={barTop.toFixed(1)}
                width={barW.toFixed(1)} height={Math.max(1, barBot - barTop).toFixed(1)}
                fill={barColor} opacity={hoverIdx === p.idx ? 1 : 0.75} rx={1} />
            );
          })}

          {xMonthTicks.map((t, i) => (
            <g key={i}>
              <line x1={t.x} y1={BOT_PAD.top + botPlotH} x2={t.x} y2={BOT_PAD.top + botPlotH + 4}
                stroke="var(--border)" strokeWidth={1} />
              <text x={t.x} y={BOT_H - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">{t.label}</text>
            </g>
          ))}

          {hoverIdx != null && (() => {
            const hx = tsbXS(hoverIdx);
            const tsbV = tsb[hoverIdx]?.value;
            return (
              <>
                <line x1={hx} y1={BOT_PAD.top} x2={hx} y2={BOT_PAD.top + botPlotH}
                  stroke="var(--muted)" strokeWidth={1} strokeDasharray="3,3" opacity={0.4} />
                {tsbV != null && <circle cx={hx} cy={yTC(tsbV)} r={4}
                  fill={hovTsbSev ? SEV[hovTsbSev] : "var(--dim)"} stroke="var(--surface)" strokeWidth={2} />}
              </>
            );
          })()}
        </svg>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
        {tsbBands.filter(b => b.label && b.severity).map((b, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: b.severity ? SEV[b.severity] : "var(--dim)", opacity: 0.8 }} />
            <span style={{ fontSize: 10, color: "var(--muted)" }}>TSB: {b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Compact sparkline card ────────────────────────────────────────────────────

function CompactChart({ series, selected, onClick }: { series: TrendSeries; selected: boolean; onClick: () => void }) {
  const t = useT().report;
  const points = series.data.filter((d): d is { date: string; value: number } => d.value !== null);
  const dec = series.decimals ?? 1;
  const W = 300, H = 52, PAD = 4;
  // Unique per series so multiple CompactChart instances on the same page
  // (one per metric card) don't collide on SVG gradient ids.
  const gradId = `cc-grad-${seriesKey(series).replace(/[^a-zA-Z0-9]+/g, "-")}`;
  const latest = points.at(-1), prev = points.length > 7 ? points.at(-8) : points[0];
  const delta = latest && prev ? latest.value - prev.value : null;
  const severity = getZoneSeverity(latest?.value ?? null, series.zoneBands);
  const statusColor = severity ? SEV[severity] : null;

  let pathD = "", areaD = "";
  if (points.length >= 2) {
    const vals = points.map(d => d.value), minV = Math.min(...vals), maxV = Math.max(...vals), rng = maxV - minV || 1;
    const xS = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const yS = (v: number) => PAD + (H - PAD * 2) - ((v - minV) / rng) * (H - PAD * 2);
    pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xS(i).toFixed(1)} ${yS(p.value).toFixed(1)}`).join(" ");
    areaD = `${pathD} L ${xS(points.length - 1).toFixed(1)} ${H - PAD} L ${xS(0).toFixed(1)} ${H - PAD} Z`;
  }

  const rising = (delta ?? 0) > 0.01, falling = (delta ?? 0) < -0.01;
  let deltaColor = "var(--dim)";
  if (series.higherIsBetter === true)  deltaColor = rising ? "var(--green)" : falling ? "var(--red)" : "var(--dim)";
  if (series.higherIsBetter === false) deltaColor = falling ? "var(--green)" : rising ? "var(--red)" : "var(--dim)";

  return (
    <div onClick={onClick} style={{
      background: "var(--surface)", border: `1.5px solid ${selected ? series.color : "var(--border)"}`,
      borderRadius: "var(--radius)", padding: "14px 16px 12px", cursor: "pointer",
      boxShadow: selected ? `0 0 0 3px ${series.color}22` : undefined,
      transition: "border-color .15s, box-shadow .15s", display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".7px", color: "var(--dim)" }}>{series.label}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {statusColor && <div style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, boxShadow: `0 0 0 2px ${statusColor}33`, flexShrink: 0 }} />}
          {latest
            ? <span style={{ fontSize: 20, fontWeight: 900, color: series.color, fontFamily: "var(--mono)", lineHeight: 1 }}>{latest.value.toFixed(dec)}</span>
            : <span style={{ fontSize: 12, color: "var(--dim)" }}>—</span>}
          {series.unit && <span style={{ fontSize: 11, color: "var(--dim)" }}>{series.unit}</span>}
        </div>
      </div>

      {points.length >= 2 ? (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series.color} stopOpacity="0.32" />
              <stop offset="100%" stopColor={series.color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaD} fill={`url(#${gradId})`} />
          <path d={pathD} fill="none" stroke={series.color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      ) : (
        <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 12, color: "var(--dim)" }}>{t.trends.notEnoughData}</span>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--dim)" }}>{t.trends.daysCount.replace("{count}", String(points.length))}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {delta !== null && (
            <span style={{ fontSize: 12, fontWeight: 600, color: deltaColor }}>
              {delta > 0 ? "+" : ""}{delta.toFixed(dec)}{series.unit ? ` ${series.unit}` : ""} {t.trends.perWeek}
            </span>
          )}
          {severity && (
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: statusColor ?? "var(--dim)" }}>
              {severity === "optimal" ? t.trends.status.onTarget : severity === "warning" ? t.trends.status.caution : severity === "danger" ? t.trends.status.risk : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Expanded chart: line or bar, zones, colored segments, event markers ───────

export function ExpandedChart({ series, events, onClose, showAnomalies = true, caption }: {
  series: TrendSeries; events: RaceEvent[]; onClose?: () => void; showAnomalies?: boolean; caption?: string;
}) {
  const t = useT().report;
  const [language] = useLanguage();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const points = series.data.filter((d): d is { date: string; value: number } => d.value !== null);
  const dec = series.decimals ?? 1;
  const isBar = series.chartType === "bar";
  if (points.length < 2) return null;

  const gradId = `ec-grad-${seriesKey(series).replace(/[^a-zA-Z0-9]+/g, "-")}`;

  const W = 900, H = 240;
  const PAD = { top: 28, right: 56, bottom: 40, left: 56 };
  const plotW = W - PAD.left - PAD.right, plotH = H - PAD.top - PAD.bottom;

  const dataVals = points.map(d => d.value);
  const dataMin = Math.min(...dataVals), dataMax = Math.max(...dataVals), dataRange = dataMax - dataMin || 1;

  // Collect all finite zone boundary values (zone lines + band edges)
  const thresholdVals: number[] = [
    ...(series.zoneLines?.map(l => l.value) ?? []),
    ...(series.zoneBands?.flatMap(b => [b.min, b.max].filter(isFinite)) ?? []),
  ];

  // Y-axis range strategy:
  // When zone thresholds exist, anchor the axis on the FULL zone context (boundary min → max
  // plus 20% padding), then expand further only if the data spills outside that range.
  // This gives "perspective" — you see how far from danger your data actually sits.
  let effMin: number, effMax: number;
  if (thresholdVals.length > 0) {
    const bMin = Math.min(...thresholdVals);
    const bMax = Math.max(...thresholdVals);
    const bRange = bMax - bMin || 1;
    const pad = bRange * 0.20;
    effMin = Math.min(dataMin, bMin - pad);
    effMax = Math.max(dataMax, bMax + pad);
    // For bar charts always include zero
    if (isBar) effMin = Math.min(effMin, 0);
  } else {
    effMin = isBar ? Math.min(0, dataMin - dataRange * 0.05) : dataMin - dataRange * 0.05;
    effMax = dataMax + dataRange * 0.05;
  }
  const { min: niceMin, max: niceMax, ticks: yTickVals } = niceAxis(effMin, effMax);
  const niceRange = niceMax - niceMin || 1;

  // Bar dimensions — inset the bar scale so the outer edges of the first/last bar
  // align with the plot boundary instead of overflowing past it (mirrors PMCChart).
  const barW = Math.max(2, plotW / points.length * 0.65);
  const barPlotW = plotW - barW;

  const xS = (i: number) => isBar
    ? PAD.left + barW / 2 + (i / Math.max(points.length - 1, 1)) * barPlotW
    : PAD.left + (i / Math.max(points.length - 1, 1)) * plotW;
  const yS = (v: number) => PAD.top + plotH - ((v - niceMin) / niceRange) * plotH;
  const yC = (v: number) => Math.max(PAD.top, Math.min(PAD.top + plotH, yS(v)));
  const zeroY = yC(0);

  const areaD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xS(i).toFixed(1)} ${yS(p.value).toFixed(1)}`).join(" ")
    + ` L ${xS(points.length - 1).toFixed(1)} ${(PAD.top + plotH).toFixed(1)} L ${xS(0).toFixed(1)} ${(PAD.top + plotH).toFixed(1)} Z`;

  const segs = coloredSegments(points, xS, yS, series.zoneBands, series.color);
  const xTickCount = Math.min(8, points.length);
  const xTickIdxs = Array.from({ length: xTickCount }, (_, i) =>
    Math.round(i * (points.length - 1) / (xTickCount - 1)));

  // Anomaly detection: find points where value is > 2 SD from mean (illness/spike flags).
  // showAnomalies=false skips this entirely — some series (e.g. a PR-driven estimate like
  // bench e1RM or a race-time prediction) are supposed to jump around on real progress,
  // not get flagged as if every PR were a data-quality glitch.
  const mean = dataVals.reduce((a, b) => a + b, 0) / dataVals.length;
  const sd = Math.sqrt(dataVals.reduce((s, v) => s + (v - mean) ** 2, 0) / dataVals.length);
  const anomalyIdxs = !showAnomalies ? [] : series.higherIsBetter === true
    ? points.map((p, i) => p.value < mean - 2 * sd ? i : -1).filter(i => i >= 0)
    : series.higherIsBetter === false
    ? points.map((p, i) => p.value > mean + 2 * sd ? i : -1).filter(i => i >= 0)
    : [];

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current; if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    let closest = 0, dist = Infinity;
    points.forEach((_, i) => { const d = Math.abs(xS(i) - svgX); if (d < dist) { dist = d; closest = i; } });
    setHoverIdx(closest);
  }

  const hoverPt = hoverIdx != null ? points[hoverIdx] : null;
  const latestSev = getZoneSeverity(points.at(-1)?.value ?? null, series.zoneBands);
  const hoverSev  = getZoneSeverity(hoverPt?.value ?? null, series.zoneBands);

  const chartStart = points[0].date, chartEnd = points.at(-1)!.date;
  const visibleEvents = events.filter(e => e.date >= chartStart && e.date <= chartEnd);

  return (
    <div className="card" style={{ padding: "20px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>{series.label}</div>
          {hoverPt ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 26, fontWeight: 900, color: hoverSev ? SEV[hoverSev] : series.color, fontFamily: "var(--mono)", lineHeight: 1 }}>
                {hoverPt.value.toFixed(dec)}{series.unit && <span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>{series.unit}</span>}
              </span>
              {hoverSev && (
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".6px", color: SEV[hoverSev], background: `${SEV[hoverSev]}18`, padding: "2px 8px", borderRadius: 4 }}>
                  {hoverSev === "optimal" ? t.trends.status.optimal : hoverSev === "warning" ? t.trends.status.caution : hoverSev === "danger" ? t.trends.status.risk : ""}
                </span>
              )}
              <span style={{ fontSize: 13, color: "var(--dim)" }}>{fmtDate(hoverPt.date, language, true)}</span>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "var(--dim)" }}>
              <span style={{ color: latestSev ? SEV[latestSev] : series.color }}>
                {points.at(-1)?.value.toFixed(dec)}{series.unit ? ` ${series.unit}` : ""}
              </span>
              {" "}· {t.trends.hoverToInspectInline} · {t.trends.daysCount.replace("{count}", String(points.length))}
              {anomalyIdxs.length > 0 && <span style={{ color: "var(--red)", marginLeft: 8 }}>· {t.trends.anomaliesFlagged.replace("{count}", String(anomalyIdxs.length))}</span>}
            </div>
          )}
          {caption && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>{caption}</div>}
        </div>
        {onClose && (
          <button onClick={onClose} style={{ background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer", padding: "4px 12px", fontSize: 12, color: "var(--muted)" }}>
            {t.trends.close} ✕
          </button>
        )}
      </div>

      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block", cursor: "crosshair" }}
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIdx(null)}>

        {!isBar && (
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series.color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={series.color} stopOpacity="0" />
            </linearGradient>
          </defs>
        )}

        {/* Zone bands with in-chart labels */}
        {series.zoneBands && (
          <ZoneBands bands={series.zoneBands} yC={yC}
            plotLeft={PAD.left} plotWidth={plotW} plotTop={PAD.top} plotH={plotH}
            effMin={effMin} effMax={effMax} />
        )}

        {/* Y-axis gridlines */}
        {yTickVals.map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} y1={yC(v)} x2={W - PAD.right} y2={yC(v)}
              stroke="var(--border)" strokeWidth={0.5}
              strokeDasharray={i === 0 || i === yTickVals.length - 1 ? undefined : "3,6"} />
            <text x={PAD.left - 8} y={yC(v) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{v % 1 === 0 ? String(Math.round(v)) : v.toFixed(dec)}</text>
          </g>
        ))}

        {/* Zero line for bar charts */}
        {isBar && effMin < 0 && (
          <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY} stroke="rgba(148,163,184,0.5)" strokeWidth={1} />
        )}

        {/* Zone reference lines */}
        {series.zoneLines?.map((line, i) => {
          const ly = yS(line.value);
          if (ly < PAD.top - 2 || ly > PAD.top + plotH + 2) return null;
          return (
            <g key={i}>
              <line x1={PAD.left} y1={ly} x2={W - PAD.right} y2={ly} stroke={line.color} strokeWidth={1.5} strokeDasharray="5,4" />
              <text x={W - PAD.right - 4} y={ly - 3} textAnchor="end" fontSize={10} fontWeight={700} fill={line.color}>{line.label}</text>
            </g>
          );
        })}

        {/* Race event markers */}
        {visibleEvents.map((ev, i) => {
          const ptIdx = points.findIndex(p => p.date === ev.date);
          if (ptIdx === -1) return null;
          return <EventMarker key={i} x={xS(ptIdx)} name={ev.name} priority={ev.priority} top={PAD.top} bottom={PAD.top + plotH} />;
        })}

        {/* X-axis */}
        {xTickIdxs.map(i => (
          <text key={i} x={xS(i)} y={H - 10} textAnchor="middle" fontSize={11} fill="var(--muted)">{fmtDate(points[i].date, language)}</text>
        ))}

        {/* BAR CHART rendering */}
        {isBar && points.map((p, i) => {
          const bx = xS(i) - barW / 2;
          const barColor = getZoneColor(p.value, series.zoneBands, p.value >= 0 ? "var(--green)" : "var(--red)");
          const barTop = p.value >= 0 ? yC(p.value) : zeroY;
          const barBot = p.value >= 0 ? zeroY : yC(p.value);
          return (
            <rect key={i} x={bx.toFixed(1)} y={barTop.toFixed(1)} width={barW.toFixed(1)} height={Math.max(1, barBot - barTop).toFixed(1)}
              fill={barColor} opacity={hoverIdx === i ? 1 : 0.75} rx={1} />
          );
        })}

        {/* LINE CHART rendering */}
        {!isBar && (
          <>
            <path d={areaD} fill={`url(#${gradId})`} />
            {segs.map((seg, i) => (
              <path key={i} d={seg.d} fill="none" stroke={seg.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
            ))}
          </>
        )}

        {/* Anomaly flags (illness / spikes) */}
        {!isBar && anomalyIdxs.map(i => {
          const ax = xS(i), ay = yS(points[i].value);
          return (
            <g key={i}>
              <circle cx={ax} cy={ay} r={6} fill="rgba(var(--red-rgb),.15)" stroke="var(--red)" strokeWidth={1.5} />
              <line x1={ax} y1={ay - 8} x2={ax} y2={ay - 18} stroke="var(--red)" strokeWidth={1.5} />
              <rect x={ax - 17} y={ay - 30} width={34} height={13} fill="var(--red)" rx={2} />
              <text x={ax} y={ay - 21} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="white">{t.trends.anomalyLabel}</text>
            </g>
          );
        })}

        {/* Hover crosshair */}
        {hoverIdx != null && (() => {
          const hx = xS(hoverIdx), hy = yS(points[hoverIdx].value);
          const hc = hoverSev ? SEV[hoverSev] : series.color;
          return (
            <>
              <line x1={hx} y1={PAD.top} x2={hx} y2={PAD.top + plotH} stroke={hc} strokeWidth={1} strokeDasharray="4,3" opacity={0.5} />
              {!isBar && <circle cx={hx} cy={hy} r={5} fill={hc} stroke="var(--surface)" strokeWidth={2} />}
            </>
          );
        })()}

        {/* Latest dot (line charts, not hovering) */}
        {!isBar && hoverIdx == null && (() => {
          const lx = xS(points.length - 1), ly = yS(points.at(-1)!.value);
          const lc = latestSev ? SEV[latestSev] : series.color;
          return <circle cx={lx} cy={ly} r={4} fill={lc} stroke="var(--surface)" strokeWidth={2} />;
        })()}
      </svg>

      {/* Zone legend */}
      {series.zoneBands?.some(b => b.label && b.severity) && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
          {series.zoneBands.filter(b => b.label && b.severity).map((b, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 12, height: 12, borderRadius: 2, background: b.severity ? SEV[b.severity] : "var(--dim)", opacity: 0.8 }} />
              <span style={{ fontSize: 11, color: "var(--muted)" }}>{b.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Weekly KPI deltas ─────────────────────────────────────────────────────────

/** Shape written by compute_weekly_kpi_delta() in services/supabase/plan_writer.py —
 * this week's average vs. the prior week's, per metric. */
export type WeeklyKpiDelta = Record<string, {
  current: number; prior: number; delta: number; higher_is_better: boolean | null;
}>;

function WeeklyKpiDeltas({ delta }: { delta: WeeklyKpiDelta }) {
  const t = useT().report;
  const KPI_DELTA_LABELS: Record<string, { label: string; unit: string }> = {
    ctl: { label: t.trends.series.ctl.label, unit: "" },
    atl: { label: t.trends.series.atl.label, unit: "" },
    tsb: { label: t.trends.series.tsb.label, unit: "" },
    hrv_overnight: { label: t.week.kpiDelta.hrv, unit: " ms" },
    rhr: { label: t.week.kpiDelta.rhr, unit: " bpm" },
    sleep_hours: { label: t.week.kpiDelta.sleepHours, unit: ` ${t.trends.units.hours}` },
  };
  const entries = Object.entries(delta).filter(([k]) => k in KPI_DELTA_LABELS);
  if (entries.length === 0) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 20 }}>
      {entries.map(([key, d]) => {
        const { label, unit } = KPI_DELTA_LABELS[key];
        // higher_is_better === null means direction isn't inherently good or bad
        // (ATL/TSB) — left uncolored rather than editorialized, matching DeltaBadge.
        const color = d.higher_is_better == null
          ? "var(--muted)"
          : (d.delta >= 0) === d.higher_is_better ? "var(--green)" : "var(--red)";
        const arrow = d.delta > 0 ? "ti-trending-up" : d.delta < 0 ? "ti-trending-down" : "ti-minus";
        return (
          <div key={key} className="kpi">
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{d.current.toFixed(1)}<span className="kpi-unit">{unit}</span></div>
            <div className="kpi-note" style={{ color, display: "flex", alignItems: "center", gap: 4 }}>
              <i className={`ti ${arrow}`} style={{ fontSize: 11 }} aria-hidden="true" />
              {d.delta > 0 ? "+" : ""}{d.delta.toFixed(1)} {t.week.vsLastWeek}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type ReportTab = "week" | "trends" | "analysis" | "exercises";

function TabBtn({ id, label, activeTab, onSelect }: { id: ReportTab; label: string; activeTab: ReportTab; onSelect: (id: ReportTab) => void }) {
  return (
    <button onClick={() => onSelect(id)} style={{
      background: "none", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, padding: "8px 16px",
      color: activeTab === id ? "var(--text)" : "var(--muted)",
      borderBottom: activeTab === id ? "2px solid var(--accent)" : "2px solid transparent",
      marginBottom: -1, transition: "color .15s",
    }}>{label}</button>
  );
}

// ── Main ProgressTabs ─────────────────────────────────────────────────────────

export default function ProgressTabs({
  weeklyReview, trendSeries, analysisHtml, planningHtml, latestAnalysisDate, events, completedActivities,
  completedExerciseSets, scheduledDays,
}: {
  weeklyReview: { summary_html: string; week_start: string; kpi_delta?: WeeklyKpiDelta | null } | null;
  trendSeries: TrendSeries[];
  analysisHtml: string | null;
  planningHtml: string | null;
  latestAnalysisDate: string | null;
  events: RaceEvent[];
  completedActivities: CompletedActivity[];
  completedExerciseSets: CompletedExerciseSet[];
  scheduledDays: ScheduledDay[];
}) {
  const t = useT().report;
  const [language] = useLanguage();
  const hasAnalysis = !!(analysisHtml || planningHtml);
  const [tab, setTab] = useState<ReportTab>("trends");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Close modal on Escape
  React.useEffect(() => {
    if (!expandedKey) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setExpandedKey(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expandedKey]);

  const activeSeries = trendSeries.filter(s => s.data.filter(d => d.value !== null).length >= 3);
  const expandedSeries = activeSeries.find(s => seriesKey(s) === expandedKey) ?? null;

  const pmcKeys = new Set(["ctl", "atl", "tsb"]);
  const ctlSeries  = activeSeries.find(s => seriesKey(s) === "ctl");
  const atlSeries  = activeSeries.find(s => seriesKey(s) === "atl");
  const tsbSeries  = activeSeries.find(s => seriesKey(s) === "tsb");
  const hasPMC     = !!(ctlSeries && atlSeries && tsbSeries);
  const gridSeries = activeSeries.filter(s => !pmcKeys.has(seriesKey(s)));

  const [trendsSyncBefore, trendsSyncAfter] = t.trends.emptyBody.split("{cmd}");

  return (
    <>
      <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid var(--border)" }}>
        <TabBtn id="week" label={t.tabs.thisWeek} activeTab={tab} onSelect={setTab} />
        <TabBtn id="trends" label={t.tabs.trends} activeTab={tab} onSelect={setTab} />
        <TabBtn id="exercises" label={t.tabs.exercises} activeTab={tab} onSelect={setTab} />
        {hasAnalysis && <TabBtn id="analysis" label={t.tabs.seasonAnalysis} activeTab={tab} onSelect={setTab} />}
      </div>

      {tab === "week" && (
        weeklyReview ? (
          <div>
            <p style={{ fontSize: 12, color: "var(--dim)", marginBottom: 16 }}>{t.week.weekOf.replace("{date}", fmtDate(weeklyReview.week_start, language, true))}</p>
            {weeklyReview.kpi_delta && <WeeklyKpiDeltas delta={weeklyReview.kpi_delta} />}
            <div className="report-content" dangerouslySetInnerHTML={{ __html: weeklyReview.summary_html }} />
          </div>
        ) : (
          <div className="card" style={{ textAlign: "center", padding: "40px 24px" }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>📊</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{t.week.emptyTitle}</div>
            <p style={{ color: "var(--muted)", fontSize: 14, maxWidth: 360, margin: "0 auto", lineHeight: 1.6 }}>{t.week.emptyBody}</p>
          </div>
        )
      )}

      {tab === "trends" && (
        activeSeries.length > 0 ? (
          <>
            {hasPMC && <PMCChart ctlData={ctlSeries!.data} atlData={atlSeries!.data} tsbData={tsbSeries!.data} events={events} />}
            <ActivityHeatmap activities={completedActivities} />
            <p style={{ fontSize: 12, color: "var(--dim)", marginBottom: 12 }}>{t.trends.hint}</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              {gridSeries.map((s, i) => (
                <CompactChart key={i} series={s} selected={expandedKey === seriesKey(s)} onClick={() => setExpandedKey(p => p === seriesKey(s) ? null : seriesKey(s))} />
              ))}
            </div>
            {expandedSeries && (
              <div
                style={{
                  position: "fixed", inset: 0, zIndex: 200,
                  background: "rgba(0,0,0,0.55)",
                  backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: "24px 16px",
                }}
                onClick={e => { if (e.target === e.currentTarget) setExpandedKey(null); }}
              >
                <div style={{
                  width: "min(940px, 92vw)", maxHeight: "88vh", overflow: "auto",
                }}>
                  <ExpandedChart series={expandedSeries} events={events} onClose={() => setExpandedKey(null)} />
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="card" style={{ textAlign: "center", padding: "40px 24px" }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>📈</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{t.trends.emptyTitle}</div>
            <p style={{ color: "var(--muted)", fontSize: 14, maxWidth: 360, margin: "0 auto", lineHeight: 1.6 }}>
              {trendsSyncBefore}<code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>--sync-history</code>{trendsSyncAfter}
            </p>
          </div>
        )
      )}

      {tab === "exercises" && (
        <ExerciseProgressTab
          completedSets={completedExerciseSets}
          completedActivities={completedActivities}
          scheduledDays={scheduledDays}
        />
      )}

      {tab === "analysis" && hasAnalysis && (
        <div>
          {latestAnalysisDate && <p style={{ fontSize: 12, color: "var(--dim)", marginBottom: 16 }}>{t.analysis.generatedOn.replace("{date}", fmtDate(latestAnalysisDate, language, true))}</p>}
          {analysisHtml && planningHtml
            ? <AnalysisTabs analysis={analysisHtml} planning={planningHtml} />
            : <div className="report-content" dangerouslySetInnerHTML={{ __html: extractMain(analysisHtml ?? planningHtml ?? "") }} />
          }
        </div>
      )}
    </>
  );
}

function AnalysisTabs({ analysis, planning }: { analysis: string; planning: string }) {
  const t = useT().report;
  const [inner, setInner] = useState<"analysis" | "planning">("analysis");
  return (
    <>
      <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid var(--border)" }}>
        {(["analysis", "planning"] as const).map(tabKey => (
          <button key={tabKey} onClick={() => setInner(tabKey)} style={{
            background: "none", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "6px 14px",
            color: inner === tabKey ? "var(--text)" : "var(--muted)",
            borderBottom: inner === tabKey ? "2px solid var(--accent)" : "2px solid transparent", marginBottom: -1,
          }}>
            {tabKey === "analysis" ? t.analysis.analysisTab : t.analysis.planningTab}
          </button>
        ))}
      </div>
      <div className="report-content" dangerouslySetInnerHTML={{ __html: extractMain(inner === "analysis" ? analysis : planning) }} />
    </>
  );
}
