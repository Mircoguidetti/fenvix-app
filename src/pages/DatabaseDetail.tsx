import { useEffect, useState } from "react";
import { useOrg } from "../session/OrgProvider";
import { TagChips } from "../components/Tags";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Download, GitFork, History, Trash2 } from "lucide-react";
import { client, type UsageRange } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyButton } from "../components/CopyButton";
import { StateBadge } from "../components/StateBadge";
import { TagEditor } from "../components/TagEditor";
import { AreaSeriesChart, TimeBarsChart, WakeTimeline } from "../components/charts";
import { useToast } from "../components/Toast";
import { DataExplorer } from "../components/DataExplorer";
import { DatabaseUsers } from "../components/DatabaseUsers";
import { DatabaseNetwork } from "../components/DatabaseNetwork";
import { PasswordDialog } from "../components/PasswordOnce";
import { connectionParts } from "../data/connection";
import { useAsync } from "../lib/useAsync";
import { download } from "../lib/download";
import { formatCount, formatDate, formatDateTime, formatRelative, formatStorage } from "../lib/format";

const RANGES: { value: UsageRange; label: string }[] = [
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
];

type Dialog = "fork" | "restore" | "erase" | null;

/** One unit for the whole axis, so it never mixes MB and GB. */
const storageAxis = (max: number) => (max >= 1024 ? (n: number) => `${(n / 1024).toFixed(1)} GB` : (n: number) => `${Math.round(n)} MB`);

/** `YYYY-MM-DDTHH:mm` in UTC, the format a datetime-local input wants. */
const toInput = (d: Date) => d.toISOString().slice(0, 16);

export function DatabaseDetailPage() {
  const { id = "" } = useParams();
  return <DatabaseDetail key={id} id={id} />;
}

