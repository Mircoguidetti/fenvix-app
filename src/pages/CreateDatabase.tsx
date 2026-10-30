import { useEffect, useRef, useState, type FormEvent } from "react";
import { useOrg } from "../session/OrgProvider";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { client, type Database, type OperationProgress } from "../data";
import { Card, PageHeader } from "../components/PageHeader";
import { CopyButton } from "../components/CopyButton";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { parseTag } from "../lib/tags";
import { SecretOnce } from "../components/PasswordOnce";
import { usernameProblem } from "../data/users";
import { OperationNote } from "../components/OperationNote";
import { Select } from "../components/Select";

export function CreateDatabasePage() {
  const { canManage } = useOrg();
  if (!canManage) {
    return (
      <>
        <PageHeader title="Create database" description="A new database starts asleep and wakes on its first request." />
        <p className="message" role="status">
          Only an owner or admin of this organization can create databases. <Link to="/databases" className="row-link">Back to databases</Link>
        </p>
      </>
    );
  }
  return <CreateDatabaseForm />;
}

function CreateDatabaseForm() {
  const toast = useToast();
  const regions = useAsync(() => client.listRegions(), []);
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [tagText, setTagText] = useState("");
  const [appUser, setAppUser] = useState("app");
  useEffect(() => {
    if (regions.status === "ready" && !region) setRegion(regions.data[0]);
  }, [regions, region]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Database | null>(null);
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  // Leaving the page stops the polling; the database is still made in the background.
  // Made in the effect, so StrictMode's trial unmount does not leave an aborted one behind.
  const leaving = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    leaving.current = c;
    return () => c.abort();
  }, []);

  const back = (
    <Link to="/databases" className="back-link">
      <ArrowLeft size={16} aria-hidden="true" />
      All databases
    </Link>
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const tags: string[] = [];
    for (const part of tagText.split(/[\s,]+/).filter(Boolean)) {
      const parsed = parseTag(part);
      if ("error" in parsed) return setError(`${part}: ${parsed.error}`);
      tags.push(parsed.tag);
    }
    const userProblem = usernameProblem(appUser);
    if (userProblem) return setError(`Database user: ${userProblem}`);
    setBusy(true);
    setError(null);
    try {
      const db = await client.createDatabase({ name, region, tags, appUser }, { onProgress: setProgress, signal: leaving.current?.signal });
      setCreated(db);
      setError(null);
      toast(`Created database ${db.name}`, "success");
    } catch (err) {
      if (leaving.current?.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Could not create the database.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  if (created) {
    const first = created.initialUser;
    return (
      <>
        <PageHeader title="Your database is ready" description="Connect any MongoDB driver with the connection string and the database user below." back={back} />
        <div className="grid-2">
          {first?.password ? (
            <Card id="credentials" title="Save the database user's password" description={`Applications connect as ${first.username}. It can read and write this database only.`}>
              <SecretOnce username={first.username} password={first.password} connectionString={first.connectionString} idPrefix="created" />
            </Card>
          ) : (
            <Card id="credentials" title="Database user" description="The password of this database's first user could not be shown here.">
              <p className="muted">Open the database, go to Users and reset the password of {first?.username ? <span className="mono">{first.username}</span> : "a user"} to get one.</p>
            </Card>
          )}
          <Card id="created" title={<span className="mono">{created.name}</span>} description="Point any MongoDB driver at this. Replace <password> with the password of the database user.">
            <label htmlFor="new-conn" className="sr-only">
              Connection string
            </label>
            <textarea id="new-conn" className="code" readOnly rows={3} value={created.connectionString} onFocus={(e) => e.currentTarget.select()} />
            <div className="row-actions">
              <CopyButton value={created.connectionString} what="connection string" />
              <Link to={`/databases/${created.id}`} className="btn btn-primary">
                Open database
              </Link>
            </div>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Create database" description="A new database starts asleep and wakes on its first request." back={back} />
      <div className="form-col">
      <Card id="new" title="Details" description="The name is part of the connection string, so it cannot change later.">
        <form onSubmit={submit} className="stack" noValidate>
          <div className="field">
            <label htmlFor="new-name">Name</label>
            <input id="new-name" value={name} onChange={(e) => (setName(e.target.value), setError(null))} placeholder="acme-labs-prod-01" autoComplete="off" maxLength={48} />
          </div>
          <div className="field">
            <label htmlFor="new-region">Region</label>
            <Select id="new-region" value={region} onChange={setRegion} options={regions.status === "ready" ? regions.data.map((r) => ({ value: r, label: r })) : []} />
          </div>
          <div className="field">
            <label htmlFor="new-user">Database user</label>
            <input id="new-user" className="mono" value={appUser} onChange={(e) => (setAppUser(e.target.value), setError(null))} autoComplete="off" spellCheck={false} maxLength={32} aria-describedby="new-user-help" />
            <p id="new-user-help" className="muted small">
              Your application connects as this user. Its password is made for you and shown once, on the next screen.
            </p>
          </div>
          <div className="field">
            <label htmlFor="new-tags">Tags</label>
            <input id="new-tags" value={tagText} onChange={(e) => (setTagText(e.target.value), setError(null))} placeholder="customer:acme-labs env:prod" autoComplete="off" aria-describedby="new-tags-help" />
            <p id="new-tags-help" className="muted small">
              key:value pairs separated by spaces or commas.
            </p>
          </div>
          {regions.status === "error" && (
            <p className="error" role="alert">
              {regions.message}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <OperationNote progress={busy ? progress : null} />
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !region}>
              {busy ? "Creating…" : "Create database"}
            </button>
            <Link to="/databases" className="btn">
              Cancel
            </Link>
          </div>
        </form>
      </Card>
      </div>
    </>
  );
}
