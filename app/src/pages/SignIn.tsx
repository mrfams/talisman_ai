import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { api, type AuthResult } from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Button, Field, Input, Notice } from "../ui";
import { BrandMark } from "../BrandMark";

const PASSWORD_MIN = 12;

export function SignIn({ mode }: { mode: "in" | "up" }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const passwordProblem =
    touched && password.length > 0 && password.length < PASSWORD_MIN
      ? `Use at least ${PASSWORD_MIN} characters.`
      : null;

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === "up") {
        return api.signup({
          email: email.trim(),
          password,
          name: name.trim() || undefined,
          orgName: orgName.trim(),
        });
      }
      return api.login(email.trim(), password);
    },
    onSuccess: (result: AuthResult) => {
      client.setQueryData(["me"], { user: result.user });
      navigate("/", { replace: true });
    },
    onError: (error) => setProblem(errorMessage(error)),
  });

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    setProblem(null);
    if (mode === "up" && orgName.trim().length < 2) {
      setProblem("Give the workspace a name — you can change it later.");
      return;
    }
    if (mode === "up" && password.length < PASSWORD_MIN) {
      setProblem(`Use at least ${PASSWORD_MIN} characters.`);
      return;
    }
    submit.mutate();
  }

  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">
            <BrandMark size={24} />
          </span>
          <span className="brand-name">Talisman</span>
        </div>

        <div style={{ marginTop: "auto" }}>
          <span className="eyebrow">Agent workspace</span>
          <h1 className="auth-headline" style={{ marginTop: 10 }}>
            Work that keeps going after you close the tab.
          </h1>
          <p className="small muted" style={{ marginTop: 12, maxWidth: "42ch", lineHeight: 1.6 }}>
            Give it a job in plain language. It plans, works in a real browser, and comes back only
            when a decision needs you.
          </p>
        </div>

        <ul className="auth-points">
          <li>
            <Check size={13} aria-hidden />
            <span>Durable runs, not a chat window that forgets.</span>
          </li>
          <li>
            <Check size={13} aria-hidden />
            <span>Approvals before anything sends, pays, or deletes.</span>
          </li>
          <li>
            <Check size={13} aria-hidden />
            <span>Your workspace, your database, your model keys.</span>
          </li>
        </ul>

        <div className="auth-foot" style={{ marginTop: 0, width: "100%" }}>
          <span>Real browser · Durable runs</span>
          <span>v0.2</span>
        </div>

        <span className="auth-dither dither" aria-hidden />
      </aside>

      <main className="auth-form">
        <div className="auth-card">
          <div className="brand" style={{ padding: 0, marginBottom: 4 }}>
            <span className="brand-mark">
              <BrandMark size={22} />
            </span>
            <span className="brand-name">Talisman</span>
          </div>

          <div className="stack" style={{ gap: 5 }}>
            <h2 style={{ fontSize: "var(--text-xl)", letterSpacing: "-0.025em" }}>
              {mode === "up" ? "Create your workspace" : "Sign in"}
            </h2>
            <p className="small muted">
              {mode === "up"
                ? "One workspace per team. You become its owner."
                : "Use the email and password you signed up with."}
            </p>
          </div>

          <form className="stack" style={{ gap: "var(--space-3)" }} onSubmit={onSubmit} noValidate>
            {mode === "up" ? (
              <Field label="Your name" htmlFor="name" hint="Optional. Used in the sidebar.">
                <Input
                  id="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  placeholder="Ada Lovelace"
                />
              </Field>
            ) : null}

            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                placeholder="you@company.com"
                required
              />
            </Field>

            <Field
              label="Password"
              htmlFor="password"
              error={mode === "up" ? passwordProblem : null}
              hint={mode === "up" ? "At least 12 characters. Length beats symbols." : undefined}
            >
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "up" ? "new-password" : "current-password"}
                required
              />
            </Field>

            {mode === "up" ? (
              <Field
                label="Workspace name"
                htmlFor="org"
                hint="Shown across the app. Rename any time."
              >
                <Input
                  id="org"
                  value={orgName}
                  onChange={(event) => setOrgName(event.target.value)}
                  placeholder="Acme"
                  required
                />
              </Field>
            ) : null}

            {problem ? <Notice tone="bad">{problem}</Notice> : null}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="btn-block"
              busy={submit.isPending}
            >
              {mode === "up" ? "Create workspace" : "Sign in"}
            </Button>
          </form>

          <p className="small muted">
            {mode === "up" ? (
              <>
                Already have a workspace? <Link to="/sign-in">Sign in</Link>
              </>
            ) : (
              <>
                New to Talisman? <Link to="/sign-up">Create a workspace</Link>
              </>
            )}
          </p>

          <div className="auth-foot">
            <span>Encrypted session cookie</span>
            <span>No tracking</span>
          </div>
        </div>
      </main>
    </div>
  );
}
