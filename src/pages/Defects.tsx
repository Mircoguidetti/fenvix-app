import { Link, useParams, useSearchParams } from "react-router-dom";
import { client, type Defect } from "../data";
import { Card, Message, PageHeader, Kicker, LoadError } from "../components/PageHeader";
import { CodeBlock, ReplayStatus, causeLabel, causeSentence, shortTest } from "../components/ci";
import { STATE_ICONS, StatusPill } from "../components/StateBadge";
import { Select } from "../components/Select";
import { Segmented } from "../components/Segmented";
import { useAsync } from "../lib/useAsync";
import { formatCount, formatDate, formatRelative } from "../lib/format";
import { bundleDir, pullCommand, replayCommand, setupSnippet } from "../data/ci";
import { useProjectTitle } from "../components/Shell";
import { languageLabel } from "./Projects";

const REASONS: Record<string, string> = {
  "outcome-only": "Same events, different outcome: the cause is state the engine does not observe yet",
  time: "The runs read a different clock value",
  entropy: "The runs read different random bytes from the system",
  thread: "A thread outside the engine's control ran in a different order",
  random: "The runs drew different random numbers",
  fs: "The runs saw a different file",
};

function StatePill({ d }: { d: Defect }) {
  return d.state === "open" ? (
    <StatusPill tone="danger" icon={STATE_ICONS.alert}>
      Open
    </StatusPill>
  ) : (
    <StatusPill tone="ok">Fixed</StatusPill>
  );
}

