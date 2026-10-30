import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { CircleCheck } from "lucide-react";
import { Logo } from "../components/Logo";
import { GitHubMark, GoogleMark } from "../components/marks";
import { session, type AuthProvider } from "../session";
import { useSession } from "../session/SessionProvider";

export function SignInPage() {
  const { setUser } = useSession();
  const [params, setParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(session.configError ?? null);
  const [busy, setBusy] = useState(false);
  const token = params.get("token");

  // A link that reaches the page as ?token=… (the mock's email link) signs the browser in.
  useEffect(() => {
    if (!token) return;
    let alive = true;
    session.completeEmailLink(token).then(
      (user) => alive && setUser(user),
      (e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "That sign-in link did not work.");
        setParams({}, { replace: true });
      },
    );
    return () => {
      alive = false;
    };
  }, [token, setUser, setParams]);

  async function provider(p: AuthProvider) {
    setBusy(true);
    setError(null);
    try {
      setUser(await session.signInWithProvider(p));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in did not work. Try again.");
      setBusy(false);
    }
  }

  async function sendLink(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await session.requestEmailLink(email);
      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="signin-page" tabIndex={-1}>
      <div className="signin-mark">
        <Logo />
      </div>

      <div className="signin-card">
        <h1>Sign in to FENVIX</h1>
        <p className="muted signin-lead">Use the account your fleet is on.</p>

        <div className="signin-providers">
          <button type="button" className="btn btn-block btn-lg" onClick={() => provider("github")} disabled={busy}>
            <GitHubMark />
            Continue with GitHub
          </button>
          <button type="button" className="btn btn-block btn-lg" onClick={() => provider("google")} disabled={busy}>
            <GoogleMark />
            Continue with Google
          </button>
        </div>

        <div className="divider" role="separator">
          <span>or</span>
        </div>

        {sentTo ? (
          <div className="callout callout-success" role="status">
            <p className="callout-row">
              <CircleCheck size={16} aria-hidden="true" />
              <span>
                <strong>Check your inbox.</strong> We sent a sign-in link to {sentTo}. It opens this dashboard and works once.
              </span>
            </p>
            <div className="row-actions">
              <button type="button" className="btn" onClick={() => (setSentTo(null), setEmail(""))}>
                Use another address
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={sendLink} className="stack wide" noValidate>
            <div className="field">
              <label htmlFor="signin-email">Work email</label>
              <input id="signin-email" type="email" autoComplete="email" value={email} onChange={(e) => (setEmail(e.target.value), setError(null))} placeholder="you@company.com" aria-invalid={error ? true : undefined} aria-describedby={error ? "signin-error" : undefined} />
            </div>
            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
              Email me a sign-in link
            </button>
          </form>
        )}

        {error && (
          <p id="signin-error" className="error" role="alert">
            {error}
          </p>
        )}

        <p className="signin-terms muted small">
          By continuing you agree to the <a href="https://fenvix.com/terms">Terms of Service</a> and the <a href="https://fenvix.com/privacy">Privacy Policy</a>.
        </p>
      </div>
    </main>
  );
}
