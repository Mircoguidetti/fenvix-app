import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { Logo } from "../components/Logo";
import { SampleLabel } from "../components/Tags";
import { session, type AuthProvider } from "../session";
import { useSession } from "../session/SessionProvider";

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <span className="google-g mono" aria-hidden="true">
      G
    </span>
  );
}

export function SignInPage() {
  const { setUser } = useSession();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function openLink() {
    setBusy(true);
    try {
      setUser(await session.completeEmailLink("sample-token"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The link did not work.");
      setBusy(false);
    }
  }

  return (
    <main id="main" className="signin" tabIndex={-1}>
      <div className="signin-card">
        <Logo />
        <div className="signin-title">
          <h1>Sign in to FENVIX</h1>
          <SampleLabel />
        </div>
        <div className="stack wide">
          <button type="button" className="btn btn-block" onClick={() => provider("github")} disabled={busy}>
            <GitHubMark />
            Continue with GitHub
          </button>
          <button type="button" className="btn btn-block" onClick={() => provider("google")} disabled={busy}>
            <GoogleMark />
            Continue with Google
          </button>
        </div>
        <div className="divider" role="separator" aria-label="or">
          <span aria-hidden="true">or</span>
        </div>
        {sentTo ? (
          <div className="callout" role="status">
            <p>
              <strong>Check your inbox.</strong> We sent a sign-in link to {sentTo}. It works once and expires in 15 minutes.
            </p>
            {session.isSample && (
              <>
                <p className="muted small">Sample mode: no email is sent. Use the button to open the link.</p>
                <div className="row-actions">
                  <button type="button" className="btn btn-primary" onClick={openLink} disabled={busy}>
                    Open the sign-in link
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={() => setSentTo(null)}>
                    Use another address
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <form onSubmit={sendLink} className="stack wide" noValidate>
            <div className="field">
              <label htmlFor="signin-email">Email</label>
              <input id="signin-email" type="email" autoComplete="email" value={email} onChange={(e) => (setEmail(e.target.value), setError(null))} placeholder="you@company.com" aria-invalid={error ? true : undefined} aria-describedby={error ? "signin-error" : undefined} />
            </div>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              <Mail size={16} aria-hidden="true" />
              Email me a sign-in link
            </button>
          </form>
        )}
        {error && (
          <p id="signin-error" className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
