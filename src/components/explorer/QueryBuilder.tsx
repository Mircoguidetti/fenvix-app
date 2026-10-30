import { useId, useState } from "react";
import { Play, Plus, X } from "lucide-react";
import { explorer } from "../../data/explorer-client";
import type { CollectionInfo, DocumentItem, Ejson } from "../../data/explorer";
import { ExplorerError } from "../../data/explorer";
import { conditionProblem, filterText, OPERATORS, parseFilter, type Condition, type Match } from "../../lib/queryBuilder";
import { idSummary, jsonError, summary } from "../../lib/ejson";
import { formatCount } from "../../lib/format";
import { Message } from "../PageHeader";
import { Select } from "../Select";
import { message, waking } from "./util";

const NONE: Condition = { field: "", op: "$eq", value: "" };

/**
 * The query builder: rows of field, operator and value, "all of these" or "any of these", a sort and a limit. It
 * writes the same filter the Panels view takes as JSON (and "Show as JSON" shows and edits that filter), so nothing
 * here asks the engine for more than the Panels view does.
 */
export function QueryBuilder({ dbId, collections, initial, onWaking }: { dbId: string; collections: CollectionInfo[]; initial: string | null; onWaking: (on: boolean) => void }) {
  const uid = useId();
  const [collection, setCollection] = useState(initial ?? collections.find((c) => c.browsable)?.name ?? "");
  const [match, setMatch] = useState<Match>("all");
  const [rows, setRows] = useState<Condition[]>([{ ...NONE }]);
  const [asJson, setAsJson] = useState(false);
  const [json, setJson] = useState("");
  const [jsonNote, setJsonNote] = useState<string | null>(null);
  const [sortField, setSortField] = useState("");
  const [order, setOrder] = useState<"1" | "-1">("1");
  const [limit, setLimit] = useState("50");
  const [errors, setErrors] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<{ items: DocumentItem[]; hasMore: boolean; ms: number } | null>(null);

  function openJson() {
    setJson(filterText(rows, match));
    setJsonNote(null);
    setAsJson(true);
  }
  function closeJson() {
    const parsed = parseFilter(json);
    if (!parsed) {
      const problem = jsonError(json, "The filter");
      return setJsonNote(problem ?? "This filter has more in it than the rows can show, so it stays as JSON.");
    }
    setRows(parsed.conditions.length ? parsed.conditions : [{ ...NONE }]);
    setMatch(parsed.match);
    setAsJson(false);
    setJsonNote(null);
  }

  async function run() {
    const used = rows.filter((r) => r.field.trim() || r.value.trim());
    const found = asJson ? [] : used.map((r, i) => conditionProblem(r) && `Condition ${i + 1}: ${conditionProblem(r)}`).filter((x): x is string => !!x);
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) found.push("The limit is a whole number from 1 to 100.");
    if (sortField.trim().startsWith("$")) found.push('A field name cannot start with "$".');
    if (asJson) {
      const p = jsonError(json, "The filter");
      if (p) found.push(p);
    }
    setErrors(found);
    if (found.length || !collection) return;
    setRunning(true);
    setRunError(null);
    const started = performance.now();
    try {
      const r = await waking(
        () =>
          explorer.findDocuments(dbId, collection, {
            filter: asJson ? json : filterText(used, match),
            sort: sortField.trim() ? JSON.stringify({ [sortField.trim()]: Number(order) }) : "",
            page: 1,
            pageSize: n,
          }),
        onWaking,
      );
      setResult({ items: r.items, hasMore: r.hasMore, ms: Math.max(1, Math.round(performance.now() - started)) });
    } catch (e) {
      setResult(null);
      setRunError(e instanceof ExplorerError && e.status === 400 ? e.message : message(e));
    } finally {
      setRunning(false);
    }
  }

  function clear() {
    setRows([{ ...NONE }]);
    setMatch("all");
    setJson("");
    setSortField("");
    setOrder("1");
    setLimit("50");
    setErrors([]);
    setResult(null);
    setRunError(null);
    setJsonNote(null);
  }

  const set = (i: number, patch: Partial<Condition>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const op = (c: Condition) => OPERATORS.find((o) => o.value === c.op)!;

  // Columns: _id, then the fields of the first documents (at most five more).
  const columns: string[] = [];
  for (const it of result?.items ?? []) for (const k of Object.keys(it.document ?? {})) if (k !== "_id" && !columns.includes(k) && columns.length < 5) columns.push(k);

  return (
    <div className="qb">
      <div className="qb-bar">
        <button type="button" className="btn btn-sm" aria-pressed={asJson} onClick={() => (asJson ? closeJson() : openJson())}>
          {asJson ? "Show as rows" : "Show as JSON"}
        </button>
      </div>
      <section className="qb-card card" aria-label="Query">
        <div className="field qb-collection">
          <label htmlFor={`${uid}-c`}>Collection</label>
          <Select id={`${uid}-c`} className="mono" value={collection} onChange={setCollection} options={collections.map((c) => ({ value: c.name, label: c.name, disabled: !c.browsable }))} />
        </div>

        <div className="qb-where">
          <div className="qb-where-head">
            <span className="qb-title">Where</span>
            {!asJson && (
              <div className="seg" role="group" aria-label="Match">
                <button type="button" aria-pressed={match === "all"} onClick={() => setMatch("all")}>
                  All of these
                </button>
                <button type="button" aria-pressed={match === "any"} onClick={() => setMatch("any")}>
                  Any of these
                </button>
              </div>
            )}
          </div>
          {asJson ? (
            <div className="field">
              <label htmlFor={`${uid}-j`}>Filter as JSON</label>
              <textarea id={`${uid}-j`} className="code" rows={5} value={json} onChange={(e) => (setJson(e.target.value), setJsonNote(null))} placeholder='{"status": "paid"}' spellCheck={false} autoCapitalize="none" />
              <p className="help">Allowed: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $and, $or, $not, $exists, $regex.</p>
              {jsonNote && (
                <p className="error" role="alert">
                  {jsonNote}
                </p>
              )}
            </div>
          ) : (
            <>
              {rows.map((c, i) => (
                <div className="qb-row" key={i} role="group" aria-label={`Condition ${i + 1}`}>
                  <input className="mono" aria-label="Field" value={c.field} onChange={(e) => set(i, { field: e.target.value })} placeholder="status" autoComplete="off" autoCapitalize="none" spellCheck={false} />
                  <Select aria-label="Operator" value={c.op} onChange={(v) => set(i, { op: v as Condition["op"] })} options={OPERATORS.map((o) => ({ value: o.value, label: o.label }))} />
                  {op(c).takes === "none" ? (
                    <span className="qb-novalue" aria-hidden="true" />
                  ) : (
                    <input className="mono" aria-label="Value" value={c.value} onChange={(e) => set(i, { value: e.target.value })} placeholder={op(c).takes === "list" ? '"paid", "open"' : op(c).takes === "text" ? "^ab" : '"paid" or 10'} autoComplete="off" autoCapitalize="none" spellCheck={false} />
                  )}
                  <button type="button" className="icon-btn qb-remove" aria-label="Remove condition" onClick={() => setRows((r) => (r.length > 1 ? r.filter((_, j) => j !== i) : [{ ...NONE }]))}>
                    <X size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              ))}
              <button type="button" className="btn btn-quiet qb-add" onClick={() => setRows((r) => [...r, { ...NONE }])}>
                <Plus size={15} strokeWidth={2.25} aria-hidden="true" />
                Add condition
              </button>
              <p className="help">Text in quotes is a string; 10 and true are a number and a boolean.</p>
            </>
          )}
        </div>

        <div className="qb-foot">
          <div className="field qb-sort">
            <label htmlFor={`${uid}-s`}>Sort by</label>
            <input id={`${uid}-s`} className="mono" value={sortField} onChange={(e) => setSortField(e.target.value)} placeholder="createdAt" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </div>
          <div className="field qb-order">
            <label htmlFor={`${uid}-o`}>Order</label>
            <Select id={`${uid}-o`} value={order} onChange={(v) => setOrder(v as "1" | "-1")} options={[{ value: "1", label: "Ascending" }, { value: "-1", label: "Descending" }]} />
          </div>
          <div className="field qb-limit">
            <label htmlFor={`${uid}-l`}>Limit</label>
            <input id={`${uid}-l`} className="mono" value={limit} inputMode="numeric" onChange={(e) => setLimit(e.target.value)} autoComplete="off" />
          </div>
          <div className="qb-actions">
            <button type="button" className="btn btn-quiet" onClick={clear}>
              Clear
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={running || !collection}>
              <Play size={14} fill="currentColor" aria-hidden="true" />
              {running ? "Running" : "Run query"}
            </button>
          </div>
        </div>
        {errors.length > 0 && (
          <ul className="error-list" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </section>

      {runError && <Message role="alert">{runError}</Message>}
      {result && (
        <section className="qb-results" aria-label="Results">
          <div className="qb-results-head">
            <h2>Results</h2>
            <span className="small faint">
              {formatCount(result.items.length)} {result.items.length === 1 ? "document" : "documents"}, {result.ms} ms{result.hasMore ? ". More match: raise the limit." : ""}
            </span>
          </div>
          {result.items.length === 0 ? (
            <p className="muted qb-empty">No document matches.</p>
          ) : (
            <table className="data responsive qb-table">
              <caption className="sr-only">Query results</caption>
              <thead>
                <tr>
                  <th scope="col">_id</th>
                  {columns.map((c) => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.items.map((it, i) => (
                  <tr key={it.id || i}>
                    <td data-label="_id" className="mono">
                      {idSummary(it.id, 32)}
                    </td>
                    {columns.map((c) => (
                      <td key={c} data-label={c} className="mono">
                        {it.document && c in it.document ? summary(it.document[c] as Ejson, 48) : ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
