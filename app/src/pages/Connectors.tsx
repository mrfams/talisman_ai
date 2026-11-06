import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Phone, Plug, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { errorMessage, useConnectors } from "../lib/queries";
import { Badge, Button, Card, Notice, Skeleton } from "../ui";

export function Connectors() {
  const state = useConnectors();
  const client = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: api.authorizeGoogle,
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (error) => setProblem(errorMessage(error)),
  });

  const verify = useMutation({
    mutationFn: api.verifyGoogle,
    onSuccess: (result) => setNote(`Google returned ${result.events} event(s).`),
    onError: (error) => setProblem(errorMessage(error)),
  });

  const disconnect = useMutation({
    mutationFn: api.disconnectGoogle,
    onSuccess: async () => {
      setNote("Google Calendar disconnected. Its stored token was deleted.");
      await client.invalidateQueries({ queryKey: ["connectors"] });
    },
    onError: (error) => setProblem(errorMessage(error)),
  });

  const google = state.data?.connectors.find((connector) => connector.id === "google");

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Connectors</h1>
          <p className="page-sub">
            Accounts the agent can use. Tokens are encrypted per person and never leave the server.
          </p>
        </div>
      </div>

      {state.data && !state.data.encryption ? (
        <Notice tone="warn">
          Credential encryption is off because <span className="mono">CREDENTIAL_ENCRYPTION_KEY</span>{" "}
          is not set. Connectors will refuse to store a token rather than keep it in plaintext.
        </Notice>
      ) : null}

      {note ? <Notice>{note}</Notice> : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}

      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card>
          <div className="row-between">
            <div className="row" style={{ gap: 10 }}>
              <span className="empty-icon" style={{ width: 34, height: 34 }}>
                <CalendarDays size={16} />
              </span>
              <div>
                <div style={{ fontWeight: 600 }}>Google Calendar</div>
                <div className="tiny faint">Read events, create them with your approval</div>
              </div>
            </div>
            {state.isLoading ? (
              <Skeleton h={18} w={80} />
            ) : google?.connected ? (
              <Badge tone="ok">Connected</Badge>
            ) : google?.configured ? (
              <Badge tone="warn">Ready</Badge>
            ) : (
              <Badge>Needs keys</Badge>
            )}
          </div>

          <div className="stack" style={{ marginTop: "var(--space-4)" }}>
            {state.isLoading ? (
              <Skeleton h={34} />
            ) : google?.connected ? (
              <div className="row wrap">
                <Button
                  size="sm"
                  icon={<RefreshCw size={13} />}
                  busy={verify.isPending}
                  onClick={() => {
                    setProblem(null);
                    setNote(null);
                    verify.mutate();
                  }}
                >
                  Test connection
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 size={13} />}
                  busy={disconnect.isPending}
                  onClick={() => {
                    setProblem(null);
                    setNote(null);
                    disconnect.mutate();
                  }}
                >
                  Disconnect
                </Button>
              </div>
            ) : google?.configured ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Plug size={13} />}
                busy={connect.isPending}
                onClick={() => {
                  setProblem(null);
                  setNote(null);
                  connect.mutate();
                }}
              >
                Connect Google Calendar
              </Button>
            ) : (
              <div className="panel">
                <p className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
                  Two values are missing
                </p>
                <p className="tiny muted">
                  Set <span className="mono">GOOGLE_CLIENT_ID</span> and{" "}
                  <span className="mono">GOOGLE_CLIENT_SECRET</span> on the deployment, then add{" "}
                  <span className="mono">/api/connectors/google/callback</span> as an authorised
                  redirect URI in Google Cloud.
                </p>
              </div>
            )}

            <div className="row tiny faint" style={{ gap: 6 }}>
              <ShieldCheck size={12} aria-hidden />
              <span>AES-256-GCM at rest · bound to your workspace and account</span>
            </div>
          </div>
        </Card>

        <Card>
          <div className="row-between">
            <div className="row" style={{ gap: 10 }}>
              <span className="empty-icon" style={{ width: 34, height: 34 }}>
                <Phone size={16} />
              </span>
              <div>
                <div style={{ fontWeight: 600 }}>Phones</div>
                <div className="tiny faint">Drive a real iPhone or Android</div>
              </div>
            </div>
            <Badge>Not set up</Badge>
          </div>
          <p className="small muted" style={{ marginTop: "var(--space-4)" }}>
            Phone control runs through Phone Harness. A cloud phone is reached over HTTPS; your own
            phone is reached through a small bridge on your machine, because a server cannot touch
            it directly.
          </p>
          <p className="tiny faint" style={{ marginTop: 8 }}>
            Needs <span className="mono">PHONE_HARNESS_API_KEY</span> or{" "}
            <span className="mono">PHONE_BRIDGE_URL</span>.
          </p>
        </Card>
      </div>
    </div>
  );
}
