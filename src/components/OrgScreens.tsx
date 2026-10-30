import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "./Logo";
import { useToast } from "./Toast";
import { orgs } from "../data/orgs-client";
import { orgNameProblem, suggestedOrgName } from "../data/orgs";
import { useOrg } from "../session/OrgProvider";
import { useSession } from "../session/SessionProvider";
import { clearPendingInvite } from "../lib/invite";

/** The full-screen frame of the screens shown before the dashboard: the same dark page as sign-in. */
function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  const { user, signOut } = useSession();
  return (
    <main id="main" className="signin-page" tabIndex={-1} aria-label={label}>
      <div className="signin-mark">
        <Logo />
      </div>
      <div className="signin-card">{children}</div>
      {user && (
        <p className="gate-foot">
          <span className="gate-who">Signed in as {user.email}</span>
          <button type="button" className="btn-link" onClick={() => void signOut()}>
            Sign out
          </button>
        </p>
      )}
    </main>
  );
}

/**
 * One field, 2 to 64 characters: names the organization a new account was given at sign-up. The field starts with the
 * name that was guessed then, once (a guess like "Spazio Milano Spazio Milano" is shown as "Spazio Milano").
 */
export function NameOrgScreen() {
  const org = useOrg();
  const navigate = useNavigate();
  const [name, setName] = useState(() => suggestedOrgName(org.current?.name ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = orgNameProblem(name);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await orgs.renameOrganization(name.trim());
      await org.refresh();
      navigate("/overview", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the name. Try again.");
      setBusy(false);
    }
  }

  return (
    <Frame label="Name your organization">
      <h1>Name your organization</h1>
      <p className="muted signin-lead">This is the name your team sees. You can change it later in Settings.</p>
      <form onSubmit={submit} className="stack wide" noValidate>
        <div className="field">
          <label htmlFor="org-name">Organization name</label>
          <input
            id="org-name"
            value={name}
            maxLength={200}
            autoComplete="off"
            autoFocus
            onChange={(e) => (setName(e.target.value), setError(null))}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "org-name-error" : "org-name-hint"}
          />
          <p id="org-name-hint" className="muted small">
            2 to 64 characters.
          </p>
          {error && (
            <p id="org-name-error" className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
          Continue
        </button>
      </form>
    </Frame>
  );
}

/** Someone who belongs to no organization (they left, or were removed): they can join one by invitation. */
export function NoOrgScreen() {
  return (
    <Frame label="No organization">
      <h1>No organization yet</h1>
      <p className="muted signin-lead">You are not part of an organization. Open the invitation link you were sent to join one.</p>
    </Frame>
  );
}

/** Opened from an invitation link. Accepting is an explicit click, never automatic. */
export function InviteScreen({ token }: { token: string }) {
  const org = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const joined = await orgs.acceptInvitation(token);
      clearPendingInvite();
      await org.refresh(joined.id);
      navigate("/overview", { replace: true });
      toast(`You joined ${joined.name}`, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "This invitation link is not valid. Ask the person who invited you for a new link.");
      setBusy(false);
    }
  }

  function dismiss() {
    clearPendingInvite();
    navigate("/overview", { replace: true });
  }

  return (
    <Frame label="Join an organization">
      <h1>Join an organization</h1>
      <p className="muted signin-lead">You were invited to an organization on FENVIX. Accept to see it in your dashboard.</p>
      {!orgs.available && (
        <p className="message" role="status">
          Invitations need the FENVIX API, which this dashboard is not set up for (VITE_API_URL).
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="stack wide">
        <button type="button" className="btn btn-primary btn-block btn-lg" onClick={accept} disabled={busy || !orgs.available}>
          Accept invitation
        </button>
        <button type="button" className="btn btn-block" onClick={dismiss} disabled={busy}>
          {error ? "Go to the dashboard" : "Not now"}
        </button>
      </div>
    </Frame>
  );
}
