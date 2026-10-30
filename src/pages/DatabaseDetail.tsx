import { useEffect, useState } from "react";
import { useOrg } from "../session/OrgProvider";
import { TagChips } from "../components/Tags";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronRight, Download, GitFork, History, TriangleAlert } from "lucide-react";
import { client, type OperationProgress, type UsageRange } from "../data";
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
import { OperationNote } from "../components/OperationNote";
import { connectionParts } from "../data/connection";
import { useAsync } from "../lib/useAsync";
import { download } from "../lib/download";
import { formatCount, formatDate, formatDateTime, formatRelative, formatStorage } from "../lib/format";
import { DateTimePicker } from "../components/DateTimePicker";
import { Switch } from "../components/Switch";
import { Segmented } from "../components/Segmented";
import { toApiTime } from "../lib/zoned";

const RANGES: { value: UsageRange; label: string }[] = [
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
];

type Dialog = "fork" | "restore" | "erase" | null;

/** One unit for the whole axis, so it never mixes MB and GB. */
const storageAxis = (max: number) => (max >= 1024 ? (n: number) => `${(n / 1024).toFixed(1)} GB` : (n: number) => `${Math.round(n)} MB`);

type Lang = "node" | "python" | "mongosh" | "uri";
const LANGS: { value: Lang; label: string }[] = [
  { value: "node", label: "Node.js" },
  { value: "python", label: "Python" },
  { value: "mongosh", label: "mongosh" },
  { value: "uri", label: "Connection string" },
];
/** The same connection string in the form each client takes it. */
function snippet(lang: Lang, uri: string) {
  if (lang === "node") return `// Node.js\nconst client = new MongoClient(\n  "${uri}"\n);`;
  if (lang === "python") return `# Python\nclient = MongoClient(\n    "${uri}"\n)`;
  if (lang === "mongosh") return `mongosh "${uri}"`;
  return uri;
}

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
  const [lang, setLang] = useState<Lang>("node");
  const [restoreAt, setRestoreAt] = useState<Date>(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Where the running fork, restore, erase or export has got to. */
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [exporting, setExporting] = useState(false);
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
    setField(next === "fork" ? `${d.name}-fork`.slice(0, 48) : "");
    if (next === "restore") setRestoreAt(new Date(Math.max(new Date(d.createdAt).getTime(), now.getTime() - 3600_000)));
    setDialog(next);
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      setDialog(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }
  const track = { onProgress: setProgress };

  const fork = () =>
    run(async () => {
      const copy = await client.forkDatabase(d.id, field, track);
      const first = copy.initialUser;
      // After a long fork (202) the password is not in the answer: say how to get one.
      toast(first && !first.password ? `Forked ${d.name} as ${copy.name}. Its user's password could not be shown: reset it in Users.` : `Forked ${d.name} as ${copy.name}`, "success");
      if (first?.password) setForked({ id: copy.id, username: first.username, password: first.password, connectionString: first.connectionString });
      else navigate(`/databases/${copy.id}`);
    });
  const restore = () =>
    run(async () => {
      const at = toApiTime(restoreAt);
      await client.restoreDatabase(d.id, at, track);
      toast(`Restored ${d.name} to ${formatDateTime(at)}`, "success");
      db.reload();
    });
  const erase = () =>
    run(async () => {
      await client.eraseDatabases([d.id], track);
      toast(`Erased ${d.name}`, "success");
      navigate("/databases");
    });
  async function exportData() {
    setExporting(true);
    try {
      const file = await client.exportDatabases([d.id], track);
      download(file);
      toast(`Export ready: ${file.filename}`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Export failed.", "error");
    } finally {
      setExporting(false);
      setProgress(null);
    }
  }
  async function toggleKeepAwake(on: boolean) {
    setKeepLocal(on);
    try {
      await client.setKeepAwake([d.id], on);
      toast(on ? `${d.name} will stay awake` : `${d.name} can sleep when idle`, "success");
      db.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not change keep awake.", "error");
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
        meta={
          <>
            <StateBadge state={d.state} kept={keepAwake} />
            <span className="mono muted small">{d.region}</span>
          </>
        }
      />

      <div className="tabs" role="group" aria-label="Database sections">
        {(["overview", "data", "users", "network"] as const).map((t) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => setParams(t === "overview" ? {} : { tab: t }, { replace: true })}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "data" && <DataExplorer db={d} />}
      {tab === "users" && <DatabaseUsers db={d} />}
      {tab === "network" && <DatabaseNetwork db={d} />}

      {tab === "overview" && (
        <div className="ov-grid">
          <div className="ov-main">
            <Card id="conn" title="Connect" description="Use any standard MongoDB driver. Replace <password> with the password of your user: it was shown once when the user was made. Lost it? Reset it in Users.">
              <Segmented label="Language" value={lang} onChange={setLang} options={LANGS} />
              <label htmlFor="conn-string" className="sr-only">
                Connection string
              </label>
              <div className="codebox">
                <pre id="conn-string" className="mono" tabIndex={0} aria-label="Connection code">
                  {snippet(lang, d.connectionString)}
                </pre>
                <CopyButton value={snippet(lang, d.connectionString)} what={lang === "uri" ? "connection string" : "code"} />
              </div>
              <p className="help">
                Standard MongoDB drivers work as they are. The connection always uses TLS, on port {conn.port}.{" "}
                <button type="button" className="link-btn" onClick={() => setParams({ tab: "users" }, { replace: true })}>
                  {canManage ? "Manage users" : "View users"}
                </button>
              </p>
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

            <Card id="status" title="Status">
              <dl className="status-facts">
                <div>
                  <dt>State</dt>
                  <dd>
                    <StateBadge state={d.state} kept={keepAwake} />
                  </dd>
                </div>
                <div>
                  <dt>Region</dt>
                  <dd className="mono">{d.region}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatDate(d.createdAt)}</dd>
                </div>
                <div>
                  <dt>Storage</dt>
                  <dd>{formatStorage(d.storageMb)}</dd>
                </div>
                <div>
                  <dt>Requests (24 h)</dt>
                  <dd>{formatCount(d.requests24h)}</dd>
                </div>
                <div>
                  <dt>Last request</dt>
                  <dd title={formatDateTime(d.lastActiveAt)}>{formatRelative(d.lastActiveAt, now)}</dd>
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
              actions={<Segmented label="Time range" value={range} onChange={setRange} options={RANGES} />}
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
          </div>

          <section className="actions-card" id="actions" aria-labelledby="actions-h">
            <h2 id="actions-h">Actions</h2>
            {canManage ? (
              <>
                <div className="action-row">
                  <Switch id="keep-awake" checked={keepAwake} onChange={(on) => void toggleKeepAwake(on)} label="Keep awake" help="Never sleeps. First request is never slow." />
                </div>
                <button type="button" className="action-row action-btn" onClick={() => open("fork")}>
                  <span className="action-text">
                    <span className="action-name">
                      <GitFork size={16} strokeWidth={1.75} aria-hidden="true" /> Fork
                    </span>
                    <span className="help">Make a copy of this database.</span>
                  </span>
                  <ChevronRight size={16} strokeWidth={2} aria-hidden="true" className="action-chev" />
                </button>
                <button type="button" className="action-row action-btn" onClick={() => open("restore")}>
                  <span className="action-text">
                    <span className="action-name">
                      <History size={16} strokeWidth={1.75} aria-hidden="true" /> Restore to a point in time
                    </span>
                    <span className="help">Go back to how it was.</span>
                  </span>
                  <ChevronRight size={16} strokeWidth={2} aria-hidden="true" className="action-chev" />
                </button>
                <button type="button" className="action-row action-btn" onClick={exportData} disabled={exporting}>
                  <span className="action-text">
                    <span className="action-name">
                      <Download size={16} strokeWidth={1.75} aria-hidden="true" /> {exporting ? "Exporting…" : "Export"}
                    </span>
                    <span className="help">Download its data.</span>
                  </span>
                  <ChevronRight size={16} strokeWidth={2} aria-hidden="true" className="action-chev" />
                </button>
                <button type="button" className="action-row action-btn action-erase" onClick={() => open("erase")}>
                  <span className="action-text">
                    <span className="action-name">Erase</span>
                    <span className="help">Deletes all its data and users.</span>
                  </span>
                </button>
                <OperationNote progress={exporting ? progress : null} />
              </>
            ) : (
              <div className="action-row">
                <Message>You have view-only access: keep awake, fork, restore, export and erase are for owners and admins.</Message>
              </div>
            )}
          </section>
        </div>
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
          <OperationNote progress={busy ? progress : null} />
        </div>
      </ConfirmDialog>

      <ConfirmDialog danger open={dialog === "restore"} title="Restore to a point in time" confirmLabel="Restore database" busy={busy} onConfirm={restore} onCancel={() => setDialog(null)}>
        <p>Pick a moment. Fenvix brings {d.name} back to how it was then.</p>
        <p className="once-warning" role="note">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            Changes made after that moment are lost.{" "}
            <button type="button" className="link-btn" onClick={() => open("fork")}>
              Fork this database first
            </button>{" "}
            to keep a copy.
          </span>
        </p>
        {dialog === "restore" && <DateTimePicker value={restoreAt} onChange={(v) => (setRestoreAt(v), setError(null))} min={new Date(d.createdAt)} max={now} minNote={`Earlier days are unavailable because this database was created on ${formatDateTime(d.createdAt)}.`} />}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <OperationNote progress={busy ? progress : null} />
      </ConfirmDialog>

      <ConfirmDialog danger open={dialog === "erase"} title="Erase this database?" confirmLabel="Erase database" busy={busy} confirmDisabled={field !== d.name} onConfirm={erase} onCancel={() => setDialog(null)}>
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
          <OperationNote progress={busy ? progress : null} />
        </div>
      </ConfirmDialog>
    </>
  );
}
