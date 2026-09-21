"use client";

import { useState, useTransition } from "react";
import { saveProfileStep } from "@/app/actions/athlete-profile";
import type { AthleteProfile } from "@/app/actions/athlete-profile";
import type { WeightGoalDirection, RecurringSessionRequest, SessionRequestDayOfWeek, SessionRequestType, SessionRequestImportance } from "@/lib/types";
import { storeGarminCredentials, deleteGarminCredentials } from "@/app/actions/garmin-credentials";
import { useT } from "@/lib/i18n/LanguageContext";
import type { Dictionary } from "@/lib/i18n/types";

type SetupDict = Dictionary["setup"];

// ── Types ─────────────────────────────────────────────────────────────────────

type Event = { name: string; date: string; priority: string; target_time: string };

const EMPTY: AthleteProfile = {
  primary_goal_type: "", primary_goal_detail: "", weight_goal_direction: "maintain", secondary_goals: "",
  goal_timeline: "", events: [],
  training_years_strength: "", training_years_cardio: "", sport_background: "",
  sessions_per_week: null, hours_per_week: null,
  bench_1rm_kg: null, squat_1rm_kg: null, deadlift_1rm_kg: null,
  run_5k_time: "", run_10k_time: "", other_benchmarks: "",
  available_days: [], session_duration_mins: null, gym_access: null,
  equipment_notes: "", schedule_notes: "", allow_multi_session_days: false,
  recurring_session_requests: [],
  current_injuries: "", injury_history: "", exercises_to_avoid: "", health_notes: "",
  preferred_style: "", training_enjoyments: "", training_dislikes: "",
  indoor_outdoor: "", additional_notes: "", meal_variety_preference: "balanced",
  country: "", grocery_stores_notes: "",
  generated_analysis_context: "",
  setup_completed: false,
};

const DAY_VALS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

const STEP_ICONS  = ["ti-target", "ti-barbell", "ti-calendar", "ti-repeat", "ti-heart-rate-monitor", "ti-adjustments", "ti-device-watch"];

