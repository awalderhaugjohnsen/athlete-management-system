"use server";

import { revalidatePath } from "next/cache";
import { createServerClient, getUserId } from "@/lib/supabase-server";

export interface MemorySuggestion {
  id: string;
  category: string;
  key: string;
  value: string;
  source_note: string | null;
  created_at: string;
}

export async function getPendingMemorySuggestions(): Promise<MemorySuggestion[]> {
  const sb = createServerClient();
  const userId = await getUserId();

  const { data } = await sb
    .from("athlete_memory_suggestions")
    .select("id, category, key, value, source_note, created_at")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at");

  return (data ?? []) as MemorySuggestion[];
}

export async function resolveMemorySuggestion(id: string, accept: boolean): Promise<void> {
  const sb = createServerClient();
  const userId = await getUserId();

  const { data: suggestion, error: fetchError } = await sb
    .from("athlete_memory_suggestions")
    .select("category, key, value")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (fetchError || !suggestion) throw new Error(fetchError?.message ?? "Suggestion not found");

  if (accept) {
    const { error: rpcError } = await sb.rpc("upsert_athlete_memory", {
      p_user_id: userId,
      p_category: suggestion.category,
      p_key: suggestion.key,
      p_value: suggestion.value,
      p_confidence: 100,
      p_source: "user_confirmed",
    });
    if (rpcError) throw new Error(rpcError.message);
  }

  const { error } = await sb
    .from("athlete_memory_suggestions")
    .update({
      status: accept ? "accepted" : "dismissed",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId);

  if (error) throw new Error(error.message);
  revalidatePath("/");
}
