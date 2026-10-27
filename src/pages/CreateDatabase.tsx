import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { client, type Database } from "../data";
import { Card, PageHeader } from "../components/PageHeader";
import { CopyButton } from "../components/CopyButton";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { parseTag } from "../lib/tags";

export function CreateDatabasePage() {
  const toast = useToast();
  const regions = useAsync(() => client.listRegions(), []);
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [tagText, setTagText] = useState("");
  useEffect(() => {
    if (regions.status === "ready" && !region) setRegion(regions.data[0]);
  }, [regions, region]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Database | null>(null);

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
    setBusy(true);
    try {
      const db = await client.createDatabase({ name, region, tags });
      setCreated(db);
      setError(null);
      toast(`Created database ${db.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the database.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <>
        <PageHeader title="Database created" back={back} />
        <Card id="created" title={<span className="mono">{created.name}</span>} description="Use this connection string in your client. Replace the password placeholder with your own.">
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
      </>
    );
  }

  return (
    <>
      <PageHeader title="Create database" description="A new database starts asleep and wakes on its first request." back={back} />
      <Card id="new" title="Details">
        <form onSubmit={submit} className="stack" noValidate>
          <div className="field">
            <label htmlFor="new-name">Name</label>
            <input id="new-name" value={name} onChange={(e) => (setName(e.target.value), setError(null))} placeholder="acme-labs-prod-01" autoComplete="off" maxLength={48} />
          </div>
          <div className="field">
            <label htmlFor="new-region">Region</label>
            <select id="new-region" value={region} onChange={(e) => setRegion(e.target.value)}>
              {regions.status === "ready" && regions.data.map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-tags">Tags</label>
            <input id="new-tags" value={tagText} onChange={(e) => (setTagText(e.target.value), setError(null))} placeholder="customer:acme-labs env:prod" autoComplete="off" aria-describedby="new-tags-help" />
            <p id="new-tags-help" className="muted small">
              key:value pairs separated by spaces or commas.
            </p>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !region}>
              Create database
            </button>
            <Link to="/databases" className="btn">
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
