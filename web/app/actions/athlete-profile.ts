"use server";

import { createServerClient as createSSRClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import type { WeightGoalDirection, RecurringSessionRequest } from "@/lib/types";

export interface AthleteProfile {
  // Goals
  primary_goal_type: string;
  primary_goal_detail: string;
  weight_goal_direction: WeightGoalDirection;
  secondary_goals: string;
  goal_timeline: string;
  events: Array<{ name: string; date: string; priority: string; target_time: string }>;
  // Background
  training_years_strength: string;
  training_years_cardio: string;
  sport_background: string;
  sessions_per_week: number | null;
  hours_per_week: number | null;
  bench_1rm_kg: number | null;
  squat_1rm_kg: number | null;
  deadlift_1rm_kg: number | null;
  run_5k_time: string;
  run_10k_time: string;
  other_benchmarks: string;
  // Schedule & Equipment
  available_days: string[];
  session_duration_mins: number | null;
  gym_access: boolean | null;
  equipment_notes: string;
  schedule_notes: string;
  allow_multi_session_days: boolean;
  // Preferred sessions
  recurring_session_requests: RecurringSessionRequest[];
  // Health
  current_injuries: string;
  injury_history: string;
  exercises_to_avoid: string;
  health_notes: string;
  // Preferences
  preferred_style: string;
  training_enjoyments: string;
  training_dislikes: string;
  indoor_outdoor: string;
  additional_notes: string;
  meal_variety_preference: string;
  country: string;
  grocery_stores_notes: string;
  // Generated context
  generated_analysis_context: string;
  setup_completed: boolean;
}

async function getUid(): Promise<string> {
  const cookieStore = await cookies();
  const supabase = createSSRClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  return user.id;
}

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function saveProfileStep(
  partial: Partial<AthleteProfile>
): Promise<{ error?: string }> {
  const uid = await getUid();
  const { error } = await sb().from("athlete_profile").upsert(
    { user_id: uid, ...partial, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) return { error: error.message };

  // Mirror into athlete_memory so the Python LangGraph pipeline (which only
  // reads preferences via get_athlete_memory) sees this without a separate query.
  if (partial.meal_variety_preference) {
    await sb().rpc("upsert_athlete_memory", {
      p_user_id: uid,
      p_category: "preferences",
      p_key: "meal_variety",
      p_value: partial.meal_variety_preference,
      p_confidence: 100,
      p_source: "user_stated",
    });
  }
  if (partial.weight_goal_direction) {
    await sb().rpc("upsert_athlete_memory", {
      p_user_id: uid,
      p_category: "goals",
      p_key: "weight_direction",
      p_value: partial.weight_goal_direction,
      p_confidence: 100,
      p_source: "user_stated",
    });
  }

  revalidatePath("/profile");
  revalidatePath("/setup");
  return {};
}

export async function getAthleteProfile(): Promise<AthleteProfile | null> {
  const uid = await getUid();
  const { data } = await sb().from("athlete_profile").select("*").eq("user_id", uid).limit(1);
  return data?.[0] ?? null;
}
