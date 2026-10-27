import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from "lucide-react";
import { client, type UsageQuery, type UsageSort } from "../data";
import { Message, PageHeader } from "../components/PageHeader";
import { Pagination } from "../components/Pagination";
import { TagChips } from "../components/Tags";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { download } from "../lib/download";
import { formatCount } from "../lib/format";

const PAGE_SIZE = 50;

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const gb = (n: number) => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n)} GB`;

const COLUMNS: { key: UsageSort; label: string; num?: boolean; tagOnly?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "databases", label: "Databases", num: true, tagOnly: true },
  { key: "storageGb", label: "Storage (avg)", num: true },
  { key: "requests", label: "Requests", num: true },
];

export function UsagePage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const months = useAsync(() => client.listUsageMonths(), []);
  const tags = useAsync(() => client.listTags(), []);
  const tagKeys = useMemo(() => (tags.status === "ready" ? [...new Set(tags.data.map((t) => t.key))] : []), [tags]);

  const by = params.get("by") === "tag" ? "tag" : "database";
  const tagKey = params.get("key") ?? "";
  const sort = (params.get("sort") ?? "requests") as UsageSort;
  const dir = params.get("dir") === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const month = params.get("month") ?? (months.status === "ready" ? months.data[0] : "");

  const update = (changes: Record<string, string | null>, keepPage = false) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) v ? next.set(k, v) : next.delete(k);
        if (!keepPage) next.delete("page");
        return next;
      },
      { replace: true },
    );

  const query: UsageQuery = { month, by, tagKey: by === "tag" && tagKey ? tagKey : undefined, sort, dir, page, pageSize: PAGE_SIZE };
  const report = useAsync(() => (month ? client.getUsageReport(query) : new Promise<never>(() => {})), [month, by, tagKey, sort, dir, page]);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    // A column that does not exist in this view falls back to the default sort.
    if (by === "database" && sort === "databases") update({ sort: null, dir: null });
  }, [by, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  async function exportCsv() {
    setExporting(true);
    try {
      const file = await client.exportUsageReport({ ...query, page: undefined, pageSize: undefined });
      download(file);
      toast(`CSV ready: ${file.filename}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  const columns = COLUMNS.filter((c) => !c.tagOnly || by === "tag");
  const toggleSort = (key: UsageSort) => update({ sort: key, dir: sort === key ? (dir === "asc" ? "desc" : "asc") : key === "name" ? "asc" : "desc" });

  return (
    <>
      <PageHeader
        title="Usage"
        description="Storage and requests for a month, per database or per tag. Export the table as CSV to bill your own customers."
        actions={
          <button type="button" className="btn" onClick={exportCsv} disabled={exporting || !month}>
            <Download size={16} aria-hidden="true" />
            Export CSV
          </button>
        }
      />

      <div className="toolbar">
        <div className="field">
          <label htmlFor="u-month">Month</label>
          <select id="u-month" value={month} onChange={(e) => update({ month: e.target.value })}>
            {months.status === "ready" && months.data.map((m, i) => (
              <option key={m} value={m}>
                {monthLabel(m)}
                {i === 0 ? " (to date)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="label" id="u-by-label">
            Show
          </span>
          <div className="seg" role="group" aria-labelledby="u-by-label">
            <button type="button" aria-pressed={by === "database"} onClick={() => update({ by: null })}>
              Per database
            </button>
            <button type="button" aria-pressed={by === "tag"} onClick={() => update({ by: "tag" })}>
              Per tag
            </button>
          </div>
        </div>
        {by === "tag" && (
          <div className="field">
            <label htmlFor="u-key">Tag key</label>
            <select id="u-key" value={tagKey} onChange={(e) => update({ key: e.target.value || null })}>
              <option value="">All tags</option>
              {tagKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="u-sort">Sort by</label>
          <select id="u-sort" value={`${sort}:${dir}`} onChange={(e) => { const [s, d] = e.target.value.split(":"); update({ sort: s, dir: d }); }}>
            {columns.flatMap((c) => [
              <option key={`${c.key}:asc`} value={`${c.key}:asc`}>{`${c.label}, ${c.key === "name" ? "A to Z" : "low to high"}`}</option>,
              <option key={`${c.key}:desc`} value={`${c.key}:desc`}>{`${c.label}, ${c.key === "name" ? "Z to A" : "high to low"}`}</option>,
            ])}
          </select>
        </div>
      </div>

      {report.status === "loading" && <Message>Loading usage</Message>}
      {report.status === "error" && <Message role="alert">{report.message}</Message>}
      {report.status === "ready" && (
        <>
          <div className="stats">
            <div className="stat card">
              <span className="muted">Databases</span>
              <strong className="mono stat-value">{formatCount(report.data.totals.databases)}</strong>
              <span className="muted small">{monthLabel(report.data.month)}</span>
            </div>
            <div className="stat card">
              <span className="muted">Storage (average)</span>
              <strong className="mono stat-value">{gb(report.data.totals.storageGb)}</strong>
              <span className="muted small">All databases</span>
            </div>
            <div className="stat card">
              <span className="muted">Requests</span>
              <strong className="mono stat-value">{formatCount(report.data.totals.requests)}</strong>
              <span className="muted small">All databases</span>
            </div>
          </div>

          <div className="table-card">
            <table className="data responsive">
              <caption className="sr-only">Usage {by === "database" ? "per database" : "per tag"} for {monthLabel(report.data.month)}</caption>
              <thead>
                <tr>
                  {columns.map((c) => {
                    const active = sort === c.key;
                    return (
                      <th key={c.key} scope="col" className={c.num ? "num" : undefined} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" className="th-btn" onClick={() => toggleSort(c.key)}>
                          {c.label}
                          {active ? dir === "asc" ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" /> : <ArrowUpDown size={14} aria-hidden="true" className="faint" />}
                        </button>
                      </th>
                    );
                  })}
                  {by === "database" && <th scope="col">Tags</th>}
                </tr>
              </thead>
              <tbody>
                {report.data.items.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Name">{by === "database" ? <Link to={`/databases/${r.id}`} className="row-link mono">{r.name}</Link> : <span className="mono">{r.name}</span>}</td>
                    {by === "tag" && <td data-label="Databases" className="num mono">{formatCount(r.databases)}</td>}
                    <td data-label="Storage (avg)" className="num mono">{gb(r.storageGb)}</td>
                    <td data-label="Requests" className="num mono">{formatCount(r.requests)}</td>
                    {by === "database" && <td data-label="Tags"><TagChips tags={r.tags} max={2} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={report.data.page} pageSize={report.data.pageSize} total={report.data.total} onPage={(p) => update({ page: p === 1 ? null : String(p) }, true)} />
        </>
      )}
    </>
  );
}
