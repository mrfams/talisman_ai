import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, MessageSquarePlus, Square, Wrench } from "lucide-react";
import { api, streamMessage, type StoredMessage } from "../lib/api";
import { errorMessage, useConversations, useMessages } from "../lib/queries";
import { Badge, Button, Empty, IconButton, Markdown, Notice, Skeleton } from "../ui";

function textOf(message: StoredMessage): string {
  if (typeof message.content === "string") return message.content;
  if (message.content && typeof message.content === "object") {
    return typeof message.content.text === "string" ? message.content.text : "";
  }
  return "";
}

export function Chat() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const conversations = useConversations();
  const messages = useMessages(id);

  const [draft, setDraft] = useState(() => params.get("q") ?? "");
  const [liveText, setLiveText] = useState("");
  const [tools, setTools] = useState<{ name: string; phase: "start" | "end" }[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);

  const shown = messages.data ?? [];
  const activeTitle = conversations.data?.find((thread) => thread.id === id)?.title;

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [shown.length, liveText, tools.length, pending]);

  useEffect(() => {
    input.current?.focus();
  }, [id]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    setProblem(null);
    setDraft("");
    setPending(text);
    setLiveText("");
    setTools([]);

    let conversationId = id;
    try {
      if (!conversationId) {
        const created = await api.createConversation(text.slice(0, 60));
        conversationId = created.conversation.id;
        navigate(`/chat/${conversationId}`, { replace: true });
        await client.invalidateQueries({ queryKey: ["conversations"] });
      }

      const controller = new AbortController();
      abort.current = controller;
      await streamMessage(
        conversationId,
        text,
        {
          onText: (chunk) => setLiveText((current) => current + chunk),
          onTool: (event) =>
            setTools((current) => [...current, { name: event.name, phase: event.phase }]),
          onDone: () => undefined,
          onError: (message) => setProblem(message),
        },
        controller.signal,
      );
    } catch (error) {
      if ((error as Error).name !== "AbortError") setProblem(errorMessage(error));
    } finally {
      abort.current = null;
      setPending(null);
      setSending(false);
      if (conversationId) {
        await client.invalidateQueries({ queryKey: ["messages", conversationId] });
        await client.invalidateQueries({ queryKey: ["conversations"] });
        setLiveText("");
        setTools([]);
      }
      input.current?.focus();
    }
  }

  function stop() {
    abort.current?.abort();
    setSending(false);
  }

  return (
    <div className="chat">
      <aside className="chat-side" aria-label="Threads">
        <Button
          variant="secondary"
          size="sm"
          icon={<MessageSquarePlus size={14} />}
          onClick={() => navigate("/chat")}
          className="btn-block"
        >
          New chat
        </Button>
        <div className="rail-label" style={{ paddingTop: "var(--space-4)" }}>
          Recent
        </div>
        {conversations.isLoading ? (
          <div className="stack">
            <Skeleton h={14} />
            <Skeleton h={14} w="80%" />
            <Skeleton h={14} w="60%" />
          </div>
        ) : conversations.data?.length ? (
          conversations.data.map((thread) => (
            <Link
              key={thread.id}
              to={`/chat/${thread.id}`}
              className="thread-link"
              aria-current={thread.id === id ? "page" : undefined}
              title={thread.title}
            >
              {thread.title}
            </Link>
          ))
        ) : (
          <p className="tiny muted" style={{ padding: "0 12px" }}>
            No threads yet. The first message starts one.
          </p>
        )}
      </aside>

      <section className="thread">
        <header className="card-head" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="small" style={{ fontWeight: 600 }}>
              <span className="truncate" style={{ display: "block" }}>
                {activeTitle ?? (id ? "Conversation" : "New chat")}
              </span>
            </div>
            <span className="tiny faint">
              {sending ? "Working…" : "Replies stream as the agent works"}
            </span>
          </div>
          {sending ? (
            <Button size="sm" variant="secondary" icon={<Square size={12} />} onClick={stop}>
              Stop
            </Button>
          ) : null}
        </header>

        <div className="thread-scroll" ref={scroller}>
          <div className="thread-inner">
            {messages.isLoading ? (
              <div className="stack">
                <Skeleton h={20} w="55%" />
                <Skeleton h={80} />
              </div>
            ) : shown.length === 0 && !pending ? (
              <Empty
                icon={<MessageSquarePlus size={18} />}
                title="Say what you need done"
                body="Ask a question, or hand over a job. Anything multi-step becomes a durable run you can watch, pause, and approve."
                action={
                  <div className="row wrap">
                    {["Research something for me", "Plan my day", "Draft a reply"].map((prompt) => (
                      <button key={prompt} className="chip" onClick={() => setDraft(prompt)}>
                        {prompt}
                      </button>
                    ))}
                  </div>
                }
              />
            ) : (
              shown.map((message) => {
                const text = textOf(message);
                if (!text) return null;
                return (
                  <article
                    key={message.id}
                    className={`msg ${message.role === "user" ? "msg-user" : "msg-assistant"}`}
                  >
                    <div className="bubble">
                      {message.role === "user" ? text : <Markdown text={text} />}
                    </div>
                  </article>
                );
              })
            )}

            {pending ? (
              <article className="msg msg-user">
                <div className="bubble">{pending}</div>
              </article>
            ) : null}

            {tools.length ? (
              <div className="stack" style={{ gap: 6 }}>
                {tools.map((tool, index) => (
                  <div key={`${tool.name}-${index}`} className="row tiny muted" style={{ gap: 8 }}>
                    <Wrench size={12} aria-hidden />
                    <span className="mono">{tool.name}</span>
                    <Badge tone={tool.phase === "end" ? "ok" : "info"}>
                      {tool.phase === "end" ? "done" : "running"}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : null}

            {liveText ? (
              <article className="msg msg-assistant">
                <div className="bubble">
                  <Markdown text={liveText} />
                  <span className="badge" data-tone="live" style={{ marginTop: 8 }}>
                    streaming
                  </span>
                </div>
              </article>
            ) : sending ? (
              <div className="row tiny muted" style={{ gap: 8 }}>
                <span className="spinner" aria-hidden /> Thinking
              </div>
            ) : null}

            {problem ? <Notice tone="bad">{problem}</Notice> : null}
          </div>
        </div>

        <div className="composer">
          <div className="composer-box">
            <textarea
              ref={input}
              className="composer-input"
              rows={1}
              placeholder="Ask for work, or ask a question…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              aria-label="Message"
            />
            <IconButton
              label={sending ? "Stop" : "Send"}
              disabled={!draft.trim() || sending}
              onClick={() => void send()}
              style={{
                background: draft.trim() && !sending ? "var(--accent)" : "transparent",
                color: draft.trim() && !sending ? "var(--accent-ink)" : "var(--faint)",
              }}
            >
              <ArrowUp size={16} />
            </IconButton>
          </div>
          <p className="tiny faint" style={{ textAlign: "center", marginTop: 8 }}>
            Enter sends · Shift+Enter adds a line
          </p>
        </div>
      </section>
    </div>
  );
}
