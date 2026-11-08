import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Check, Copy, LogOut, Moon, Plus, Save, Sun, Trash2 } from "lucide-react";
import { errorMessage, useHealth, useMe, useSignOut } from "../lib/queries";
import { api } from "../lib/api";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Notice,
  Skeleton,
  Textarea,
  timeAgo,
} from "../ui";

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "profile", label: "Profile" },
  { id: "memory", label: "Memory" },
  { id: "appearance", label: "Appearance" },
  { id: "runtime", label: "Runtime" },
  { id: "session", label: "Session" },
];

function ProfileSection() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["profile"], queryFn: api.profile });
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [locale, setLocale] = useState("en");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!query.data) return;
    setName(query.data.profile?.displayName ?? query.data.user.name ?? "");
    setTimezone(query.data.profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
    setLocale(query.data.profile?.locale ?? "en");
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateProfile({
        displayName: name.trim() || null,
        timezone: timezone.trim(),
        locale: locale.trim() || "en",
      }),
    onSuccess: async () => {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
      await client.invalidateQueries({ queryKey: ["profile"] });
    },
  });

  return (
    <section className="settings-section" id="profile">
      <div className="settings-section-head">
        <h2>Profile</h2>
        <span className="tiny faint">Included in every chat</span>
      </div>
      <Card>
        {query.isLoading ? (
          <Skeleton h={80} />
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            <p className="small muted" style={{ margin: 0, lineHeight: 1.55 }}>
              Your name, timezone and locale are persistent context. The agent uses the timezone
              when it reads or proposes times, and schedules can inherit it.
            </p>
            <div className="grid-2">
              <Field label="Display name">
                <Input
                  value={name}
                  maxLength={120}
                  placeholder="How should Talisman address you?"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label="Timezone" hint="IANA name, for example Europe/London.">
                <Input
                  value={timezone}
                  maxLength={80}
                  onChange={(event) => setTimezone(event.target.value)}
                />
              </Field>
              <Field label="Locale">
                <Input
                  value={locale}
                  maxLength={20}
                  placeholder="en"
                  onChange={(event) => setLocale(event.target.value)}
                />
              </Field>
            </div>
            {save.isError ? <Notice tone="bad">{errorMessage(save.error)}</Notice> : null}
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                size="sm"
                icon={saved ? <Check size={12} /> : <Save size={12} />}
                busy={save.isPending}
                onClick={() => save.mutate()}
              >
                {saved ? "Saved" : "Save profile"}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}

function MemorySection() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["memories"], queryFn: api.memories });
  const [content, setContent] = useState("");
  const [kind, setKind] = useState("fact");
  const [note, setNote] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => api.addMemory({ content: content.trim(), kind }),
    onSuccess: async () => {
      setContent("");
      await client.invalidateQueries({ queryKey: ["memories"] });
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteMemory,
    onSuccess: async () => client.invalidateQueries({ queryKey: ["memories"] }),
  });
  const embed = useMutation({
    mutationFn: api.embedMemories,
    onSuccess: (result) => {
      setNote(
        result.updated > 0
          ? `Indexed ${result.updated} memory${result.updated === 1 ? "" : "ies"} with ${result.model}.`
          : "Every memory already has an embedding.",
      );
      void client.invalidateQueries({ queryKey: ["memories"] });
    },
  });

  const memories = query.data?.memories ?? [];

  return (
    <section className="settings-section" id="memory">
      <div className="settings-section-head">
        <h2>Memory</h2>
        <Badge tone="info"><Brain size={11} /> semantic</Badge>
      </div>
      <Card>
        <p className="small muted" style={{ margin: 0, lineHeight: 1.55 }}>
          Memories are retrieved by meaning, not just matching words. New memories are embedded
          automatically; the index button upgrades older ones.
        </p>
        <div className="stack" style={{ gap: 10, marginTop: 12 }}>
          <Field label="Add something the agent should remember">
            <Textarea
              value={content}
              rows={2}
              maxLength={4000}
              placeholder="I prefer short answers before 9am and a longer brief on Mondays."
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>
          <div className="row wrap" style={{ gap: 8 }}>
            <select
              className="select"
              aria-label="Memory kind"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              style={{ width: 140 }}
            >
              <option value="fact">Fact</option>
              <option value="preference">Preference</option>
              <option value="person">Person</option>
              <option value="routine">Routine</option>
            </select>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus size={12} />}
              busy={add.isPending}
              disabled={content.trim().length < 3}
              onClick={() => add.mutate()}
            >
              Remember
            </Button>
            <Button size="sm" busy={embed.isPending} onClick={() => embed.mutate()}>
              Index missing memories
            </Button>
          </div>
          {add.isError ? <Notice tone="bad">{errorMessage(add.error)}</Notice> : null}
          {embed.isError ? <Notice tone="bad">{errorMessage(embed.error)}</Notice> : null}
          {note ? <Notice tone="neutral">{note}</Notice> : null}
        </div>

        <div className="memory-list">
          {query.isLoading ? (
            <Skeleton h={80} />
          ) : memories.length === 0 ? (
            <p className="tiny muted" style={{ marginTop: 14, lineHeight: 1.55 }}>
              No memories yet. Add one here, or tell the agent “remember this” in chat.
            </p>
          ) : (
            memories.map((memory) => (
              <div className="memory-row" key={memory.id}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 7 }}>
                    <Badge tone="plain">{memory.kind}</Badge>
                    <span className="tiny faint">{timeAgo(memory.updatedAt)}</span>
                  </div>
                  <p className="small" style={{ margin: "5px 0 0", lineHeight: 1.5 }}>
                    {memory.content}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="quiet"
                  icon={<Trash2 size={12} />}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(memory.id)}
                  aria-label="Delete memory"
                >
                  Delete
                </Button>
              </div>
            ))
          )}
        </div>
      </Card>
    </section>
  );
}

