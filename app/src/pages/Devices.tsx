import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock3,
  Pause,
  Phone,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  api,
  type PhoneDevice,
  type PhonePairing,
  type PhoneStatus,
} from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Badge, Button, Card, Empty, Input, Notice, Skeleton, timeAgo } from "../ui";

interface Box {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boundsOf(value: unknown): { x: number; y: number; w: number; h: number } {
  if (!value || typeof value !== "object") return { x: 0, y: 0, w: 0, h: 0 };
  const box = value as Record<string, unknown>;
  return {
    x: Number(box.x ?? box.left ?? 0),
    y: Number(box.y ?? box.top ?? 0),
    w: Number(box.w ?? box.width ?? 0),
    h: Number(box.h ?? box.height ?? 0),
  };
}

function boxesFrom(result: unknown): Box[] {
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const screen =
    record.screen && typeof record.screen === "object"
      ? (record.screen as Record<string, unknown>)
      : null;
  const nodes = screen?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => (node && typeof node === "object" ? (node as Record<string, unknown>) : null))
    .filter((node): node is Record<string, unknown> => Boolean(node))
    .map((node) => {
      const text = String(
        node.text ?? node.label ?? node.desc ?? node.contentDescription ?? "",
      ).trim();
      const bounds = boundsOf(node.bounds);
      return { text, ...bounds };
    })
    .filter((box) => box.text.length > 0);
}

