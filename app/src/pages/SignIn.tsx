import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Sparkles } from "lucide-react";
import { api, type AuthResult } from "../lib/api";
import { errorMessage } from "../lib/queries";
import { Button, Field, Input, Notice } from "../ui";

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
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">Talisman</span>
        </div>

        <h1 className="auth-headline">Work that keeps going after you close the tab.</h1>
        <ul className="auth-points">
          <li>
            <Check size={14} aria-hidden />
            <span>Runs in a real browser, not a chat window that forgets.</span>
          </li>
          <li>
            <Check size={14} aria-hidden />
            <span>Asks before it sends, pays, or deletes anything.</span>
          </li>
          <li>
            <Check size={14} aria-hidden />
            <span>Your workspace, your database, your model keys.</span>
          </li>
        </ul>

        <span className="auth-dither dither" aria-hidden />
      </aside>

      <main className="auth-form">
        <div className="auth-card">
          <div className="stack" style={{ gap: 6 }}>
            <span className="badge" data-tone="plain">
              <Sparkles size={11} aria-hidden /> {mode === "up" ? "New workspace" : "Welcome back"}
            </span>
            <h2 style={{ fontSize: "var(--text-2xl)", letterSpacing: "-0.03em" }}>
              {mode === "up" ? "Create your workspace" : "Sign in to Talisman"}
            </h2>
            <p className="small muted">
              {mode === "up"
                ? "One workspace per team. You become its owner."
                : "Use the email and password you signed up with."}
            </p>
          </div>

          <form className="stack" style={{ gap: "var(--space-4)" }} onSubmit={onSubmit} noValidate>
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
              <Field label="Workspace name" htmlFor="org" hint="Shown across the app. Rename any time.">
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
        </div>
      </main>
    </div>
  );
}