export function Settings() {
  const me = useMe();
  const health = useHealth();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  const [copied, setCopied] = useState(false);

  function applyTheme(next: "light" | "dark") {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("talisman.theme", next);
    } catch {
      // The choice still applies to this session.
    }
    setTheme(next);
  }

  async function copyWorkspace() {
    const id = me.data?.user.orgId;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied; the id is still visible.
    }
  }

  const user = me.data?.user;

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Your account, the workspace, and what this deployment can do.</p>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.label}
            </a>
          ))}
        </nav>

        <div>
          <section className="settings-section" id="account">
            <div className="settings-section-head">
              <h2>Account</h2>
              {user ? <Badge tone={user.role === "member" ? "plain" : "info"}>{user.role}</Badge> : null}
            </div>
            <Card>
              {me.isLoading ? (
                <div className="stack">
                  <Skeleton h={16} w="45%" />
                  <Skeleton h={16} w="30%" />
                </div>
              ) : user ? (
                <div className="kv">
                  <div className="kv-row">
                    <span className="kv-label">Email</span>
                    <span className="kv-value">{user.email}</span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-label">Name</span>
                    <span className="kv-value">{user.name ?? "Not set"}</span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-label">Workspace</span>
                    <span className="kv-value row" style={{ gap: 6 }}>
                      <span className="mono tiny">{user.orgId.slice(0, 8)}…</span>
                      <button
                        className="icon-btn"
                        style={{ width: 22, height: 22 }}
                        onClick={() => void copyWorkspace()}
                        aria-label="Copy workspace id"
                        title="Copy workspace id"
                      >
                        {copied ? <Check size={12} style={{ color: "var(--ok)" }} /> : <Copy size={12} />}
                      </button>
                    </span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-label">Member since</span>
                    <span className="kv-value">{timeAgo(user.createdAt)}</span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-label">Authentication</span>
                    <span className="kv-value">Password, server sessions</span>
                  </div>
                </div>
              ) : (
                <Notice tone="bad">Could not load your account.</Notice>
              )}
            </Card>
          </section>

          <ProfileSection />
          <MemorySection />

          <section className="settings-section" id="appearance">
            <div className="settings-section-head">
              <h2>Appearance</h2>
              <span className="tiny faint">Stored on this device</span>
            </div>
            <Card>
              <div className="theme-grid">
                {(["dark", "light"] as const).map((option) => (
                  <button
                    key={option}
                    className="theme-option"
                    onClick={() => applyTheme(option)}
                    aria-pressed={theme === option}
                  >
                    <span className={`theme-preview theme-preview-${option}`} aria-hidden>
                      <span className="theme-preview-rail" />
                      <span className="theme-preview-body" />
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      {option === "dark" ? <Moon size={12} /> : <Sun size={12} />}
                      <span className="small" style={{ textTransform: "capitalize" }}>
                        {option}
                      </span>
                      {theme === option ? (
                        <Check size={13} style={{ color: "var(--ok)", marginLeft: "auto" }} />
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
              <p className="tiny faint" style={{ marginTop: 10 }}>
                Both themes share one palette and are finished separately, not filtered from one
                another.
              </p>
            </Card>
          </section>

          <section className="settings-section" id="runtime">
            <div className="settings-section-head">
              <h2>Runtime</h2>
              {health.data?.schema === "ok" ? <Badge tone="ok">Schema current</Badge> : null}
            </div>
            <Card>
              {health.isLoading ? (
                <Skeleton h={90} />
              ) : health.data ? (
                <div className="kv">
                  <div className="kv-row">
                    <span className="kv-label">Environment</span>
                    <span className="kv-value mono tiny">{health.data.runtime}</span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-label">Database</span>
                    <span className="kv-value">
                      <Badge tone={health.data.database === "ok" ? "ok" : "bad"}>
                        {health.data.database}
                      </Badge>
                    </span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-label">Model</span>
                    <span className="kv-value mono tiny">
                      {health.data.capabilities.models
                        ? health.data.capabilities.defaultModel
                        : "none configured"}
                    </span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-label">Browser</span>
                    <span className="kv-value mono tiny">{health.data.capabilities.browser}</span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-label">Artifacts</span>
                    <span className="kv-value mono tiny">{health.data.capabilities.artifacts}</span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-label">Executor</span>
                    <span className="kv-value mono tiny">{health.data.capabilities.executor}</span>
                  </div>
                  {!health.data.capabilities.models ? (
                    <div style={{ marginTop: 10 }}>
                      <Notice tone="warn">
                        No model provider is configured, so chat cannot answer. Set{" "}
                        <span className="mono">OPENAI_API_KEY</span>,{" "}
                        <span className="mono">GEMINI_API_KEY</span>, or{" "}
                        <span className="mono">ANTHROPIC_API_KEY</span> on the deployment.
                      </Notice>
                    </div>
                  ) : null}
                </div>
              ) : (
                <Notice tone="bad">The health endpoint did not answer.</Notice>
              )}
            </Card>
          </section>

          <section className="settings-section" id="session">
            <div className="settings-section-head">
              <h2>Session</h2>
            </div>
            <Card>
              <div className="row-between wrap">
                <div>
                  <div className="small" style={{ color: "var(--text)" }}>
                    Sign out
                  </div>
                  <p className="tiny muted" style={{ marginTop: 2 }}>
                    This ends the session on this device only.
                  </p>
                </div>
                <Button
                  icon={<LogOut size={13} />}
                  busy={signOut.isPending}
                  onClick={() =>
                    signOut.mutate(undefined, {
                      onSettled: () => navigate("/sign-in", { replace: true }),
                    })
                  }
                >
                  Sign out
                </Button>
              </div>
              {signOut.isError ? <p className="error-text">{errorMessage(signOut.error)}</p> : null}
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
