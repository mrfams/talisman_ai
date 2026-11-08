import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Copy, LogOut, Moon, Sun } from "lucide-react";
import { errorMessage, useHealth, useMe, useSignOut } from "../lib/queries";
import { Badge, Button, Card, Notice, Skeleton, timeAgo } from "../ui";

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "appearance", label: "Appearance" },
  { id: "runtime", label: "Runtime" },
  { id: "session", label: "Session" },
];

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
