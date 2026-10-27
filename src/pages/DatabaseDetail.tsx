import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, GitFork, History, Trash2 } from "lucide-react";
import { client, type UsageRange } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { CopyButton } from "../components/CopyButton";
import { StateBadge } from "../components/StateBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { download } from "../lib/download";
import { TagEditor } from "../components/TagEditor";
import { UsageChart, type Metric } from "../components/UsageChart";
import { useAsync } from "../lib/useAsync";
import { formatCount, formatDate, formatDateTime, formatRelative, formatStorage } from "../lib/format";

const RANGES: UsageRange[] = ["24h", "7d", "30d"];
const METRICS: { value: Metric; label: string }[] = [
  { value: "requests", label: "Requests" },
  { value: "storageMb", label: "Storage" },
];

export function DatabaseDetailPage() {
  const { id = "" } = useParams();
  return <DatabaseDetail key={id} id={id} />;
}

type Dialog = "fork" | "restore" | "erase" | null;

/** `YYYY-MM-DDTHH:mm` in UTC, the format of a datetime-local input. */
const toInput = (d: Date) => d.toISOString().slice(0, 16);

function DatabaseDetail({ id }: { id: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [field, setField] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keepLocal, setKeepLocal] = useState<boolean | null>(null);
  const db = useAsync(() => client.getDatabase(id), [id]);
  const [range, setRange] = useState<UsageRange>("7d");
  const [metric, setMetric] = useState<Metric>("requests");
  const usage = useAsync(() => client.getUsage(id, range), [id, range]);
  const loadedKeep = db.status === "ready" ? db.data?.keepAwake : undefined;
  useEffect(() => setKeepLocal(null), [loadedKeep]);

  const back = (
    <Link to="/" className="back-link">
      <ArrowLeft size={16} aria-hidden="true" />
      All databases
    </Link>
  );

  if (db.status === "loading") return <><PageHeader title="Database" back={back} /><Message>Loading database</Message></>;
  if (db.status === "error") return <><PageHeader title="Database" back={back} /><Message role="alert">{db.message}</Message></>;
  if (!db.data) return <><PageHeader title="Database not found" back={back} /><Message>No database with this id in the sample data.</Message></>;

  const d = db.data;
  const now = client.now();
  const keepAwake = keepLocal ?? d.keepAwake;

  function open(next: Dialog) {
    setError(null);
    setBusy(false);
    setField(next === "fork" ? `${d.name}-fork`.slice(0, 48) : next === "restore" ? toInput(new Date(now.getTime() - 3600_000)) : "");
    setDialog(next);
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      setDialog(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const fork = () =>
    run(async () => {
      const copy = await client.forkDatabase(d.id, field);
      toast(`Forked ${d.name} as ${copy.name}`);
      navigate(`/databases/${copy.id}`);
    });
  const restore = () =>
    run(async () => {
      if (!field) throw new Error("Choose a date and time.");
      await client.restoreDatabase(d.id, `${field}:00Z`);
      toast(`Restored ${d.name} to ${formatDateTime(`${field}:00Z`)}`);
      db.reload();
    });
  const erase = () =>
    run(async () => {
      await client.eraseDatabases([d.id]);
      toast(`Erased ${d.name}`);
      navigate("/");
    });
  async function exportData() {
    try {
      const file = await client.exportDatabases([d.id]);
      download(file);
      toast(`Export ready: ${file.filename}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Export failed.");
    }
  }
  async function toggleKeepAwake(on: boolean) {
    setKeepLocal(on);
    try {
      await client.setKeepAwake([d.id], on);
      toast(on ? `${d.name} will stay awake` : `${d.name} can sleep when idle`);
      db.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not change keep awake.");
      setKeepLocal(null);
    }
  }

  return (
    <>
      <PageHeader title={<span className="mono">{d.name}</span>} back={back} actions={<StateBadge state={d.state} />} />

      <div className="grid-2">
        <Card id="conn" title="Connection string" description="Use this in your client. Replace the password placeholder with your own.">
          <label htmlFor="conn-string" className="sr-only">
            Connection string
          </label>
          <textarea id="conn-string" className="code" readOnly rows={3} value={d.connectionString} onFocus={(e) => e.currentTarget.select()} />
          <div className="row-actions">
            <CopyButton value={d.connectionString} what="connection string" />
          </div>
        </Card>

        <Card id="status" title="Status">
          <dl className="facts">
            <div>
              <dt>State</dt>
              <dd>
                <StateBadge state={d.state} />
              </dd>
            </div>
            <div>
              <dt>Storage</dt>
              <dd className="mono">{formatStorage(d.storageMb)}</dd>
            </div>
            <div>
              <dt>Requests (24 h)</dt>
              <dd className="mono">{formatCount(d.requests24h)}</dd>
            </div>
            <div>
              <dt>Last active</dt>
              <dd title={formatDateTime(d.lastActiveAt)}>{formatRelative(d.lastActiveAt, now)}</dd>
            </div>
            <div>
              <dt>Region</dt>
              <dd className="mono">{d.region}</dd>
            </div>
            <div>
              <dt>Keep awake</dt>
              <dd>{keepAwake ? "On" : "Off"}</dd>
            </div>
            {d.restoredTo && (
              <div>
                <dt>Restored to</dt>
                <dd>{formatDateTime(d.restoredTo)}</dd>
              </div>
            )}
            <div>
              <dt>Created</dt>
              <dd>{formatDate(d.createdAt)}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card id="tags" title="Tags" description="Tags group and filter databases across your fleet, for example by customer or environment.">
        <TagEditor db={d} onChanged={db.reload} />
      </Card>

      <Card id="usage" title="Usage over time">
        <div className="chart-controls">
          <div className="seg" role="group" aria-label="Metric">
            {METRICS.map((m) => (
              <button key={m.value} type="button" aria-pressed={metric === m.value} onClick={() => setMetric(m.value)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>
        {usage.status === "loading" && <Message>Loading usage</Message>}
        {usage.status === "error" && <Message role="alert">{usage.message}</Message>}
        {usage.status === "ready" && <UsageChart points={usage.data} metric={metric} range={range} />}
      </Card>

      <Card id="actions" title="Actions">
        <label className="check">
          <input type="checkbox" checked={keepAwake} onChange={(e) => toggleKeepAwake(e.target.checked)} />
          Keep awake
        </label>
        <p className="muted small">A database that is kept awake never sleeps, so its first request is never slow.</p>
        <div className="row-actions">
          <button type="button" className="btn" onClick={() => open("fork")}>
            <GitFork size={16} aria-hidden="true" />
            Fork
          </button>
          <button type="button" className="btn" onClick={() => open("restore")}>
            <History size={16} aria-hidden="true" />
            Restore to a point in time
          </button>
          <button type="button" className="btn" onClick={exportData}>
            <Download size={16} aria-hidden="true" />
            Export
          </button>
          <button type="button" className="btn" onClick={() => open("erase")}>
            <Trash2 size={16} aria-hidden="true" />
            Erase
          </button>
        </div>
      </Card>

      <ConfirmDialog open={dialog === "fork"} title="Fork this database" confirmLabel="Fork and open" busy={busy} onConfirm={fork} onCancel={() => setDialog(null)}>
        <p>Creates an instant copy of {d.name} with the same region and tags, then opens it.</p>
        <div className="field">
          <label htmlFor="fork-name">Name of the copy</label>
          <input id="fork-name" value={field} onChange={(e) => (setField(e.target.value), setError(null))} autoComplete="off" autoFocus />
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </ConfirmDialog>

      <ConfirmDialog open={dialog === "restore"} title="Restore to a point in time" confirmLabel="Restore database" busy={busy} onConfirm={restore} onCancel={() => setDialog(null)}>
        <p>Rolls {d.name} back to the moment you choose. Changes made after that moment are lost.</p>
        <div className="field">
          <label htmlFor="restore-at">Date and time (UTC)</label>
          <input id="restore-at" type="datetime-local" value={field} min={toInput(new Date(d.createdAt))} max={toInput(now)} onChange={(e) => (setField(e.target.value), setError(null))} autoFocus />
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </ConfirmDialog>

      <ConfirmDialog open={dialog === "erase"} title="Erase this database?" confirmLabel="Erase database" busy={busy} confirmDisabled={field !== d.name} onConfirm={erase} onCancel={() => setDialog(null)}>
        <p>This permanently deletes {d.name} and all its data. It cannot be undone.</p>
        <div className="field">
          <label htmlFor="erase-name">Type {d.name} to confirm</label>
          <input id="erase-name" value={field} onChange={(e) => setField(e.target.value)} autoComplete="off" autoFocus />
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </ConfirmDialog>
    </>
  );
}