// ── Helpers ────────────────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return <div className="field-label">{children}</div>;
}
function Hint({ children }: { children: React.ReactNode }) {
  return <div className="field-hint">{children}</div>;
}
function Field({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="field" style={style}>{children}</div>;
}
function Opt() {
  const t = useT().setup;
  return <span style={{ color: "var(--dim)", fontWeight: 400, textTransform: "none", fontSize: 11, letterSpacing: 0 }}>{t.common.optionalSuffix}</span>;
}
function RadioGroup({ label, options, value, onChange }: {
  label: string;
  options: { value: string; label: string; desc?: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field>
      <Label>{label}</Label>
      <div className="radio-group">
        {options.map(o => (
          <label key={o.value} className={`radio-opt${value === o.value ? " selected" : ""}`}>
            <input type="radio" checked={value === o.value} onChange={() => onChange(o.value)} style={{ marginTop: 3 }} />
            <div>
              <div className="radio-opt-label">{o.label}</div>
              {o.desc && <div className="radio-opt-desc">{o.desc}</div>}
            </div>
          </label>
        ))}
      </div>
    </Field>
  );
}
function numVal(v: string): number | null {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// Goal-type helpers — empty string = no selection yet → show everything
function isCardioRelevant(g: string) { return !g || g === "race" || g === "hybrid" || g === "fitness"; }
function isStrengthRelevant(g: string) { return !g || g === "strength" || g === "aesthetics" || g === "hybrid" || g === "fitness"; }
function hasRaceEvents(g: string) { return !g || g === "race" || g === "hybrid"; }

// ── Wizard steps ───────────────────────────────────────────────────────────────

function GoalsStep({ data, set }: { data: AthleteProfile; set: (p: Partial<AthleteProfile>) => void }) {
  const t = useT().setup;
  const targetPlaceholders = t.goals.targetPlaceholders as Record<string, string>;
  function addEvent() { set({ events: [...data.events, { name: "", date: "", priority: "B", target_time: "" }] }); }
  function updateEvent(i: number, k: keyof Event, v: string) {
    set({ events: data.events.map((e, j) => j === i ? { ...e, [k]: v } : e) });
  }
  function removeEvent(i: number) { set({ events: data.events.filter((_, j) => j !== i) }); }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <RadioGroup label={t.goals.primaryGoalLabel} value={data.primary_goal_type} onChange={v => set({ primary_goal_type: v })}
        options={[
          { value: "race",       label: t.goals.primaryGoalOptions.race.label,       desc: t.goals.primaryGoalOptions.race.desc },
          { value: "strength",   label: t.goals.primaryGoalOptions.strength.label,   desc: t.goals.primaryGoalOptions.strength.desc },
          { value: "aesthetics", label: t.goals.primaryGoalOptions.aesthetics.label, desc: t.goals.primaryGoalOptions.aesthetics.desc },
          { value: "hybrid",     label: t.goals.primaryGoalOptions.hybrid.label,     desc: t.goals.primaryGoalOptions.hybrid.desc },
          { value: "fitness",    label: t.goals.primaryGoalOptions.fitness.label,    desc: t.goals.primaryGoalOptions.fitness.desc },
        ]}
      />
      <RadioGroup label={t.goals.weightGoalLabel} value={data.weight_goal_direction} onChange={v => set({ weight_goal_direction: v as WeightGoalDirection })}
        options={[
          { value: "lose",     label: t.goals.weightGoalOptions.lose.label,     desc: t.goals.weightGoalOptions.lose.desc },
          { value: "maintain", label: t.goals.weightGoalOptions.maintain.label, desc: t.goals.weightGoalOptions.maintain.desc },
          { value: "gain",     label: t.goals.weightGoalOptions.gain.label,     desc: t.goals.weightGoalOptions.gain.desc },
        ]}
      />
      <Field>
        <Label>{t.goals.targetLabel}</Label>
        <Hint>{t.goals.targetHint}</Hint>
        <textarea className="textarea" style={{ minHeight: 72 }}
          placeholder={targetPlaceholders[data.primary_goal_type] ?? targetPlaceholders[""]}
          value={data.primary_goal_detail} onChange={e => set({ primary_goal_detail: e.target.value })} />
      </Field>
      <Field>
        <Label>{t.goals.secondaryGoalsLabel}<Opt /></Label>
        <textarea className="textarea" style={{ minHeight: 60 }}
          placeholder={t.goals.secondaryGoalsPlaceholder}
          value={data.secondary_goals} onChange={e => set({ secondary_goals: e.target.value })} />
      </Field>
      <Field>
        <Label>{t.goals.timelineLabel}</Label>
        <input className="input" placeholder={t.goals.timelinePlaceholder}
          value={data.goal_timeline} onChange={e => set({ goal_timeline: e.target.value })} />
      </Field>
      {hasRaceEvents(data.primary_goal_type) && (
        <Field>
          <Label>{t.goals.eventsLabel}<Opt /></Label>
          {data.events.map((ev, i) => (
            <div key={i} className="card" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>{t.goals.eventNumber.replace("{n}", String(i + 1))}</span>
                <button type="button" className="btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => removeEvent(i)}>{t.common.removeButton}</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field><Label>{t.goals.eventNameLabel}</Label><input className="input" placeholder={t.goals.eventNamePlaceholder} value={ev.name} onChange={e => updateEvent(i, "name", e.target.value)} /></Field>
                <Field><Label>{t.goals.eventDateLabel}</Label><input className="input" type="date" value={ev.date} onChange={e => updateEvent(i, "date", e.target.value)} /></Field>
                <Field>
                  <Label>{t.goals.eventPriorityLabel}</Label>
                  <select className="select-input" value={ev.priority} onChange={e => updateEvent(i, "priority", e.target.value)}>
                    <option value="A">{t.goals.eventPriorityOptions.a}</option>
                    <option value="B">{t.goals.eventPriorityOptions.b}</option>
                    <option value="C">{t.goals.eventPriorityOptions.c}</option>
                  </select>
                </Field>
                <Field><Label>{t.goals.eventTargetTimeLabel}<Opt /></Label><input className="input" placeholder={t.goals.eventTargetTimePlaceholder} value={ev.target_time} onChange={e => updateEvent(i, "target_time", e.target.value)} /></Field>
              </div>
            </div>
          ))}
          <button type="button" className="btn-secondary" style={{ alignSelf: "flex-start" }} onClick={addEvent}>
            <i className="ti ti-plus" style={{ marginRight: 6 }} />{t.goals.addEventButton}
          </button>
        </Field>
      )}
    </div>
  );
}

function BackgroundStep({ data, set }: { data: AthleteProfile; set: (p: Partial<AthleteProfile>) => void }) {
  const t = useT().setup;
  const yearOpts = [
    { value: "none", label: t.background.experienceOptions.none },     { value: "<1", label: t.background.experienceOptions.lessThan1 },
    { value: "1-2",  label: t.background.experienceOptions.oneToTwo }, { value: "3-5", label: t.background.experienceOptions.threeToFive },
    { value: "5-10", label: t.background.experienceOptions.fiveToTen }, { value: "10+", label: t.background.experienceOptions.tenPlus },
  ];
  const benchmarkFields: readonly [string, "bench_1rm_kg" | "squat_1rm_kg" | "deadlift_1rm_kg", string][] = [
    [t.background.benchLabel, "bench_1rm_kg", t.background.benchPlaceholder],
    [t.background.squatLabel, "squat_1rm_kg", t.background.squatPlaceholder],
    [t.background.deadliftLabel, "deadlift_1rm_kg", t.background.deadliftPlaceholder],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field>
          <Label>{t.background.strengthExperienceLabel}</Label>
          <select className="select-input" value={data.training_years_strength} onChange={e => set({ training_years_strength: e.target.value })}>
            <option value="">{t.common.selectPlaceholder}</option>
            {yearOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field>
          <Label>{t.background.cardioExperienceLabel}</Label>
          <select className="select-input" value={data.training_years_cardio} onChange={e => set({ training_years_cardio: e.target.value })}>
            <option value="">{t.common.selectPlaceholder}</option>
            {yearOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>
      <Field>
        <Label>{t.background.sportBackgroundLabel}</Label>
        <Hint>{t.background.sportBackgroundHint}</Hint>
        <textarea className="textarea"
          placeholder={t.background.sportBackgroundPlaceholder}
          value={data.sport_background} onChange={e => set({ sport_background: e.target.value })} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field>
          <Label>{t.background.sessionsPerWeekLabel}</Label>
          <Hint>{t.background.sessionsPerWeekHint}</Hint>
          <input className="input" type="number" min={0} max={14} placeholder={t.background.sessionsPerWeekPlaceholder}
            value={data.sessions_per_week ?? ""} onChange={e => set({ sessions_per_week: numVal(e.target.value) })} />
        </Field>
        <Field>
          <Label>{t.background.hoursPerWeekLabel}</Label>
          <Hint>{t.background.hoursPerWeekHint}</Hint>
          <input className="input" type="number" min={0} max={30} step={0.5} placeholder={t.background.hoursPerWeekPlaceholder}
            value={data.hours_per_week ?? ""} onChange={e => set({ hours_per_week: numVal(e.target.value) })} />
        </Field>
      </div>
      {(isStrengthRelevant(data.primary_goal_type) || isCardioRelevant(data.primary_goal_type)) && (
        <div>
          <Label>{t.background.benchmarksLabel}</Label>
          <Hint>{t.background.benchmarksHint}</Hint>
          {isStrengthRelevant(data.primary_goal_type) && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 8 }}>
              {benchmarkFields.map(([label, key, ph]) => (
                <Field key={key}>
                  <Label>{label}</Label>
                  <input className="input" type="number" placeholder={ph}
                    value={data[key] ?? ""} onChange={e => set({ [key]: numVal(e.target.value) })} />
                </Field>
              ))}
            </div>
          )}
          {isCardioRelevant(data.primary_goal_type) && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
              <Field><Label>{t.background.run5kLabel}</Label><input className="input" placeholder={t.background.run5kPlaceholder} value={data.run_5k_time} onChange={e => set({ run_5k_time: e.target.value })} /></Field>
              <Field><Label>{t.background.run10kLabel}</Label><input className="input" placeholder={t.background.run10kPlaceholder} value={data.run_10k_time} onChange={e => set({ run_10k_time: e.target.value })} /></Field>
            </div>
          )}
        </div>
      )}
      <Field>
        <Label>{t.background.otherBenchmarksLabel}<Opt /></Label>
        <textarea className="textarea" style={{ minHeight: 60 }}
          placeholder={t.background.otherBenchmarksPlaceholder}
          value={data.other_benchmarks} onChange={e => set({ other_benchmarks: e.target.value })} />
      </Field>
    </div>
  );
}

