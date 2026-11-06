import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, LogOut, Moon, Sun } from "lucide-react";
import { errorMessage, useHealth, useMe, useSignOut } from "../lib/queries";
import { Badge, Button, Card, Notice, Skeleton, timeAgo } from "../ui";

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function Settings() {
  const me = useMe();
  const health = useHealth();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);

  function applyTheme(next: "light" | "dark") {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("talisman.theme", next);
    } catch {
      // The choice still applies to this session.
    }
    setTheme(next);
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

      <Card>
        <h2 className="section-title" style={{ marginBottom: "var(--space-4)" }}>
          Account
        </h2>
        {me.isLoading ? (
          <div className="stack">
            <Skeleton h={16} w="45%" />
            <Skeleton h={16} w="30%" />
          </div>
        ) : user ? (
          <div className="stack" style={{ gap: "var(--space-3)" }}>
            <div className="row-between small">
              <span className="muted">Email</span>
              <span>{user.email}</span>
            </div>
            <div className="row-between small">
              <span className="muted">Name</span>
              <span>{user.name ?? "Not set"}</span>
            </div>
            <div className="row-between small">
              <span className="muted">Role</span>
              <Badge tone={user.role === "member" ? "plain" : "info"}>{user.role}</Badge>
            </div>
            <div className="row-between small">
              <span className="muted">Workspace</span>
              <span className="mono tiny" title={user.orgId}>
                {user.orgId.slice(0, 8)}…
              </span>
            </div>
            <div className="row-between small">
              <span className="muted">Member since</span>
              <span>{timeAgo(user.createdAt)}</span>
            </div>
          </div>
        ) : (
          <Notice tone="bad">Could not load your account.</Notice>
        )}
      </Card>

      <Card>
        <h2 className="section-title" style={{ marginBottom: "var(--space-4)" }}>
          Appearance
        </h2>
        <div className="row wrap">
          {(["dark", "light"] as const).map((option) => (
            <button
              key={option}
              className="chip"
              onClick={() => applyTheme(option)}
              aria-pressed={theme === option}
              style={{
                padding: "8px 12px",
                borderColor: theme === option ? "var(--accent)" : undefined,
                color: theme === option ? "var(--text)" : undefined,
              }}
            >
              {option === "dark" ? <Moon size={13} /> : <Sun size={13} />}
              {option === "dark" ? "Dark" : "Light"}
              {theme === option ? <Check size={12} style={{ color: "var(--mint)" }} /> : null}
            </button>
          ))}
        </div>
        <p className="tiny faint" style={{ marginTop: 10 }}>
          The choice is stored on this device. Both themes are finished, not a filter.
        </p>
      </Card>

      <Card>
        <h2 className="section-title" style={{ marginBottom: "var(--space-4)" }}>
          This deployment
        </h2>
        {health.isLoading ? (
          <Skeleton h={60} />
        ) : health.data ? (
          <div className="stack" style={{ gap: "var(--space-3)" }}>
            <div className="row-between small">
              <span className="muted">Runtime</span>
              <span className="mono tiny">{health.data.runtime}</span>
            </div>
            <div className="row-between small">
              <span className="muted">Database</span>
              <Badge tone={health.data.database === "ok" ? "ok" : "bad"}>
                {health.data.database}
              </Badge>
            </div>
            <div className="row-between small">
              <span className="muted">Model</span>
              <span className="mono tiny">
                {health.data.capabilities.models ? health.data.capabilities.defaultModel : "none configured"}
              </span>
            </div>
            <div className="row-between small">
              <span className="muted">Browser</span>
              <span className="mono tiny">{health.data.capabilities.browser}</span>
            </div>
            <div className="row-between small">
              <span className="muted">Artifacts</span>
              <span className="mono tiny">{health.data.capabilities.artifacts}</span>
            </div>
            {!health.data.capabilities.models ? (
              <Notice tone="warn">
                No model provider is configured, so chat cannot answer. Set{" "}
                <span className="mono">OPENAI_API_KEY</span> (or Anthropic) on the deployment.
              </Notice>
            ) : null}
          </div>
        ) : (
          <Notice tone="bad">The health endpoint did not answer.</Notice>
        )}
      </Card>

      <Card>
        <div className="row-between wrap">
          <div>
            <div style={{ fontWeight: 600 }}>Sign out</div>
            <p className="tiny muted">This ends the session on this device only.</p>
          </div>
          <Button
            icon={<LogOut size={14} />}
            busy={signOut.isPending}
            onClick={() =>
              signOut.mutate(undefined, { onSettled: () => navigate("/sign-in", { replace: true }) })
            }
          >
            Sign out
          </Button>
        </div>
        {signOut.isError ? <p className="error-text">{errorMessage(signOut.error)}</p> : null}
      </Card>
    </div>
  );
}