function formatCode(code: string): string {
  const compact = code.replace(/-/g, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : code;
}

function statusTone(device: PhoneDevice): "ok" | "warn" | "bad" {
  if (device.status === "active") return device.online ? "ok" : "warn";
  if (device.status === "paused") return "warn";
  return "bad";
}

function statusLabel(device: PhoneDevice): string {
  if (device.status === "revoked") return "Revoked";
  if (device.status === "paused") return "Paused";
  return device.online ? "Online" : "Waiting";
}

function PairPanel({ onClose }: { onClose?: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState("My Android phone");
  const [pairing, setPairing] = useState<PhonePairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function start() {
    const trimmed = name.trim();
    if (!trimmed) {
      setProblem("Give the phone a name first.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const started = await api.startPhonePairing({ platform: "android", name: trimmed });
      setPairing(started);
      await client.invalidateQueries({ queryKey: ["devices"] });
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(formatCode(pairing.code));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is optional; the code is always visible.
    }
  }

  return (
    <Card>
      <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h2 className="section-title">Pair your Android phone</h2>
          <p className="small muted" style={{ maxWidth: 620, lineHeight: 1.55 }}>
            Install the Talisman Companion app on the phone, open it, and enter the code below.
            The phone polls outbound, so it works on Wi-Fi or mobile data and never needs a port
            forwarded to this server.
          </p>
        </div>
        {onClose ? (
          <Button size="sm" variant="quiet" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </div>

      {problem ? <Notice tone="bad">{problem}</Notice> : null}

      {pairing ? (
        <div className="panel" style={{ marginTop: 14, padding: 16 }}>
          <div className="row-between wrap" style={{ gap: 12 }}>
            <div className="stack" style={{ gap: 2 }}>
              <div className="tiny faint">Pairing code</div>
              <button
                className="mono"
                onClick={() => void copy()}
                title="Copy pairing code"
                style={{
                  background: "none",
                  border: 0,
                  color: "var(--text)",
                  cursor: "pointer",
                  fontSize: "clamp(24px, 4vw, 34px)",
                  letterSpacing: "0.14em",
                  padding: 0,
                  textAlign: "left",
                }}
              >
                {formatCode(pairing.code)}
              </button>
              <div className="tiny faint">
                {copied ? "Copied. " : "Tap the code to copy. "}
                Expires at {new Date(pairing.expiresAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                .
              </div>
            </div>
            <div className="stack" style={{ gap: 3, minWidth: 0 }}>
              <div className="tiny faint">Companion server</div>
              <code className="mono tiny truncate" style={{ maxWidth: 320 }}>
                {pairing.server}
              </code>
              <div className="tiny faint">
                The app verifies this host before it sends the one-time claim.
              </div>
            </div>
          </div>
          <p className="tiny faint" style={{ margin: "12px 0 0", lineHeight: 1.5 }}>
            The code is single-use and expires in five minutes. This page will show the phone as
            soon as it claims the code.
          </p>
        </div>
      ) : (
        <div className="row wrap" style={{ marginTop: 14, gap: 8, alignItems: "flex-end" }}>
          <label className="stack grow" style={{ gap: 4, minWidth: 220 }}>
            <span className="label">Phone name</span>
            <Input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="My Android phone"
            />
          </label>
          <Button variant="primary" busy={busy} onClick={() => void start()}>
            Create pairing code
          </Button>
        </div>
      )}

      <p className="tiny faint" style={{ marginTop: 12 }}>
        Android only for now. iPhone control is not available in this build.
      </p>
    </Card>
  );
}

function CompanionCard({ device }: { device: PhoneDevice }) {
  const client = useQueryClient();
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [revision, setRevision] = useState(0);
  const [frameOk, setFrameOk] = useState(true);
  const [looking, setLooking] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const diagnostics = device.diagnostics;
  const battery =
    typeof diagnostics.battery === "number"
      ? `${Math.round(diagnostics.battery * 100)}%`
      : null;
  const screen = typeof diagnostics.screen === "string" ? diagnostics.screen : null;
  const locked = typeof diagnostics.locked === "boolean" ? diagnostics.locked : null;

  async function look() {
    setLooking(true);
    setProblem(null);
    try {
      const response = await api.companionOp(device.id, "observe", { screenshot: true });
      setBoxes(boxesFrom(response.result));
      setFrameOk(true);
      setRevision(Date.now());
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setLooking(false);
    }
  }

  async function manage(action: "pause" | "resume" | "revoke") {
    if (
      action === "revoke" &&
      !window.confirm(`Revoke ${device.name}? The phone will stop receiving commands.`)
    ) {
      return;
    }
    setManaging(action);
    setProblem(null);
    try {
      if (action === "pause") await api.pauseDevice(device.id);
      else if (action === "resume") await api.resumeDevice(device.id);
      else await api.revokeDevice(device.id);
      await client.invalidateQueries({ queryKey: ["devices"] });
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setManaging(null);
    }
  }

  return (
    <Card flush>
      <div className="card-head">
        <div className="row" style={{ gap: 9, minWidth: 0 }}>
          <span className="provider-icon" style={{ width: 30, height: 30 }}>
            <Phone size={14} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="provider-name truncate">{device.name}</div>
            <div className="tiny faint truncate">
              {device.model ?? "Android device"}
              {device.osVersion ? ` · Android ${device.osVersion}` : ""}
              {device.appVersion ? ` · app ${device.appVersion}` : ""}
            </div>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <Badge tone={statusTone(device)}>{statusLabel(device)}</Badge>
          <Badge tone="plain">
            {device.online ? <Wifi size={11} /> : <WifiOff size={11} />}{" "}
            {device.online ? "Connected" : "No heartbeat"}
          </Badge>
          <Button
            size="sm"
            icon={<RefreshCw size={12} />}
            busy={looking}
            disabled={!device.online}
            onClick={() => void look()}
          >
            Look
          </Button>
        </div>
      </div>

      <div className="card-body stack" style={{ gap: "var(--space-4)" }}>
        {problem ? <Notice tone="bad">{problem}</Notice> : null}

        <div className="row wrap" style={{ gap: 14 }}>
          <span className="tiny faint row" style={{ gap: 5 }}>
            <Clock3 size={12} /> Seen {timeAgo(device.lastSeenAt)}
          </span>
          {battery ? <span className="tiny faint">Battery {battery}</span> : null}
          {screen ? <span className="tiny faint">Screen {screen}</span> : null}
          {locked === true ? <span className="tiny faint">Locked</span> : null}
          {device.status === "paused" ? (
            <span className="tiny faint">Paused by you; queued commands were cancelled.</span>
          ) : null}
        </div>

        <div className="grid-2" style={{ alignItems: "start" }}>
          <div>
            {device.online && frameOk ? (
              <div className="device-frame">
                <img
                  key={revision}
                  src={api.deviceFrameUrl(device.id, revision)}
                  alt={`${device.name} screen`}
                  loading="lazy"
                  onError={() => setFrameOk(false)}
                />
              </div>
            ) : (
              <div
                className="panel"
                style={{
                  display: "grid",
                  placeItems: "center",
                  minHeight: 240,
                  maxWidth: 320,
                  border: "1px dashed var(--line-strong)",
                  textAlign: "center",
                }}
              >
                <div className="stack" style={{ alignItems: "center", gap: 8, padding: 18 }}>
                  <Phone size={18} className="faint" />
                  <p className="tiny muted" style={{ maxWidth: 210, lineHeight: 1.5 }}>
                    {device.online
                      ? "No frame yet. Press Look to ask the phone for its current screen."
                      : "The phone is not sending heartbeats. Open Talisman Companion on the phone."}
                  </p>
                </div>
              </div>
            )}
            <p className="tiny faint" style={{ marginTop: 8, lineHeight: 1.5 }}>
              The frame is uploaded by the phone after a read-only observation. It is never cached
              by the browser.
            </p>
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="row-between">
              <h3 className="section-title">Visible text</h3>
              <span className="tiny faint">{boxes.length ? `${boxes.length} labels` : ""}</span>
            </div>
            {boxes.length === 0 ? (
              <p className="small muted" style={{ marginTop: 8, lineHeight: 1.55 }}>
                Nothing read yet. Look asks the phone for the accessibility tree, which is the same
                text the agent uses to decide what to do.
              </p>
            ) : (
              <div
                className="stack"
                style={{ gap: 2, marginTop: 8, maxHeight: 300, overflow: "auto" }}
              >
                {boxes.slice(0, 80).map((box, index) => (
                  <div
                    key={`${box.text}-${box.x}-${box.y}-${index}`}
                    className="row"
                    style={{ gap: 8, padding: "6px 8px", borderRadius: "var(--r-1)" }}
                  >
                    <span className="mono tiny faint" style={{ width: 18 }}>
                      {index}
                    </span>
                    <span className="small truncate">{box.text}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="tiny faint" style={{ marginTop: 10, lineHeight: 1.5 }}>
              Read-only. Taps and app actions must come from an approved run, never from this
              console.
            </p>
          </div>
        </div>

        <div className="row wrap" style={{ gap: 8, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          {device.status === "active" ? (
            <Button
              size="sm"
              icon={<Pause size={12} />}
              busy={managing === "pause"}
              onClick={() => void manage("pause")}
            >
              Pause
            </Button>
          ) : device.status === "paused" ? (
            <Button
              size="sm"
              icon={<Play size={12} />}
              busy={managing === "resume"}
              onClick={() => void manage("resume")}
            >
              Resume
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={12} />}
            busy={managing === "revoke"}
            onClick={() => void manage("revoke")}
          >
            Revoke
          </Button>
          <span className="tiny faint grow" style={{ alignSelf: "center" }}>
            Revoking rotates the stored hash and cancels queued work.
          </span>
        </div>
      </div>
    </Card>
  );
}

function LegacyNotice({ legacy }: { legacy: PhoneStatus }) {
  return (
    <Notice tone="neutral">
      A legacy {legacy.kind} transport is configured ({legacy.label}) and{" "}
      {legacy.ready ? "reachable" : "not reachable"}. The Android companion is the supported path;
      pair a phone above to give the agent your real apps.
    </Notice>
  );
}

export function Devices() {
  const [pairingOpen, setPairingOpen] = useState(false);
  const query = useQuery({
    queryKey: ["devices"],
    queryFn: api.devices,
    retry: false,
    refetchInterval: 4_000,
  });
  const devices = query.data?.devices ?? [];
  const active = devices.filter((device) => device.status === "active").length;

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Devices</h1>
          <p className="page-sub">
            Your own Android phone is the host. Talisman sends queued work; the companion uses the
            apps already installed on the phone and returns the result.
          </p>
        </div>
        {active > 0 ? (
          <Badge tone="live">{active} active</Badge>
        ) : query.data?.configured ? (
          <Badge tone="warn">No active phone</Badge>
        ) : (
          <Badge>Not paired</Badge>
        )}
      </div>

      {query.isLoading ? (
        <Card>
          <Skeleton h={200} />
        </Card>
      ) : query.isError ? (
        <Notice tone="bad">{errorMessage(query.error)}</Notice>
      ) : (
        <>
          {devices.length === 0 || pairingOpen ? (
            <PairPanel onClose={devices.length ? () => setPairingOpen(false) : undefined} />
          ) : null}

          {devices.length === 0 ? (
            <Card>
              <Empty
                icon={<Phone size={15} />}
                title="No phone is paired yet"
                body="Create a pairing code above, then enter it in Talisman Companion on your Android phone. The phone will appear here after it claims the code."
              />
            </Card>
          ) : (
            <div className="stack" style={{ gap: "var(--space-4)" }}>
              {devices.map((device) => (
                <CompanionCard key={device.id} device={device} />
              ))}
            </div>
          )}

          {devices.length > 0 && !pairingOpen ? (
            <div className="row">
              <Button size="sm" onClick={() => setPairingOpen(true)}>
                Pair another phone
              </Button>
            </div>
          ) : null}

          {query.data?.legacy && devices.length === 0 ? (
            <LegacyNotice legacy={query.data.legacy} />
          ) : null}

          <Card>
            <div className="row" style={{ gap: 9, alignItems: "flex-start" }}>
              <ShieldCheck size={14} className="faint" aria-hidden style={{ marginTop: 2 }} />
              <div className="stack tiny muted" style={{ gap: 4, lineHeight: 1.55 }}>
                <span>
                  The companion refuses banking, password-manager, and authenticator packages. It
                  also refuses secure windows and never auto-unlocks the phone.
                </span>
                <span>
                  Actions that can send, pay, post, or delete require an approval bound to the exact
                  arguments the phone will execute. The manual console in this page is read-only.
                </span>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