function ScheduleStep({ data, set }: { data: AthleteProfile; set: (p: Partial<AthleteProfile>) => void }) {
  const t = useT().setup;
  function toggleDay(val: string) {
    set({ available_days: data.available_days.includes(val) ? data.available_days.filter(d => d !== val) : [...data.available_days, val] });
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Field>
        <Label>{t.schedule.daysLabel}</Label>
        <Hint>{t.schedule.daysHint}</Hint>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
          {DAY_VALS.map(val => (
            <button key={val} type="button"
              className={`day-btn${data.available_days.includes(val) ? " selected" : ""}`}
              onClick={() => toggleDay(val)}>{t.weekdaysShort[val]}</button>
          ))}
        </div>
      </Field>
      <RadioGroup label={t.schedule.sessionLengthLabel} value={String(data.session_duration_mins ?? "")} onChange={v => set({ session_duration_mins: parseInt(v) })}
        options={[
          { value: "45",  label: t.schedule.sessionLengthOptions.m45.label,     desc: t.schedule.sessionLengthOptions.m45.desc },
          { value: "60",  label: t.schedule.sessionLengthOptions.m60.label,     desc: t.schedule.sessionLengthOptions.m60.desc },
          { value: "90",  label: t.schedule.sessionLengthOptions.m90.label,     desc: t.schedule.sessionLengthOptions.m90.desc },
          { value: "120", label: t.schedule.sessionLengthOptions.noLimit.label, desc: t.schedule.sessionLengthOptions.noLimit.desc },
        ]}
      />
      <RadioGroup label={t.schedule.gymAccessLabel} value={data.gym_access === null ? "" : data.gym_access ? "yes" : "no"} onChange={v => set({ gym_access: v === "yes" })}
        options={[
          { value: "yes", label: t.schedule.gymAccessOptions.yes.label, desc: t.schedule.gymAccessOptions.yes.desc },
          { value: "no",  label: t.schedule.gymAccessOptions.no.label,  desc: t.schedule.gymAccessOptions.no.desc },
        ]}
      />
      <Field>
        <Label>{t.schedule.equipmentLabel}<Opt /></Label>
        <Hint>{t.schedule.equipmentHint}</Hint>
        <textarea className="textarea" style={{ minHeight: 60 }}
          placeholder={t.schedule.equipmentPlaceholder}
          value={data.equipment_notes} onChange={e => set({ equipment_notes: e.target.value })} />
      </Field>
      <Field>
        <Label>{t.schedule.constraintsLabel}<Opt /></Label>
        <Hint>{t.schedule.constraintsHint}</Hint>
        <textarea className="textarea" style={{ minHeight: 60 }}
          placeholder={t.schedule.constraintsPlaceholder}
          value={data.schedule_notes} onChange={e => set({ schedule_notes: e.target.value })} />
      </Field>
      <RadioGroup label={t.schedule.multiSessionDaysLabel} value={data.allow_multi_session_days ? "yes" : "no"} onChange={v => set({ allow_multi_session_days: v === "yes" })}
        options={[
          { value: "yes", label: t.schedule.multiSessionDaysOptions.yes.label, desc: t.schedule.multiSessionDaysOptions.yes.desc },
          { value: "no",  label: t.schedule.multiSessionDaysOptions.no.label,  desc: t.schedule.multiSessionDaysOptions.no.desc },
        ]}
      />
    </div>
  );
}

