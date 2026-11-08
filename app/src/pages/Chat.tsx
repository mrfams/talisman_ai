import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUp, Check, ListChecks, MessageSquarePlus, Square, Wrench, X } from "lucide-react";
import { api, streamMessage, type PhoneApproval, type StoredMessage } from "../lib/api";
import { errorMessage, useConversations, useMessages } from "../lib/queries";
import { Button, Markdown, Notice, Skeleton, timeAgo } from "../ui";
import { BrandMark } from "../BrandMark";

interface RunInfo {
  id: string;
  status: string;
  progress: number;
}

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
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [phoneApprovals, setPhoneApprovals] = useState<PhoneApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState<{
    tone: "neutral" | "warn" | "bad";
    text: string;
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const autoStarted = useRef(false);
  const phoneTurns = useRef(0);
  const streaming = useRef(false);
  const streamSeq = useRef(0);

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

  async function send(
    text = draft,
    options: { internal?: boolean; context?: string } = {},
  ) {
    const body = text.trim();
    if (!body || streaming.current) return;
    if (options.internal && phoneTurns.current >= 8) {
      setApprovalNote({
        tone: "warn",
        text: "The phone task paused after 8 steps. Ask me to continue when you are ready.",
      });
      return;
    }
    streaming.current = true;
    const streamId = ++streamSeq.current;
    if (options.internal) phoneTurns.current += 1;
    else phoneTurns.current = 0;

    setSending(true);
    setProblem(null);
    if (!options.internal) {
      setDraft("");
      setPending(body);
      setPhoneApprovals([]);
      setApprovalNote(null);
    }
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
          onTool: (event) => {
            setTools((current) => [...current, { name: event.name, phase: event.phase }]);
            if (event.task) {
              const task = event.task;
              setRuns((current) => [
                ...current.filter((run) => run.id !== task.id),
                task,
              ]);
            }
          },
          onApproval: (approval) => {
            setPhoneApprovals((current) => [
              ...current.filter((item) => item.id !== approval.id),
              {
                id: approval.id,
                deviceId: "",
                op: "act",
                args: {},
                summary: approval.summary,
                status: "pending",
                expiresAt: approval.expiresAt ?? new Date().toISOString(),
                createdAt: new Date().toISOString(),
                decidedAt: null,
                plan: approval.plan ?? null,
              },
            ]);
          },
          onDone: () => undefined,
          onError: (message) => setProblem(message),
        },
        controller.signal,
        { internal: options.internal, context: options.context },
      );
    } catch (error) {
      if ((error as Error).name !== "AbortError") setProblem(errorMessage(error));
    } finally {
      // A stopped or superseded stream must not clear the state of the request
      // that replaced it. The invisible continuation after a phone approval
      // depends on this guard.
      if (streamSeq.current === streamId) {
        abort.current = null;
        streaming.current = false;
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
  }

  function stop() {
    streamSeq.current += 1;
    streaming.current = false;
    abort.current?.abort();
    abort.current = null;
    setSending(false);
  }

  async function decidePhoneApproval(id: string, decision: "approved" | "denied") {
    const summary = phoneApprovals.find((item) => item.id === id)?.summary ?? "phone action";
    setApprovalBusy(id);
    setApprovalNote(null);
    try {
      const result = await api.decidePhoneApproval(id, decision);
      setPhoneApprovals((current) => current.filter((item) => item.id !== id));
      if (decision === "denied") {
        setApprovalNote({ tone: "neutral", text: "Refused. Nothing was sent to the phone." });
        return;
      }

      let outcome: string;
      if (result.command?.status === "done") {
        outcome = `The approved action completed on the phone: ${summary}.`;
        setApprovalNote({ tone: "neutral", text: "Approved and completed on the phone." });
      } else if (result.command?.status === "error") {
        outcome = `The approved action failed on the phone: ${result.command.error ?? "unknown error"}.`;
        setApprovalNote({
          tone: "bad",
          text: `Approved, but the phone returned an error: ${result.command.error ?? "unknown"}`,
        });
      } else {
        outcome = `The approved action was queued but the phone has not confirmed it yet: ${summary}.`;
        setApprovalNote({
          tone: "warn",
          text: "Approved and queued. Reading the phone screen again…",
        });
      }

      if (result.command) {
        await send("Continue the phone task from the current screen.", {
          internal: true,
          context: `${outcome} Continue the original phone request. Do not repeat the action that just ran; read the screen first and take the next step, or say the task is done.`,
        });
      }
    } catch (error) {
      setApprovalNote({ tone: "bad", text: errorMessage(error) });
    } finally {
      setApprovalBusy(null);
    }
  }

  const activeRunKey = runs
    .filter((run) => ["queued", "scheduled", "running"].includes(run.status))
    .map((run) => `${run.id}:${run.status}`)
    .join("|");

  // A chat-created run keeps moving while this page is open. The serverless
  // deployment has no always-on worker, so the page drives the next slice and
  // shows the status instead of leaving the user with an unexplained promise.
  useEffect(() => {
    if (!activeRunKey) return;
    let cancelled = false;
    let busy = false;
    const active = runs.filter((run) =>
      ["queued", "scheduled", "running"].includes(run.status),
    );
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const run of active) {
          if (cancelled) return;
          if (!["waiting_approval", "paused"].includes(run.status)) {
            await api.taskAction(run.id, "run").catch(() => undefined);
          }
          const detail = await api.task(run.id).catch(() => null);
          if (detail && !cancelled) {
            setRuns((current) =>
              current.map((item) =>
                item.id === run.id
                  ? { ...item, status: detail.task.status, progress: detail.task.progress }
                  : item,
              ),
            );
          }
        }
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunKey]);

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

            {runs.length ? (
              <div className="stack" style={{ gap: 5, paddingLeft: 34 }}>
                {runs.map((run) => (
                  <Link
                    key={run.id}
                    to={`/tasks/${run.id}`}
                    className="tool-line"
                    style={{ textDecoration: "none", color: "inherit" }}
                  >
                    <ListChecks size={12} aria-hidden style={{ color: "var(--ok)" }} />
                    <span>Run {run.id.slice(0, 8)}</span>
                    <span style={{ opacity: 0.6 }}>
                      {run.status.replace(/_/g, " ")} · {run.progress}%
                    </span>
                  </Link>
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

            {phoneApprovals.length ? (
              <div className="stack" style={{ gap: 8, paddingLeft: 34 }}>
                {phoneApprovals.map((approval) => (
                  <div key={approval.id} className="panel" style={{ padding: 12 }}>
                    <div className="row-between wrap" style={{ gap: 10 }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="small" style={{ fontWeight: 600 }}>
                          {approval.summary}
                        </div>
                        {approval.plan?.length ? (
                          <ol className="plan-list">
                            {approval.plan.map((step, index) => (
                              <li key={`${approval.id}-${index}`}>{step}</li>
                            ))}
                          </ol>
                        ) : null}
                        <div className="tiny faint" style={{ marginTop: 3 }}>
                          Phone approval · one action only · expires{" "}
                          {new Date(approval.expiresAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        <Button
                          size="sm"
                          variant="primary"
                          icon={<Check size={12} />}
                          busy={approvalBusy === approval.id}
                          onClick={() => void decidePhoneApproval(approval.id, "approved")}
                        >
                          Allow once
                        </Button>
                        <Button
                          size="sm"
                          icon={<X size={12} />}
                          busy={approvalBusy === approval.id}
                          onClick={() => void decidePhoneApproval(approval.id, "denied")}
                        >
                          Refuse
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {approvalNote ? <Notice tone={approvalNote.tone}>{approvalNote.text}</Notice> : null}

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