/** Every defect of the organization, or of one project when `fixedProjectId` is given (the project's Defects section). */
export function DefectsPage({ fixedProjectId }: { fixedProjectId?: string } = {}) {
  const [params, setParams] = useSearchParams();
  const projectId = fixedProjectId ?? params.get("project") ?? "";
  const state = (["fixed", "all"].includes(params.get("state") ?? "") ? params.get("state") : "open") as "open" | "fixed" | "all";
  const projects = useAsync(() => client.listProjects(), []);
  const families = useAsync(() => client.listDefectFamilies({ projectId: projectId || undefined, state }), [projectId, state]);
  const now = client.now();
  const set = (k: string, v: string | null) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  const total = families.status === "ready" ? families.data.reduce((a, f) => a + f.defects.length, 0) : 0;

  return (
    <>
      <PageHeader
        back={<Kicker>{fixedProjectId && projects.status === "ready" ? projects.data.find((p) => p.id === fixedProjectId)?.fullName : undefined}</Kicker>}
        title="Defects"
        description="Flaky tests turned into reproducible defects: the cause named, the smallest order of tests that fails, the seed, and a command that replays the failure 10 times out of 10. Grouped by cause."
      />
      <div className="toolbar">
        {!fixedProjectId && (
        <div className="field">
          <label htmlFor="d-project">Project</label>
          <Select id="d-project" value={projectId} onChange={(v) => set("project", v || null)} options={[{ value: "", label: "All projects" }, ...(projects.status === "ready" ? projects.data.map((p) => ({ value: p.id, label: p.fullName })) : [])]} />
        </div>
        )}
        <div className="field field-seg">
          <span className="label" id="d-state-label">
            State
          </span>
          <Segmented label="State" value={state} onChange={(v) => set("state", v === "open" ? null : v)} options={[{ value: "open", label: "Open" }, { value: "fixed", label: "Fixed" }, { value: "all", label: "All" }]} />
        </div>
      </div>

      {families.status === "loading" && <Message>Loading defects</Message>}
      {families.status === "error" && <LoadError message={families.message} onRetry={families.reload} />}
      {families.status === "ready" && families.data.length === 0 && (
        <div className="empty">
          <h2>No {state === "all" ? "" : `${state} `}defects</h2>
          <p className="muted">When a test fails and passes again on the same code, fenvix searches for the order and seed that make it fail every time, and lists it here.</p>
        </div>
      )}
      {families.status === "ready" && families.data.length > 0 && (
        <>
          <p className="muted small">
            {formatCount(total)} {total === 1 ? "defect" : "defects"} in {formatCount(families.data.length)} {families.data.length === 1 ? "family" : "families"}.
          </p>
          {families.data.map((f) => (
            <Card
              key={`${f.projectId}|${f.key}`}
              title={
                <>
                  {causeLabel(f.cause)}
                  {f.causeTests.length > 0 && (
                    <>
                      : <span className="mono break-anywhere family-cause">{f.causeTests.map(shortTest).join(" + ")}</span>
                    </>
                  )}
                </>
              }
              description={
                <>
                  <span className="mono">{f.projectName}</span> · {f.defects.length} {f.defects.length === 1 ? "defect" : "defects"}
                  {f.causeTests.length > 0 && (
                    <>
                      {" "}
                      · <span className="mono break-anywhere">{f.causeTests.join(" + ")}</span>
                    </>
                  )}
                </>
              }
            >
              <div className="table-card flush">
                <table className="data responsive">
                  <caption className="sr-only">Defects caused by {f.key}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Test</th>
                      <th scope="col">Replays</th>
                      <th scope="col" className="num">
                        Seed
                      </th>
                      <th scope="col" className="num">
                        Order
                      </th>
                      <th scope="col">Last seen</th>
                      <th scope="col">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.defects.map((d) => (
                      <tr key={d.id}>
                        <td data-label="Test">
                          <Link to={`/defects/${d.id}`} className="row-link mono break-anywhere" title={d.testId}>
                            {shortTest(d.testId)}
                          </Link>
                        </td>
                        <td data-label="Replays">
                          <ReplayStatus d={d} />
                        </td>
                        <td data-label="Seed" className="num mono">
                          {d.seed ?? "none"}
                        </td>
                        <td data-label="Order" className="num mono">
                          {d.minimalOrder.length} {d.minimalOrder.length === 1 ? "test" : "tests"}
                        </td>
                        <td data-label="Last seen" className="muted">
                          {formatRelative(d.lastSeenAt, now)}
                        </td>
                        <td data-label="State">
                          <StatePill d={d} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </>
      )}
    </>
  );
}

export function DefectPage() {
  const { id = "" } = useParams();
  const defect = useAsync(() => client.getDefect(id), [id]);
  const now = client.now();
  if (defect.status === "loading") return <Message>Loading defect</Message>;
  if (defect.status === "error") return <LoadError message={defect.message} onRetry={defect.reload} />;
  const d = defect.data;
  if (!d)
    return (
      <div className="empty not-found">
        <h1>Defect not found</h1>
        <Link to="/defects" className="btn btn-primary">
          Back to defects
        </Link>
      </div>
    );
  const node = d.language === "node";
  const replay = `${pullCommand(d)}\n${replayCommand(d)}`;
  return (
    <>
      <PageHeader
        back={
          <Link to="/defects" className="back-link">
            ← Defects
          </Link>
        }
        title={<span className="mono break-anywhere">{shortTest(d.testId)}</span>}
        meta={
          <>
            <ReplayStatus d={d} />
            <StatePill d={d} />
          </>
        }
        description={<span className="mono break-anywhere">{d.testId}</span>}
      />

      <div className="grid-2">
        <Card id="replay" title="Replay it" description={node ? "Pull the defect, then run the test with the seed." : "Pull the defect's bundle, then run the minimal order with the seed. It fails the same way every time."}>
          <CodeBlock code={replay} what="replay command" label="Replay command" />
          {node ? (
            <p className="muted small">The Node engine replays the seed; it does not take an order of tests yet, so the order below is not replayed.</p>
          ) : (
            <p className="muted small">
              The bundle in <span className="mono">{bundleDir(d)}</span> holds <span className="mono">order.txt</span> and the run's traces. <span className="mono">detpy replay {bundleDir(d)}</span> replays it too.
            </p>
          )}
        </Card>
        <Card id="cause" title="Cause" description={causeLabel(d.cause)}>
          <p>{causeSentence(d)}</p>
          <p className="small">
            <span className="mono">{d.exception.type}</span> in {d.exception.phase}: <span className="mono break-anywhere">{d.exception.message}</span>
          </p>
          <p className="muted small mono break-anywhere">{d.exception.location}</p>
          {d.divergence && (
            <p className="small">
              Where the runs part: event {d.divergence.index}. {REASONS[d.divergence.reason] ?? d.divergence.description}.
            </p>
          )}
        </Card>
      </div>

      <Card id="order" title="Minimal failing order" description={`Found with seed ${d.seed ?? "none (collection order)"}, minimised from ${formatCount(d.prefixLength)} tests to ${d.minimalOrder.length}.`}>
        <ol className="order-list">
          {d.minimalOrder.map((t, i) => (
            <li key={t} data-target={t === d.testId || undefined}>
              <span className="mono break-anywhere">{t}</span>
              <span className="muted small">{t === d.testId ? "fails" : d.cause === "polluter" ? "polluter: runs first" : "runs first"}</span>
              <span className="sr-only">position {i + 1}</span>
            </li>
          ))}
        </ol>
      </Card>

      <Card id="facts" title="Details">
        <dl className="facts facts-4">
          <div>
            <dt>Project</dt>
            <dd>
              <Link to={`/projects/${d.projectId}`} className="row-link mono break-anywhere">
                {d.projectName}
              </Link>
            </dd>
          </div>
          <div>
            <dt>Seed</dt>
            <dd className="mono">{d.seed ?? "collection order"}</dd>
          </div>
          <div>
            <dt>Fingerprint</dt>
            <dd>
              <code className="hash mono" title={d.fingerprint ?? undefined}>
                {d.fingerprint ?? "not replayed yet"}
              </code>
            </dd>
          </div>
          <div>
            <dt>Replays</dt>
            <dd>
              {d.replays.fails} of {d.replays.runs} failed, {d.replays.identicalFingerprint ? "identical fingerprint" : "fingerprints differ"}
            </dd>
          </div>
          <div>
            <dt>First seen</dt>
            <dd>
              {d.firstRunId ? (
                <Link to={`/projects/${d.projectId}/runs/${d.firstRunId}`} className="row-link">
                  {formatDate(d.firstSeenAt)}
                </Link>
              ) : (
                formatDate(d.firstSeenAt)
              )}
            </dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>
              {d.lastRunId ? (
                <Link to={`/projects/${d.projectId}/runs/${d.lastRunId}`} className="row-link">
                  {formatRelative(d.lastSeenAt, now)}
                </Link>
              ) : (
                formatRelative(d.lastSeenAt, now)
              )}
            </dd>
          </div>
          <div>
            <dt>Seen in</dt>
            <dd>
              {formatCount(d.occurrences)} {d.occurrences === 1 ? "run" : "runs"}
            </dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd className="mono">{d.engineVersion}</dd>
          </div>
        </dl>
      </Card>
    </>
  );
}

/** The project's Defects section (/projects/:id/defects). */
export function ProjectDefectsPage() {
  const { id = "" } = useParams();
  const project = useAsync(() => client.getProject(id), [id]);
  const p = project.status === "ready" ? project.data : null;
  useProjectTitle(p?.fullName, p ? { language: languageLabel(p.language), runner: p.testRunner, snippet: setupSnippet(p) } : undefined);
  return <DefectsPage fixedProjectId={id} />;
}