function sessionRequestDayOpts(t: SetupDict): Array<{ value: SessionRequestDayOfWeek | ""; label: string }> {
  return [
    { value: "",          label: t.preferredSessions.noSpecificDay },
    { value: "monday",    label: t.weekdaysFull.monday },
    { value: "tuesday",   label: t.weekdaysFull.tuesday },
    { value: "wednesday", label: t.weekdaysFull.wednesday },
    { value: "thursday",  label: t.weekdaysFull.thursday },
    { value: "friday",    label: t.weekdaysFull.friday },
    { value: "saturday",  label: t.weekdaysFull.saturday },
    { value: "sunday",    label: t.weekdaysFull.sunday },
  ];
}

function sessionRequestTypeOpts(t: SetupDict): Array<{ value: SessionRequestType; label: string }> {
  return [
    { value: "run",      label: t.preferredSessions.sessionTypeOptions.run },
    { value: "strength", label: t.preferredSessions.sessionTypeOptions.strength },
    { value: "cross",    label: t.preferredSessions.sessionTypeOptions.cross },
    { value: "other",    label: t.preferredSessions.sessionTypeOptions.other },
  ];
}

function PreferredSessionsStep({ data, set }: { data: AthleteProfile; set: (p: Partial<AthleteProfile>) => void }) {
  const t = useT().setup;
  const dayOpts = sessionRequestDayOpts(t);
  const typeOpts = sessionRequestTypeOpts(t);
  function addRequest() {
    set({
      recurring_session_requests: [
        ...data.recurring_session_requests,
        { id: crypto.randomUUID(), label: "", day_of_week: null, session_type: "run", description: "", importance: "nice_to_have" },
      ],
    });
  }
  function updateRequest(i: number, patch: Partial<RecurringSessionRequest>) {
    set({ recurring_session_requests: data.recurring_session_requests.map((r, j) => j === i ? { ...r, ...patch } : r) });
  }
  function removeRequest(i: number) {
    set({ recurring_session_requests: data.recurring_session_requests.filter((_, j) => j !== i) });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Field>
        <Label>{t.preferredSessions.label}<Opt /></Label>
        <Hint>{t.preferredSessions.hint}</Hint>
        {data.recurring_session_requests.map((req, i) => (
          <div key={req.id} className="card" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>{t.preferredSessions.sessionNumber.replace("{n}", String(i + 1))}</span>
              <button type="button" className="btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => removeRequest(i)}>{t.common.removeButton}</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field><Label>{t.preferredSessions.labelFieldLabel}</Label><input className="input" placeholder={t.preferredSessions.labelPlaceholder} value={req.label} onChange={e => updateRequest(i, { label: e.target.value })} /></Field>
              <Field>
                <Label>{t.preferredSessions.dayLabel}</Label>
                <select className="select-input" value={req.day_of_week ?? ""} onChange={e => updateRequest(i, { day_of_week: (e.target.value || null) as SessionRequestDayOfWeek | null })}>
                  {dayOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
              <Field>
                <Label>{t.preferredSessions.sessionTypeLabel}</Label>
                <select className="select-input" value={req.session_type} onChange={e => updateRequest(i, { session_type: e.target.value as SessionRequestType })}>
                  {typeOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
              <Field>
                <Label>{t.preferredSessions.importanceLabel}</Label>
                <select className="select-input" value={req.importance} onChange={e => updateRequest(i, { importance: e.target.value as SessionRequestImportance })}>
                  <option value="must">{t.preferredSessions.importanceOptions.must}</option>
                  <option value="nice_to_have">{t.preferredSessions.importanceOptions.nice_to_have}</option>
                </select>
              </Field>
            </div>
            <Field>
              <Label>{t.preferredSessions.descriptionLabel}<Opt /></Label>
              <textarea className="textarea" style={{ minHeight: 50 }}
                placeholder={t.preferredSessions.descriptionPlaceholder}
                value={req.description} onChange={e => updateRequest(i, { description: e.target.value })} />
            </Field>
          </div>
        ))}
        <button type="button" className="btn-secondary" style={{ alignSelf: "flex-start" }} onClick={addRequest}>
          <i className="ti ti-plus" style={{ marginRight: 6 }} />{t.preferredSessions.addSessionButton}
        </button>
      </Field>
    </div>
  );
}

function HealthStep({ data, set }: { data: AthleteProfile; set: (p: Partial<AthleteProfile>) => void }) {
  const t = useT().setup;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div className="card" style={{ borderLeft: "3px solid var(--amber)", padding: "12px 16px" }}>
        <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
          {t.health.privacyNote}
        </div>
      </div>
      <Field>
        <Label>{t.health.currentInjuriesLabel}</Label>
        <Hint>{t.health.currentInjuriesHint}</Hint>
        <textarea className="textarea"
          placeholder={t.health.currentInjuriesPlaceholder}
          value={data.current_injuries} onChange={e => set({ current_injuries: e.target.value })} />
      </Field>
      <Field>
        <Label>{t.health.injuryHistoryLabel}</Label>
        <Hint>{t.health.injuryHistoryHint}</Hint>
        <textarea className="textarea"
          placeholder={t.health.injuryHistoryPlaceholder}
          value={data.injury_history} onChange={e => set({ injury_history: e.target.value })} />
      </Field>
      <Field>
        <Label>{t.health.exercisesToAvoidLabel}</Label>
        <Hint>{t.health.exercisesToAvoidHint}</Hint>
        <textarea className="textarea" style={{ minHeight: 60 }}
          placeholder={t.health.exercisesToAvoidPlaceholder}
          value={data.exercises_to_avoid} onChange={e => set({ exercises_to_avoid: e.target.value })} />
      </Field>
      <Field>
        <Label>{t.health.otherNotesLabel}<Opt /></Label>
        <Hint>{t.health.otherNotesHint}</Hint>
        <textarea className="textarea" style={{ minHeight: 60 }}
          placeholder={t.health.otherNotesPlaceholder}
          value={data.health_notes} onChange={e => set({ health_notes: e.target.value })} />
      </Field>
    </div>
  );
}

function PreferencesStep({ data, set }: { data: AthleteProfile; set: (p: Partial<AthleteProfile>) => void }) {
  const t = useT().setup;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <RadioGroup label={t.preferences.styleLabel} value={data.preferred_style} onChange={v => set({ preferred_style: v })}
        options={[
          { value: "high_freq", label: t.preferences.styleOptions.high_freq.label, desc: t.preferences.styleOptions.high_freq.desc },
          { value: "low_freq",  label: t.preferences.styleOptions.low_freq.label,  desc: t.preferences.styleOptions.low_freq.desc },
          { value: "balanced",  label: t.preferences.styleOptions.balanced.label,  desc: t.preferences.styleOptions.balanced.desc },
          { value: "no_pref",   label: t.preferences.styleOptions.no_pref.label,   desc: t.preferences.styleOptions.no_pref.desc },
        ]}
      />
      {isCardioRelevant(data.primary_goal_type) && (
        <RadioGroup label={t.preferences.cardioPrefLabel} value={data.indoor_outdoor} onChange={v => set({ indoor_outdoor: v })}
          options={[
            { value: "outdoor_pref", label: t.preferences.cardioPrefOptions.outdoor_pref.label, desc: t.preferences.cardioPrefOptions.outdoor_pref.desc },
            { value: "outdoor_only", label: t.preferences.cardioPrefOptions.outdoor_only.label, desc: t.preferences.cardioPrefOptions.outdoor_only.desc },
            { value: "indoor",       label: t.preferences.cardioPrefOptions.indoor.label,       desc: t.preferences.cardioPrefOptions.indoor.desc },
            { value: "no_pref",      label: t.preferences.cardioPrefOptions.no_pref.label,      desc: t.preferences.cardioPrefOptions.no_pref.desc },
          ]}
        />
      )}
      <RadioGroup label={t.preferences.mealVarietyLabel} value={data.meal_variety_preference} onChange={v => set({ meal_variety_preference: v })}
        options={[
          { value: "minimal",  label: t.preferences.mealVarietyOptions.minimal.label,  desc: t.preferences.mealVarietyOptions.minimal.desc },
          { value: "balanced", label: t.preferences.mealVarietyOptions.balanced.label,  desc: t.preferences.mealVarietyOptions.balanced.desc },
          { value: "high",     label: t.preferences.mealVarietyOptions.high.label,      desc: t.preferences.mealVarietyOptions.high.desc },
        ]}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field>
          <Label>{t.preferences.countryLabel}<Opt /></Label>
          <Hint>{t.preferences.countryHint}</Hint>
          <input className="input" placeholder={t.preferences.countryPlaceholder}
            value={data.country} onChange={e => set({ country: e.target.value })} />
        </Field>
        <Field>
          <Label>{t.preferences.groceryLabel}<Opt /></Label>
          <Hint>{t.preferences.groceryHint}</Hint>
          <input className="input" placeholder={t.preferences.groceryPlaceholder}
            value={data.grocery_stores_notes} onChange={e => set({ grocery_stores_notes: e.target.value })} />
        </Field>
      </div>
      <Field>
        <Label>{t.preferences.enjoymentsLabel}</Label>
        <Hint>{t.preferences.enjoymentsHint}</Hint>
        <textarea className="textarea"
          placeholder={t.preferences.enjoymentsPlaceholder}
          value={data.training_enjoyments} onChange={e => set({ training_enjoyments: e.target.value })} />
      </Field>
      <Field>
        <Label>{t.preferences.dislikesLabel}</Label>
        <Hint>{t.preferences.dislikesHint}</Hint>
        <textarea className="textarea"
          placeholder={t.preferences.dislikesPlaceholder}
          value={data.training_dislikes} onChange={e => set({ training_dislikes: e.target.value })} />
      </Field>
      <Field>
        <Label>{t.preferences.additionalNotesLabel}<Opt /></Label>
        <Hint>{t.preferences.additionalNotesHint}</Hint>
        <textarea className="textarea"
          placeholder={t.preferences.additionalNotesPlaceholder}
          value={data.additional_notes} onChange={e => set({ additional_notes: e.target.value })} />
      </Field>
    </div>
  );
}