function DatabaseDetail({ id }: { id: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { canManage } = useOrg();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab = tabParam === "data" || tabParam === "users" || tabParam === "network" ? tabParam : "overview";
  const db = useAsync(() => client.getDatabase(id), [id]);
  const [range, setRange] = useState<UsageRange>("7d");
  const usage = useAsync(() => client.getUsage(id, range), [id, range]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [field, setField] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keepLocal, setKeepLocal] = useState<boolean | null>(null);
  /** The fork's first user and its password, shown once before the fork is opened; never kept after. */
  const [forked, setForked] = useState<{ id: string; username: string; password: string; connectionString: string | null } | null>(null);
  const loadedKeep = db.status === "ready" ? db.data?.keepAwake : undefined;
  useEffect(() => setKeepLocal(null), [loadedKeep]);

  const back = (
    <Link to="/databases" className="back-link">
      <ArrowLeft size={16} aria-hidden="true" />
      All databases
    </Link>
  );

  if (db.status === "loading") return <><PageHeader title="Database" back={back} /><Message>Loading database</Message></>;
  if (db.status === "error") return <><PageHeader title="Database" back={back} /><Message role="alert">{db.message}</Message></>;
  if (!db.data)
    return (
      <>
        <PageHeader title="Database not found" back={back} description="It may have been erased, or the link may be wrong." />
        <div className="empty">
          <h2>Nothing here</h2>
          <p className="muted">No database with this id is in this workspace.</p>
          <Link to="/databases" className="btn">
            Back to all databases
          </Link>
        </div>
      </>
    );

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
      const first = copy.initialUser;
      if (first?.password) setForked({ id: copy.id, username: first.username, password: first.password, connectionString: first.connectionString });
      else navigate(`/databases/${copy.id}`);
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
      navigate("/databases");
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

  const conn = connectionParts(d.connectionString);
  const connUser = /^mongodb:\/\/([^:@/]+):/.exec(d.connectionString)?.[1] ?? "";

  return (
    <>
      <PageHeader
        title={<span className="mono">{d.name}</span>}
        back={back}
        actions={
          <div className="header-facts">
            <StateBadge state={d.state} />
            <span className="muted">{d.region}</span>
          </div>
        }
      />

      <div className="seg detail-tabs" role="group" aria-label="Database sections">
        <button type="button" aria-pressed={tab === "overview"} onClick={() => setParams({}, { replace: true })}>
          Overview
        </button>
        <button type="button" aria-pressed={tab === "data"} onClick={() => setParams({ tab: "data" }, { replace: true })}>
          Data
        </button>
        <button type="button" aria-pressed={tab === "users"} onClick={() => setParams({ tab: "users" }, { replace: true })}>
          Users
        </button>
        <button type="button" aria-pressed={tab === "network"} onClick={() => setParams({ tab: "network" }, { replace: true })}>
          Network
        </button>
      </div>

      {tab === "data" && <DataExplorer db={d} />}
      {tab === "users" && <DatabaseUsers db={d} />}
      {tab === "network" && <DatabaseNetwork db={d} />}

      {tab === "overview" && (
        <>
          <div className="grid-2 even">
            <Card id="conn" title="Connection string" description="Point any MongoDB driver at this. Replace <password> with the user's password: it was shown once when the user was made. Lost it? Reset it in Users.">
              <label htmlFor="conn-string" className="sr-only">
                Connection string
              </label>
              <textarea id="conn-string" className="code" readOnly rows={3} value={d.connectionString} onFocus={(e) => e.currentTarget.select()} />
              <div className="row-actions">
                <CopyButton value={d.connectionString} what="connection string" />
                <button type="button" className="btn" onClick={() => setParams({ tab: "users" }, { replace: true })}>
                  {canManage ? "Manage users" : "View users"}
                </button>
              </div>
              <dl className="facts facts-tight">
                <div>
                  <dt>Host</dt>
                  <dd className="mono ellipsis" title={d.host}>
                    {d.host}
                  </dd>
                </div>
                <div>
                  <dt>Port</dt>
                  <dd className="mono">{conn.port}</dd>
                </div>
                <div>
                  <dt>Database</dt>
                  <dd className="mono ellipsis" title={conn.database}>
                    {conn.database}
                  </dd>
                </div>
                <div>
                  <dt>User</dt>
                  <dd className="mono ellipsis">{connUser === "<username>" ? "None yet" : connUser}</dd>
                </div>
                <div>
                  <dt>TLS</dt>
                  <dd>Required</dd>
                </div>
              </dl>
            </Card>

            <Card id="status" title="Status" description="What this database is doing and what it holds.">
              <dl className="facts facts-fill">
                <div>
                  <dt>State</dt>
                  <dd>
                    <StateBadge state={d.state} />
                  </dd>
                </div>
                <div>
                  <dt>Keep awake</dt>
                  <dd>{keepAwake ? "On" : "Off"}</dd>
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
                  <dt>Created</dt>
                  <dd>{formatDate(d.createdAt)}</dd>
                </div>
                {d.forkedFrom && (
                  <div>
                    <dt>Forked from</dt>
                    <dd>
                      <Link to={`/databases/${d.forkedFrom}`} className="row-link mono">
                        {d.forkedFrom}
                      </Link>
                    </dd>
                  </div>
                )}
                {d.restoredTo && (
                  <div>
                    <dt>Restored to</dt>
                    <dd>{formatDateTime(d.restoredTo)}</dd>
                  </div>
                )}
              </dl>
            </Card>
          </div>

          <Card id="tags" title="Tags" description="Tags group and filter databases across the fleet, for example by customer or environment.">
            {canManage ? (
              <TagEditor db={d} onChanged={db.reload} />
            ) : d.tags.length === 0 ? (
              <p className="muted">This database has no tags yet.</p>
            ) : (
              <TagChips tags={d.tags} max={d.tags.length} />
            )}
          </Card>

          <Card
            id="usage"
            title="Activity"
            description="Requests, storage and the hours this database was awake."
            actions={
              <div className="seg seg-sm" role="group" aria-label="Time range">
                {RANGES.map((r) => (
                  <button key={r.value} type="button" aria-pressed={range === r.value} onClick={() => setRange(r.value)}>
                    {r.label}
                  </button>
                ))}
              </div>
            }
          >
            {usage.status === "loading" && <Message>Loading activity</Message>}
            {usage.status === "error" && <Message role="alert">{usage.message}</Message>}
            {usage.status === "ready" && (
              <div className="stack wide">
                <div className="chart-pair">
                  <section aria-labelledby="chart-requests">
                    <h3 id="chart-requests" className="chart-title">
                      Requests
                    </h3>
                    <TimeBarsChart points={usage.data.map((p) => ({ at: p.at, value: p.requests }))} range={range} valueLabel={(n) => `${formatCount(n)} requests`} bucketNoun={range === "7d" ? "six-hour window" : undefined} />
                  </section>
                  <section aria-labelledby="chart-storage">
                    <h3 id="chart-storage" className="chart-title">
                      Storage
                    </h3>
                    <AreaSeriesChart points={usage.data.map((p) => ({ at: p.at, value: p.storageMb }))} range={range} valueLabel={formatStorage} axisLabel={storageAxis(Math.max(...usage.data.map((p) => p.storageMb)))} />
                  </section>
                </div>
                <section aria-labelledby="chart-timeline">
                  <h3 id="chart-timeline" className="chart-title">
                    Awake and asleep
                  </h3>
                  <WakeTimeline points={usage.data} range={range} />
                </section>
              </div>
            )}
          </Card>

          <Card id="actions" title="Actions" description={canManage ? "Everything you can do to this database from here." : "Only an owner or admin can change this database."}>
            {canManage && (<>
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
              <button type="button" className="btn btn-danger" onClick={() => open("erase")}>
                <Trash2 size={16} aria-hidden="true" />
                Erase
              </button>
            </div>
            </>)}
            {!canManage && <Message>You have view-only access: keep awake, fork, restore, export and erase are for owners and admins.</Message>}
          </Card>
        </>
      )}

      <PasswordDialog
        title="Save the fork's database user"
        secret={forked}
        onClose={() => {
          const id = forked?.id;
          setForked(null);
          if (id) navigate(`/databases/${id}`);
        }}
      />

      <ConfirmDialog open={dialog === "fork"} title="Fork this database" confirmLabel="Fork and open" busy={busy} onConfirm={fork} onCancel={() => setDialog(null)}>
        <p>Creates an instant copy of {d.name} with the same region and tags, then opens it.</p>
        <div className="field">
          <label htmlFor="fork-name">Name of the copy</label>
          <input id="fork-name" value={field} onChange={(e) => (setField(e.target.value), setError(null))} autoComplete="off" autoFocus />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog open={dialog === "restore"} title="Restore to a point in time" confirmLabel="Restore database" busy={busy} onConfirm={restore} onCancel={() => setDialog(null)}>
        <p>Rolls {d.name} back to the moment you choose. Changes made after that moment are lost.</p>
        <div className="field">
          <label htmlFor="restore-at">Date and time (UTC)</label>
          <input id="restore-at" type="datetime-local" value={field} min={toInput(new Date(d.createdAt))} max={toInput(now)} onChange={(e) => (setField(e.target.value), setError(null))} autoFocus />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog open={dialog === "erase"} title="Erase this database?" confirmLabel="Erase database" busy={busy} confirmDisabled={field !== d.name} onConfirm={erase} onCancel={() => setDialog(null)}>
        <p>
          This permanently deletes {d.name}, its forks and its history. It cannot be undone.
        </p>
        <div className="field">
          <label htmlFor="erase-name">Type {d.name} to confirm</label>
          <input id="erase-name" value={field} onChange={(e) => setField(e.target.value)} autoComplete="off" autoFocus />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}
