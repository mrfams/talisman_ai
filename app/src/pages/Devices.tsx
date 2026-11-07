import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  MousePointerClick,
  Phone,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { api, type PhoneStatus } from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Badge, Button, Card, Empty, Notice, Skeleton } from "../ui";

interface Box {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxesFrom(result: unknown): Box[] {
  const boxes = Array.isArray(result) ? result : [];
  return boxes
    .map((box) => (box && typeof box === "object" ? (box as Record<string, unknown>) : null))
    .filter((box): box is Record<string, unknown> => Boolean(box))
    .map((box) => ({
      text: String(box.text ?? ""),
      x: Number(box.x ?? 0),
      y: Number(box.y ?? 0),
      w: Number(box.w ?? 0),
      h: Number(box.h ?? 0),
    }))
    .filter((box) => box.text.length > 0);
}

function Screen({ device }: { device: PhoneStatus }) {
  const [shot, setShot] = useState<{ png: string; bounds: { w: number; h: number } | null } | null>(
    null,
  );
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function look() {
    setBusy(true);
    setProblem(null);
    try {
      const image = await api.deviceOp("screen.capture");
      if (image.png_b64) {
        const bounds = image.bounds as { w?: number; h?: number } | null | undefined;
        setShot({
          png: image.png_b64,
          bounds:
            bounds && typeof bounds.w === "number" && typeof bounds.h === "number"
              ? { w: bounds.w, h: bounds.h }
              : null,
        });
      }
      const text = await api.deviceOp("screen.text");
      setBoxes(boxesFrom(text.result));
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function act(op: string, kw: Record<string, unknown> = {}) {
    setBusy(true);
    setProblem(null);
    try {
      await api.deviceOp(op, kw);
      await look();
    } catch (error) {
      setProblem(errorMessage(error));
      setBusy(false);
    }
  }

  const width = shot?.bounds?.w ?? 390;

  return (
    <Card flush>
      <div className="card-head">
        <div className="row" style={{ gap: 9 }}>
          <span className="provider-icon" style={{ width: 28, height: 28 }}>
            <Phone size={14} />
          </span>
          <div>
            <div className="provider-name">{device.label}</div>
            <div className="tiny faint">{device.detail}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Badge tone={device.ready ? "ok" : "warn"}>{device.ready ? "Ready" : "Offline"}</Badge>
          <Button size="sm" icon={<RefreshCw size={12} />} busy={busy} onClick={() => void look()}>
            Look
          </Button>
        </div>
      </div>

      <div className="card-body stack" style={{ gap: "var(--space-4)" }}>
        {problem ? <Notice tone="bad">{problem}</Notice> : null}

        <div className="grid-2" style={{ alignItems: "start" }}>
          <div>
            {shot ? (
              <div className="device-frame">
                {/* The image is the phone's own frame; clicks map back to screen points. */}
                <img
                  src={`data:image/png;base64,${shot.png}`}
                  alt={`${device.label} screen`}
                  onClick={(event) => {
                    const element = event.currentTarget;
                    const rect = element.getBoundingClientRect();
                    const x = Math.round(((event.clientX - rect.left) / rect.width) * width);
                    const y = Math.round(
                      ((event.clientY - rect.top) / rect.height) *
                        (shot.bounds?.h ?? (element.naturalHeight || 1)),
                    );
                    void act("input.tap", { x, y });
                  }}
                />
              </div>
            ) : (
              <div
                className="panel"
                style={{
                  display: "grid",
                  placeItems: "center",
                  minHeight: 280,
                  maxWidth: 320,
                  border: "1px dashed var(--line-strong)",
                }}
              >
                <div className="stack" style={{ alignItems: "center", gap: 8 }}>
                  <MousePointerClick size={18} className="faint" />
                  <p className="tiny muted" style={{ textAlign: "center", maxWidth: 210 }}>
                    Press Look to capture the phone. After that, tap the image to tap the device.
                  </p>
                </div>
              </div>
            )}
            <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
              <Button size="sm" onClick={() => void act("nav.home")}>
                Home
              </Button>
              <Button
                size="sm"
                icon={<ChevronLeft size={12} />}
                onClick={() => void act("nav.back")}
              >
                Back
              </Button>
              <Button
                size="sm"
                icon={<ChevronLeft size={12} style={{ transform: "rotate(-90deg)" }} />}
                onClick={() => void act("input.scroll", { direction: "down", amount: 0.4 })}
              >
                Scroll
              </Button>
            </div>
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="row-between">
              <h3 className="section-title">Text on screen</h3>
              <span className="tiny faint">{boxes.length ? `${boxes.length} labels` : ""}</span>
            </div>
            {boxes.length === 0 ? (
              <p className="small muted" style={{ marginTop: 8, lineHeight: 1.55 }}>
                Nothing read yet. “Look” extracts the labels the agent uses to decide what to tap.
              </p>
            ) : (
              <div
                className="stack"
                style={{ gap: 2, marginTop: 8, maxHeight: 330, overflow: "auto" }}
              >
                {boxes.slice(0, 60).map((box, index) => (
                  <button
                    key={`${box.text}-${index}`}
                    className="row"
                    style={{
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: "var(--r-1)",
                      textAlign: "left",
                      color: "var(--text-soft)",
                    }}
                    onClick={() =>
                      void act("input.tap", {
                        x: Math.round(box.x + box.w / 2),
                        y: Math.round(box.y + box.h / 2),
                      })
                    }
                  >
                    <span className="mono tiny faint" style={{ width: 18 }}>
                      {index}
                    </span>
                    <span className="small truncate">{box.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function Devices() {
  const query = useQuery({ queryKey: ["devices"], queryFn: api.devices, retry: false });

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="page-title">Devices</h1>
          <p className="page-sub">
            A real phone, driven through Phone Harness. The agent sees text and taps labels; it never
            gets your passwords.
          </p>
        </div>
        {query.data?.configured ? <Badge tone="live">Configured</Badge> : <Badge>Not set up</Badge>}
      </div>

      {query.isLoading ? (
        <Card>
          <Skeleton h={200} />
        </Card>
      ) : query.isError ? (
        <Notice tone="bad">{errorMessage(query.error)}</Notice>
      ) : query.data?.configured && query.data.devices.length ? (
        <div className="stack" style={{ gap: "var(--space-4)" }}>
          {query.data.devices.map((device) => (
            <Screen key={`${device.kind}-${device.label}`} device={device} />
          ))}
        </div>
      ) : (
        <>
          <Card>
            <Empty
              icon={<Phone size={15} />}
              title="No phone is connected yet"
              body="Two ways to give the agent a phone: rent a cloud phone, or run the bridge on the machine next to your own phone. The bridge is the only way to reach an iPhone or a USB Android, because a hosted server cannot touch them."
            />
          </Card>

          <div className="grid-2" style={{ alignItems: "stretch" }}>
            <Card className="provider">
              <div className="provider-head">
                <span className="provider-icon">
                  <Terminal size={15} />
                </span>
                <div>
                  <div className="provider-name">Your own phone</div>
                  <div className="provider-desc">Free, local, and the only path to iOS.</div>
                </div>
              </div>
              <p className="small muted" style={{ lineHeight: 1.55 }}>
                Install Phone Harness, connect the phone, then run the bridge on that machine:
              </p>
              <pre
                className="approval-payload"
                style={{ maxHeight: "none", whiteSpace: "pre" }}
              >
                {`PHONE_BRIDGE_TOKEN=<32+ random chars> \\\n  node scripts/phone-bridge.mjs`}
              </pre>
              <p className="tiny faint">
                Then set <span className="mono">PHONE_BRIDGE_URL</span> and{" "}
                <span className="mono">PHONE_BRIDGE_TOKEN</span> on this deployment.
              </p>
            </Card>

            <Card className="provider">
              <div className="provider-head">
                <span className="provider-icon">
                  <Phone size={15} />
                </span>
                <div>
                  <div className="provider-name">Cloud phone</div>
                  <div className="provider-desc">A hosted device, reachable over HTTPS.</div>
                </div>
              </div>
              <p className="small muted" style={{ lineHeight: 1.55 }}>
                Phone Harness Cloud hosts real iPhones and Androids. The server starts a session and
                drives it with a control token.
              </p>
              <p className="tiny faint">
                Set <span className="mono">PHONE_HARNESS_API_KEY</span> for a cloud device.
              </p>
              {query.data?.hint ? (
                <p className="tiny faint">{query.data.hint}</p>
              ) : null}
            </Card>
          </div>

          <Notice tone="warn">
            Phone control is built against the harness's documented ops and tested against a fake
            control service. No phone has been driven from this deployment yet.
          </Notice>

          <Card>
            <div className="row" style={{ gap: 9 }}>
              <ShieldCheck size={14} className="faint" aria-hidden />
              <p className="tiny muted grow">
                The agent receives an accessibility tree and screenshots. Passwords stay in the
                device's own keyboard, never in a prompt.
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
