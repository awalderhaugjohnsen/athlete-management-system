import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createServerClient, getUserId } from "@/lib/supabase-server";
import { CHAT_TOOL_DEFS, runChatTool } from "@/lib/chat/tools";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You are the athlete's AI coach, answering questions inside their training app's Chat tab —
the same way they'd ask a human coach a question mid-programme.

You have read-only tools into the athlete's real data (profile, current plan rationale, readiness/KPIs,
metric trends, workout history, this week's plan, nutrition history). Use them whenever a question depends
on the athlete's actual numbers, history, or plan — never guess or invent a figure a tool could return.
If a tool doesn't have what you need to answer precisely, say what you don't know rather than filling the
gap with a plausible-sounding guess.

Answer like a coach talking to their athlete: direct, specific, opinionated where the data supports it —
not a disclaimer-laden generic assistant. For "why are we doing it this way" questions, ground the answer
in the actual rationale/plan data the tools return.

You cannot directly change the athlete's plan, log data, or edit their profile — if asked to change
something, say so and point them to the relevant tab. The one exception: if the athlete mentions
something durable that will still matter weeks from now — a new or ongoing injury, a change in
available equipment or schedule (e.g. "I joined a running club on Tuesdays now"), or a strongly stated
preference — ask them directly whether you should flag it for their coach to review. Only call
propose_memory_fact after they explicitly say yes to that specific question; never call it on your own
inference, and never for something transient (today's soreness, a single missed session, mood). Calling
it does not save anything by itself — it only queues a suggestion the athlete still reviews and accepts
themselves from the dashboard or the context setup page.

Stay in the coaching lane: training, recovery, nutrition, and how those connect to this athlete's plan.
For symptoms, injuries, or medical questions beyond adjusting training load, say this needs a doctor or
qualified professional rather than a training-plan answer.

Write in plain conversational prose, the way you'd talk out loud — no markdown (no **bold**, no ##
headers, no bullet-point lists). The chat UI renders plain text only, so markdown syntax shows up as
literal asterisks and hashes instead of formatting.`;

const MAX_TOOL_ITERATIONS = 6;

export async function POST(req: NextRequest) {
  let uid: string;
  try {
    uid = await getUserId();
  } catch {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let userMessage: string;
  try {
    const body = await req.json();
    userMessage = typeof body?.message === "string" ? body.message.trim() : "";
  } catch {
    userMessage = "";
  }
  if (!userMessage) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const sb = createServerClient();
  const historyRes = await sb
    .from("chat_messages")
    .select("role, content")
    .eq("user_id", uid)
    .order("created_at", { ascending: false })
    .limit(20);
  const history = (historyRes.data ?? []).reverse();

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string })),
    { role: "user", content: userMessage },
  ];

  // Context for propose_memory_fact's source_note — the fact itself is usually stated a turn
  // before the athlete's "yes" confirmation, so use the last couple of real user turns rather
  // than just the current message.
  const recentUserText = [...history, { role: "user" as const, content: userMessage }]
    .filter((m) => m.role === "user")
    .slice(-2)
    .map((m) => m.content)
    .join(" ");

  const encoder = new TextEncoder();
  let assistantText = "";

  const body = new ReadableStream({
    async start(controller) {
      try {
        for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
          const messageStream = client.messages.stream({
            model: "claude-sonnet-5",
            max_tokens: 2000,
            system: SYSTEM,
            tools: CHAT_TOOL_DEFS,
            messages,
          });
          messageStream.on("text", (delta) => {
            assistantText += delta;
            controller.enqueue(encoder.encode(delta));
          });

          const final = await messageStream.finalMessage();
          messages.push({ role: "assistant", content: final.content as unknown as Anthropic.ContentBlockParam[] });

          if (final.stop_reason !== "tool_use") break;

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of final.content) {
            if (block.type !== "tool_use") continue;
            try {
              const result = await runChatTool(block.name, uid, block.input as Record<string, unknown>, recentUserText);
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
            } catch (err) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: err instanceof Error ? err.message : String(err),
                is_error: true,
              });
            }
          }
          messages.push({ role: "user", content: toolResults });
        }

        if (assistantText) {
          await sb.from("chat_messages").insert([
            { user_id: uid, role: "user", content: userMessage },
            { user_id: uid, role: "assistant", content: assistantText },
          ]);
        }
      } catch (err) {
        console.error("[chat] stream failed:", err);
        controller.enqueue(encoder.encode("\n\n[Something went wrong answering that — try again.]"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