// ── Garmin Connect step ────────────────────────────────────────────────────────

function GarminConnectStep({ initialEmail }: { initialEmail?: string | null }) {
  const t = useT().setup;
  const [connected, setConnected] = useState(!!initialEmail);
  const [connectedEmail, setConnectedEmail] = useState(initialEmail ?? "");
  const [showForm, setShowForm] = useState(!initialEmail);
  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "disconnecting" | "done" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");

  async function handleConnect() {
    if (!email || !password) return;
    setStatus("saving");
    setErrMsg("");
    const result = await storeGarminCredentials(email, password);
    if (result.error) { setStatus("error"); setErrMsg(result.error); return; }
    setConnected(true);
    setConnectedEmail(email);
    setShowForm(false);
    setPassword("");
    setStatus("done");
  }

  async function handleDisconnect() {
    setStatus("disconnecting");
    setErrMsg("");
    const result = await deleteGarminCredentials();
    if (result.error) { setStatus("error"); setErrMsg(result.error); return; }
    setConnected(false);
    setConnectedEmail("");
    setEmail("");
    setShowForm(true);
    setStatus("idle");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div className="card" style={{ borderLeft: "3px solid var(--accent)", padding: "12px 16px" }}>
        <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
          {t.garmin.encryptionNote}
        </div>
      </div>

      {connected && !showForm ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--green)" }} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>{t.garmin.connectedStatus}</span>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>— {connectedEmail}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn-secondary" style={{ fontSize: 13 }}
              onClick={() => { setEmail(connectedEmail); setShowForm(true); setStatus("idle"); }}>
              <i className="ti ti-pencil" style={{ marginRight: 6 }} />{t.garmin.updateCredentials}
            </button>
            <button type="button" className="btn-secondary" style={{ fontSize: 13, color: "var(--red)" }}
              onClick={handleDisconnect} disabled={status === "disconnecting"}>
              <i className="ti ti-unlink" style={{ marginRight: 6 }} />
              {status === "disconnecting" ? t.garmin.disconnecting : t.garmin.disconnect}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {connected && (
            <button type="button" className="btn-secondary" style={{ alignSelf: "flex-start", fontSize: 13 }}
              onClick={() => { setShowForm(false); setStatus("idle"); }}>
              <i className="ti ti-arrow-left" style={{ marginRight: 6 }} />{t.garmin.cancel}
            </button>
          )}
          <Field>
            <Label>{t.garmin.emailLabel}</Label>
            <input className="input" type="email" placeholder="you@example.com"
              value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" />
          </Field>
          <Field>
            <Label>{t.garmin.passwordLabel}</Label>
            <input className="input" type="password" placeholder="••••••••"
              value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <button type="button" className="btn-primary" style={{ alignSelf: "flex-start" }}
            onClick={handleConnect} disabled={!email || !password || status === "saving"}>
            {status === "saving"
              ? <><i className="ti ti-loader-2" style={{ marginRight: 8, animation: "spin 1s linear infinite" }} />{t.garmin.connecting}</>
              : <><i className="ti ti-link" style={{ marginRight: 6 }} />{connected ? t.garmin.update : t.garmin.connect}</>}
          </button>
        </div>
      )}

      {status === "error" && <div style={{ color: "var(--red)", fontSize: 13 }}>{errMsg}</div>}
      {status === "done" && <div style={{ color: "var(--green)", fontSize: 13 }}>{t.garmin.savedSuccess}</div>}

      <div style={{ fontSize: 12, color: "var(--dim)", lineHeight: 1.6 }}>
        {t.garmin.skipNote}
      </div>
    </div>
  );
}

