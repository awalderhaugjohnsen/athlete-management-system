"use client";

import { useEffect, useRef, useState } from "react";
import type { Dictionary } from "@/lib/i18n/types";

interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
}

// The model is asked for plain prose, but occasionally reaches for markdown anyway
// (bold, headers, dash lists) — that's a formatting concern, not a coaching judgment
// call, so it's handled here in code rather than chased indefinitely in the prompt.
// Lightweight on purpose: bold, "## "/"# " headings, and "- "/"* " lists only, not a
// full markdown parser.
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={`${keyPrefix}-${i}`}>{part}</span>
    )
  );
}

function renderContent(content: string): React.ReactNode {
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];

  function flushList(key: string) {
    if (!listItems.length) return;
    blocks.push(
      <ul key={key} className="chat-list">
        {listItems.map((item, i) => (
          <li key={i}>{renderInline(item, `${key}-li-${i}`)}</li>
        ))}
      </ul>
    );
    listItems = [];
  }

  content.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      listItems.push(trimmed.slice(2));
      return;
    }
    flushList(`list-${i}`);
    if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
      const heading = trimmed.replace(/^#{1,2}\s+/, "");
      blocks.push(<div key={i} className="chat-heading">{renderInline(heading, `h-${i}`)}</div>);
    } else if (trimmed) {
      blocks.push(<p key={i} className="chat-paragraph">{renderInline(trimmed, `p-${i}`)}</p>);
    }
  });
  flushList("list-end");
  return blocks;
}

export function ChatPanel({
  initialMessages,
  t,
}: {
  initialMessages: ChatMessage[];
  t: Dictionary["chat"];
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;

    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) throw new Error("Request failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { ...next[next.length - 1], content: next[next.length - 1].content + chunk };
          return next;
        });
      }
    } catch {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { ...next[next.length - 1], content: t.errorMessage };
        return next;
      });
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="card chat-panel">
      <div className="chat-messages">
        {messages.length === 0 && <p className="chat-empty">{t.emptyState}</p>}
        {messages.map((m, i) => (
          <div key={m.id ?? i} className={`chat-message chat-message-${m.role}`}>
            {m.content
              ? m.role === "assistant"
                ? renderContent(m.content)
                : m.content
              : sending && i === messages.length - 1
                ? "…"
                : ""}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <textarea
          className="textarea"
          rows={1}
          placeholder={t.placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
        />
        <button className="btn-primary" onClick={send} disabled={sending || !input.trim()}>
          {t.send}
        </button>
      </div>
    </div>
  );
}
