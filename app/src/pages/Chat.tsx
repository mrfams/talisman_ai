import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUp, Check, MessageSquarePlus, Square, Wrench } from "lucide-react";
import { api, streamMessage, type StoredMessage } from "../lib/api";
import { errorMessage, useConversations, useMessages } from "../lib/queries";
import { Button, Markdown, Notice, Skeleton, timeAgo } from "../ui";
import { BrandMark } from "../BrandMark";

const OPENERS = [
  "Research a company and write a one-page brief",
  "Plan my week from my calendar",
  "Draft a reply to the last email I got",
];

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
  const autoStarted = useRef(false);

  const shown = messages.data ?? [];
  const activeTitle = conversations.data?.find((thread) => thread.id === id)?.title;

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [shown.length, liveText, tools.length, pending]);

  useEffect(() => {
    input.current?.focus();
  }, [id]);

  // Arriving from Today with a job should start it, not make the person press Enter twice.
  useEffect(() => {
    const opener = params.get("q")?.trim();
    if (!opener || id || autoStarted.current) return;
    autoStarted.current = true;
    void send(opener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(text = draft) {
    const body = text.trim();
    if (!body || sending) return;

    setSending(true);
    setProblem(null);
    setDraft("");
    setPending(body);
    setLiveText("");
    setTools([]);

    let conversationId = id;
    try {
      if (!conversationId) {
        const created = await api.createConversation(body.slice(0, 60));
        conversationId = created.conversation.id;
        navigate(`/chat/${conversationId}`, { replace: true });
        await client.invalidateQueries({ queryKey: ["conversations"] });
      }

      const controller = new AbortController();
      abort.current = controller;
      await streamMessage(
        conversationId,
        body,
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

  const empty = shown.length === 0 && !pending && !liveText;

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
        <div className="rail-label">Recent</div>
        {conversations.isLoading ? (
          <div className="stack" style={{ padding: "4px 8px" }}>
            <Skeleton h={12} />
            <Skeleton h={12} w="80%" />
            <Skeleton h={12} w="60%" />
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
          <p className="tiny muted" style={{ padding: "2px 8px" }}>
            No threads yet. The first message starts one.
          </p>
        )}
      </aside>

      <section className="thread">
        <header className="thread-head">
          <select
            className="select thread-select"
            aria-label="Switch conversation"
            value={id ?? ""}
            onChange={(event) =>
              navigate(event.target.value ? `/chat/${event.target.value}` : "/chat")
            }
          >
            <option value="">New chat</option>
            {conversations.data?.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.title}
              </option>
            ))}
          </select>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="small truncate" style={{ fontWeight: 550 }}>
              {activeTitle ?? (id ? "Conversation" : "New chat")}
            </div>
            <span className="tiny faint truncate">
              {sending ? "Working…" : "Replies stream as the agent works"}
            </span>
          </div>
          {sending ? (
            <Button size="sm" variant="secondary" icon={<Square size={11} />} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Link to="/chat" className="icon-btn" aria-label="Start a new chat" title="New chat">
              <MessageSquarePlus size={15} />
            </Link>
          )}
        </header>

        <div className="thread-scroll" ref={scroller}>
          <div className="thread-inner">
            {messages.isLoading && !pending ? (
              <div className="stack">
                <Skeleton h={18} w="55%" />
                <Skeleton h={70} />
              </div>
            ) : empty ? (
              <div className="chat-empty">
                <span className="chat-empty-mark">
                  <BrandMark size={30} />
                </span>
                <h2 className="chat-empty-title">
                  {id ? "Nothing in this thread yet" : "What should I get done?"}
                </h2>
                <p className="chat-empty-body">
                  {id
                    ? "Send the first message below, or start from one of these."
                    : "Ask a question, or hand over a job. Anything multi-step becomes a durable run you can watch, pause, and approve."}
                </p>
                <div className="chat-openers">
                  {OPENERS.map((opener) => (
                    <button key={opener} className="chat-opener" onClick={() => void send(opener)}>
                      <span className="grow">{opener}</span>
                      <ArrowRight size={13} aria-hidden style={{ opacity: 0.5 }} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              shown.map((message) => {
                const text = textOf(message);
                if (!text) return null;
                if (message.role === "user") {
                  return (
                    <article key={message.id} className="msg msg-user">
                      <div className="bubble">
                        {text}
                        <div className="msg-time">{timeAgo(message.createdAt)}</div>
                      </div>
                    </article>
                  );
                }
                return (
                  <article key={message.id} className="msg msg-assistant">
                    <span className="msg-avatar" aria-hidden>
                      <BrandMark size={13} />
                    </span>
                    <div className="bubble">
                      <Markdown text={text} />
                      <div className="msg-time">{timeAgo(message.createdAt)}</div>
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
              <div className="stack" style={{ gap: 5, paddingLeft: 34 }}>
                {tools.map((tool, index) => (
                  <div key={`${tool.name}-${index}`} className="tool-line">
                    {tool.phase === "end" ? (
                      <Check size={12} aria-hidden style={{ color: "var(--ok)" }} />
                    ) : (
                      <span className="spinner" aria-hidden style={{ width: 10, height: 10 }} />
                    )}
                    <span>{tool.name.replace(/_/g, " ")}</span>
                    <span style={{ opacity: 0.6 }}>
                      {tool.phase === "end" ? "finished" : "running"}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {liveText ? (
              <article className="msg msg-assistant">
                <span className="msg-avatar" aria-hidden>
                  <BrandMark size={13} />
                </span>
                <div className="bubble">
                  <Markdown text={liveText} />
                  <span className="caret" aria-label="Still writing" />
                </div>
              </article>
            ) : sending && !tools.length ? (
              <div className="row tiny muted" style={{ gap: 8, paddingLeft: 34 }}>
                <Wrench size={12} aria-hidden />
                Thinking
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
            <button
              className="composer-send"
              aria-label={sending ? "Stop" : "Send"}
              disabled={!draft.trim() || sending}
              onClick={() => void send()}
            >
              <ArrowUp size={15} />
            </button>
          </div>
          <div className="composer-hint">
            <span>Enter sends · Shift+Enter adds a line</span>
            <span>{sending ? "Streaming reply" : "Talisman can browse and take actions"}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