// ── Context preview (read-only) ────────────────────────────────────────────────

function ContextPreview({ label, text }: { label: string; text: string }) {
  const lines = text.trim().split("\n").filter(Boolean).slice(0, 3);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", color: "var(--dim)" }}>{label}</div>
      <div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "var(--mono)", lineHeight: 1.6, borderLeft: "2px solid var(--border)", paddingLeft: 10 }}>
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        {text.trim().split("\n").filter(Boolean).length > 3 && <div style={{ color: "var(--dim)", marginTop: 2 }}>…</div>}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function SetupWizard({ initial, devProfileStale, garminEmail }: { initial: AthleteProfile | null; devProfileStale?: boolean; garminEmail?: string | null }) {
  const t = useT().setup;
  const hasContext = !!initial?.generated_analysis_context;

  const [mode, setMode] = useState<"review" | "wizard">(hasContext ? "review" : "wizard");
  const [step, setStep] = useState(1);
  const [maxStep, setMaxStep] = useState(hasContext ? 7 : 1);
  const [data, setData] = useState<AthleteProfile>(initial ?? EMPTY);
  const [isDirty, setIsDirty] = useState(false);
  const [profileStale, setProfileStale] = useState(devProfileStale ?? false);
  const [showText, setShowText] = useState(false);
  const [saving, startSave] = useTransition();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(partial: Partial<AthleteProfile>) {
    setData(d => ({ ...d, ...partial }));
    setIsDirty(true);
  }

  function getStepPartial(s: number): Partial<AthleteProfile> {
    const keys: (keyof AthleteProfile)[][] = [
      ["primary_goal_type", "primary_goal_detail", "weight_goal_direction", "secondary_goals", "goal_timeline", "events"],
      ["training_years_strength", "training_years_cardio", "sport_background", "sessions_per_week", "hours_per_week", "bench_1rm_kg", "squat_1rm_kg", "deadlift_1rm_kg", "run_5k_time", "run_10k_time", "other_benchmarks"],
      ["available_days", "session_duration_mins", "gym_access", "equipment_notes", "schedule_notes", "allow_multi_session_days"],
      ["recurring_session_requests"],
      ["current_injuries", "injury_history", "exercises_to_avoid", "health_notes"],
      ["preferred_style", "training_enjoyments", "training_dislikes", "indoor_outdoor", "additional_notes", "meal_variety_preference", "country", "grocery_stores_notes"],
    ];
    const partial: Partial<AthleteProfile> = {};
    for (const k of (keys[s - 1] ?? [])) {
      (partial as unknown as Record<string, unknown>)[k] = (data as unknown as Record<string, unknown>)[k];
    }
    return partial;
  }

  async function handleNext() {
    setError(null);
    if (step === 7) {
      setMode("review");
      if (isDirty && data.generated_analysis_context) setProfileStale(true);
      setIsDirty(false);
      return;
    }
    startSave(async () => {
      const result = await saveProfileStep(getStepPartial(step));
      if (result.error) { setError(result.error); return; }
      const next = step + 1;
      setStep(next);
      setMaxStep(m => Math.max(m, next));
    });
  }

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/generate-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Generation failed");
      const { analysisContext } = await res.json();
      const result = await saveProfileStep({
        generated_analysis_context: analysisContext,
        setup_completed: true,
      });
      if (result.error) throw new Error(result.error);
      setData(d => ({ ...d, generated_analysis_context: analysisContext, setup_completed: true }));
      setIsDirty(false);
      setProfileStale(false);
    } catch {
      setError(t.errors.generateContextFailed);
    } finally {
      setGenerating(false);
    }
  }

  async function handleSaveExit() {
    if (!isDirty) { setMode("review"); return; }
    setError(null);
    startSave(async () => {
      const result = await saveProfileStep(getStepPartial(step));
      if (result.error) { setError(result.error); return; }
      setIsDirty(false);
      if (data.generated_analysis_context) setProfileStale(true);
      setMode("review");
    });
  }

  async function handleSaveText() {
    setError(null);
    startSave(async () => {
      const result = await saveProfileStep({
        generated_analysis_context: data.generated_analysis_context,
      });
      if (result.error) { setError(result.error); return; }
      setIsDirty(false);
      setShowText(false);
    });
  }

  // ── Review mode (default) ──────────────────────────────────────────────────

  if (mode === "review") {
    const hasCtx = !!data.generated_analysis_context;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

        {/* Status */}
        <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
          {hasCtx
            ? t.review.statusWithContext
            : t.review.statusNoContext}
        </div>

        {/* Staleness warning */}
        {profileStale && (
          <div style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            background: "rgba(234,179,8,.08)", border: "1px solid rgba(234,179,8,.3)",
            borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "var(--yellow, #eab308)", lineHeight: 1.5,
          }}>
            <i className="ti ti-refresh-alert" style={{ fontSize: 16, marginTop: 1, flexShrink: 0 }} />
            <span>{t.review.staleWarningPrefix}<strong>{t.review.staleWarningStrong}</strong>{t.review.staleWarningSuffix}</span>
          </div>
        )}

        {/* Context preview */}
        {hasCtx && !showText && (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16, background: "rgba(var(--overlay-rgb),.03)" }}>
            <ContextPreview label={t.review.contextPreviewLabel}  text={data.generated_analysis_context} />
          </div>
        )}

        {/* Recurring session requests preview — these aren't part of the narrative above; they're
            sent to the coach as explicit constraints, built fresh from this saved data every time
            a plan is generated. Shown here so it's clear they're actually being used. */}
        {data.recurring_session_requests.length > 0 && (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12, background: "rgba(var(--overlay-rgb),.03)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "var(--dim)", textTransform: "uppercase" }}>
              {t.review.recurringRequestsTitle}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
              {t.review.recurringRequestsHint}
            </div>
            {data.recurring_session_requests.map(req => (
              <div key={req.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{req.label || t.review.untitledSession}</span>
                  <span className="badge" style={{ fontSize: 10 }}>
                    {req.day_of_week ? t.weekdaysFull[req.day_of_week] : t.preferredSessions.noSpecificDay}
                  </span>
                  <span className={`badge${req.importance === "must" ? " badge-accent" : ""}`} style={{ fontSize: 10 }}>
                    {req.importance === "must" ? t.review.alwaysInclude : t.review.includeWhenPossible}
                  </span>
                </div>
                {req.description && (
                  <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "pre-wrap" }}>{req.description}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Editable textareas */}
        {hasCtx && showText && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <Field>
              <Label>{t.review.contextPreviewLabel}</Label>
              <Hint>{t.review.editContextHint}</Hint>
              <textarea className="textarea" style={{ minHeight: 240, fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.6 }}
                value={data.generated_analysis_context}
                onChange={e => { setData(d => ({ ...d, generated_analysis_context: e.target.value })); setIsDirty(true); }} />
            </Field>
            {isDirty && (
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn-primary" onClick={handleSaveText} disabled={saving}>
                  {saving ? t.review.saving : t.review.saveChanges}
                </button>
                <button className="btn-secondary" onClick={() => { setData(initial ?? EMPTY); setIsDirty(false); setShowText(false); }}>
                  {t.review.discard}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Garmin note */}
        <div style={{ fontSize: 12, color: "var(--dim)", lineHeight: 1.6 }}>
          {t.review.garminAutoSyncNote}
        </div>

        {/* Error */}
        {error && <div style={{ color: "var(--red)", fontSize: 13 }}>{error}</div>}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
            {generating
              ? <><i className="ti ti-loader-2" style={{ marginRight: 8, animation: "spin 1s linear infinite" }} />{t.review.generating}</>
              : <><i className="ti ti-sparkles" style={{ marginRight: 8 }} />{hasCtx ? t.review.regenerate : t.review.generate}</>}
          </button>
          <button className="btn-secondary" onClick={() => { setMode("wizard"); setStep(1); setIsDirty(false); }}>
            <i className="ti ti-list-details" style={{ marginRight: 6 }} />{t.review.editProfileAnswers}
          </button>
          {hasCtx && (
            <button className="btn-secondary" onClick={() => setShowText(v => !v)}>
              <i className={`ti ${showText ? "ti-eye-off" : "ti-code"}`} style={{ marginRight: 6 }} />
              {showText ? t.review.hideText : t.review.editText}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Wizard mode ────────────────────────────────────────────────────────────

  const stepLabels = t.stepLabels;
  const stepHeadings = t.stepHeadings;
  const stepSubtitles = t.stepSubtitles;

  return (
    <div>
      {/* Back to overview */}
      <button
        className="btn-secondary"
        style={{ marginBottom: 20, fontSize: 13 }}
        onClick={() => setMode("review")}
      >
        <i className="ti ti-arrow-left" style={{ marginRight: 6 }} />{t.navigation.backToOverview}
      </button>

      {/* Step progress */}
      <div className="wizard-steps" style={{ marginBottom: 28 }}>
        {stepLabels.map((label, i) => {
          const num = i + 1;
          const done   = num < step;
          const active = num === step;
          const reachable = num <= maxStep;
          return (
            <div key={num} className="wizard-step">
              <div
                className={`step-dot${done ? " done" : active ? " active" : ""}`}
                style={{ cursor: reachable && !active ? "pointer" : undefined }}
                onClick={() => reachable && !active && setStep(num)}
                title={label}
              >
                {done ? <i className="ti ti-check" style={{ fontSize: 12 }} /> : num}
              </div>
              {i < stepLabels.length - 1 && <div className={`step-line${done ? " done" : ""}`} />}
            </div>
          );
        })}
      </div>

      {/* Step header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <i className={`ti ${STEP_ICONS[step - 1]}`} style={{ fontSize: 18, color: "var(--accent)" }} />
          <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>{stepHeadings[step - 1]}</h2>
        </div>
        <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>{stepSubtitles[step - 1]}</p>
      </div>

      {/* Step content */}
      <div className="card" style={{ marginBottom: 24 }}>
        {step === 1 && <GoalsStep             data={data} set={patch} />}
        {step === 2 && <BackgroundStep        data={data} set={patch} />}
        {step === 3 && <ScheduleStep          data={data} set={patch} />}
        {step === 4 && <PreferredSessionsStep data={data} set={patch} />}
        {step === 5 && <HealthStep            data={data} set={patch} />}
        {step === 6 && <PreferencesStep       data={data} set={patch} />}
        {step === 7 && <GarminConnectStep     initialEmail={garminEmail} />}
      </div>

      {/* Error */}
      {error && <div style={{ color: "var(--red)", fontSize: 13, marginBottom: 16 }}>{error}</div>}

      {/* Navigation */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button className="btn-secondary" disabled={saving}
          onClick={() => step === 1 ? setMode("review") : setStep(s => s - 1)}>
          <i className="ti ti-arrow-left" style={{ marginRight: 6 }} />
          {step === 1 ? t.navigation.overview : t.navigation.back}
        </button>
        <span style={{ fontSize: 12, color: "var(--dim)" }}>{t.navigation.stepOf.replace("{n}", String(step))}</span>
        <div style={{ display: "flex", gap: 8 }}>
          {step < 7 && (
            <button className="btn-secondary" onClick={handleSaveExit} disabled={saving}>
              {saving ? t.navigation.saving : t.navigation.saveExit}
            </button>
          )}
          <button className="btn-primary" onClick={handleNext} disabled={saving}>
            {saving ? t.navigation.saving : step === 7
              ? <>{t.navigation.finish} <i className="ti ti-check" style={{ marginLeft: 6 }} /></>
              : <>{t.navigation.continueLabel} <i className="ti ti-arrow-right" style={{ marginLeft: 6 }} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
