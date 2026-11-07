import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  KeyRound,
  Phone,
  Plug,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import { errorMessage, useConnectors } from "../lib/queries";
import { Badge, Button, Card, Notice, Skeleton } from "../ui";

export function Connectors() {
  const state = useConnectors();
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, retry: false });
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
  const phoneCount = devices.data?.devices.length ?? 0;
  const phonesReady = Boolean(devices.data?.configured && phoneCount);

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Connectors</h1>
          <p className="page-sub">
            Accounts the agent can use. Tokens are encrypted per person and never leave the server.
          </p>
        </div>
        <Link to="/devices" className="tiny muted">
          Device controls
        </Link>
      </div>

      {state.data && !state.data.encryption ? (
        <Notice tone="warn">
          Credential encryption is off because <span className="mono">CREDENTIAL_ENCRYPTION_KEY</span>{" "}
          is not set. Connectors will refuse to store a token rather than keep it in plaintext.
        </Notice>
      ) : null}

      {note ? <Notice>{note}</Notice> : null}
      {problem ? <Notice tone="bad">{problem}</Notice> : null}

      <div className="grid-2" style={{ alignItems: "stretch" }}>
        <Card className="provider">
          <div className="provider-head">
            <span className="provider-icon">
              <CalendarDays size={15} />
            </span>
            <div className="grow">
              <div className="provider-name">Google Calendar</div>
              <div className="provider-desc">
                Read your schedule and create events, only with your approval.
              </div>
            </div>
            {state.isLoading ? (
              <Skeleton h={18} w={72} />
            ) : google?.connected ? (
              <Badge tone="ok">Connected</Badge>
            ) : google?.configured ? (
              <Badge tone="warn">Ready to link</Badge>
            ) : (
              <Badge>Needs keys</Badge>
            )}
          </div>

          <ul className="capability-list">
            <li>
              <Check size={12} /> List events and find gaps in the day
            </li>
            <li>
              <Check size={12} /> Draft events; creating one waits in Approvals
            </li>
            <li>
              <Check size={12} /> Test the link with a real calendar call
            </li>
          </ul>

          {google?.configured ? (
            <div className="panel" style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
              <span className="row" style={{ gap: 6 }}>
                <KeyRound size={12} /> OAuth client present on this deployment
              </span>
            </div>
          ) : state.isLoading ? (
            <Skeleton h={60} />
          ) : (
            <div className="panel">
              <p className="small" style={{ fontWeight: 550, marginBottom: 3 }}>
                Two deployment values are missing
              </p>
              <p className="tiny muted" style={{ lineHeight: 1.55 }}>
                Set <span className="mono">GOOGLE_CLIENT_ID</span> and{" "}
                <span className="mono">GOOGLE_CLIENT_SECRET</span>, then add{" "}
                <span className="mono">/api/connectors/google/callback</span> as an authorised
                redirect URI in Google Cloud.
              </p>
            </div>
          )}

          <div className="provider-foot">
            {google?.connected ? (
              <>
                <Button
                  size="sm"
                  icon={<RefreshCw size={12} />}
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
                  icon={<Trash2 size={12} />}
                  busy={disconnect.isPending}
                  onClick={() => {
                    setProblem(null);
                    setNote(null);
                    disconnect.mutate();
                  }}
                >
                  Disconnect
                </Button>
              </>
            ) : google?.configured ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Plug size={12} />}
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
              <span className="tiny faint">Read the deployment guide to finish setup.</span>
            )}
            <span className="row tiny faint" style={{ gap: 5, marginLeft: "auto" }}>
              <ShieldCheck size={11} /> AES-256-GCM at rest
            </span>
          </div>
        </Card>

        <Card className="provider">
          <div className="provider-head">
            <span className="provider-icon">
              <Phone size={15} />
            </span>
            <div className="grow">
              <div className="provider-name">Phones</div>
              <div className="provider-desc">
                Drive a real iPhone or Android through Phone Harness.
              </div>
            </div>
            {devices.isLoading ? (
              <Skeleton h={18} w={72} />
            ) : phonesReady ? (
              <Badge tone="ok">{phoneCount} ready</Badge>
            ) : devices.data?.configured ? (
              <Badge tone="warn">No device</Badge>
            ) : (
              <Badge>Not set up</Badge>
            )}
          </div>

          <ul className="capability-list">
            <li>
              <Check size={12} /> Read the screen as text, tap by label or coordinate
            </li>
            <li>
              <Check size={12} /> Navigate home, back and scroll; capture screenshots
            </li>
            <li>
              <Check size={12} /> Cloud phone over HTTPS, or a bridge beside your own phone
            </li>
          </ul>

          <div className="panel">
            <p className="small" style={{ fontWeight: 550, marginBottom: 3 }}>
              {phonesReady ? "A device is reachable" : "One of two paths"}
            </p>
            <p className="tiny muted" style={{ lineHeight: 1.55 }}>
              A hosted server cannot touch your phone directly. Use{" "}
              <span className="mono">PHONE_HARNESS_API_KEY</span> for a cloud device, or run{" "}
              <span className="mono">scripts/phone-bridge.mjs</span> next to your own and set{" "}
              <span className="mono">PHONE_BRIDGE_URL</span>.
            </p>
          </div>

          <div className="provider-foot">
            <Link to="/devices">
              <Button size="sm" icon={<Phone size={12} />}>
                {phonesReady ? "Open device" : "Set up a phone"}
              </Button>
            </Link>
            <span className="tiny faint" style={{ marginLeft: "auto" }}>
              Credentials never reach the model
            </span>
          </div>
        </Card>
      </div>

      <Card>
        <div className="row" style={{ gap: 9 }}>
          <ShieldCheck size={14} className="faint" aria-hidden />
          <p className="tiny muted grow" style={{ lineHeight: 1.55 }}>
            Connector tokens are bound to your workspace and account, encrypted with a deployment
            key, and deleted when you disconnect. The agent receives tool results, never your
            password.
          </p>
        </div>
      </Card>
    </div>
  );
}
