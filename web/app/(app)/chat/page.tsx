import { createServerClient, getUserId } from "@/lib/supabase-server";
import { getAuthenticatedLanguage } from "@/lib/i18n/getServerLanguage";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { ChatPanel } from "./ChatPanel";

export default async function ChatPage() {
  const uid = await getUserId();
  const language = await getAuthenticatedLanguage(uid);
  const t = dictionaries[language].chat;

  const sb = createServerClient();
  const { data } = await sb
    .from("chat_messages")
    .select("id, role, content")
    .eq("user_id", uid)
    .order("created_at", { ascending: true })
    .limit(50);

  const initialMessages = (data ?? []).map((m) => ({
    id: m.id as string,
    role: m.role as "user" | "assistant",
    content: m.content as string,
  }));

  return (
    <div className="page chat-page">
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4, flexShrink: 0 }}>{t.title}</h1>
      <p style={{ color: "var(--muted)", marginBottom: 20, flexShrink: 0 }}>{t.subtitle}</p>
      <ChatPanel initialMessages={initialMessages} t={t} />
    </div>
  );
}
