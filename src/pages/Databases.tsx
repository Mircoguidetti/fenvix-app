import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { client, type Database } from "../data";
import { PageHeader, Message } from "../components/PageHeader";
import { StateBadge } from "../components/StateBadge";
import { useAsync } from "../lib/useAsync";
import { formatCount, formatRelative, formatStorage } from "../lib/format";

type SortKey = "name" | "state" | "storageMb" | "requests24h" | "lastActiveAt";
type Dir = "asc" | "desc";
type StateFilter = "all" | "awake" | "asleep";

const COLUMNS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "state", label: "State" },
  { key: "storageMb", label: "Storage", num: true },
  { key: "requests24h", label: "Requests (24 h)", num: true },
  { key: "lastActiveAt", label: "Last active" },
];

const SORT_OPTIONS = COLUMNS.flatMap((c) => [
  { value: `${c.key}:asc`, label: `${c.label}, ${c.key === "name" || c.key === "state" ? "A to Z" : "low to high"}` },
  { value: `${c.key}:desc`, label: `${c.label}, ${c.key === "name" || c.key === "state" ? "Z to A" : "high to low"}` },
]);

function compare(a: Database, b: Database, key: SortKey): number {
  if (key === "name" || key === "state") return a[key].localeCompare(b[key]);
  if (key === "lastActiveAt") return new Date(a.lastActiveAt).getTime() - new Date(b.lastActiveAt).getTime();
  return a[key] - b[key];
}

export function DatabasesPage() {
  const data = useAsync(() => client.listDatabases(), []);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: "lastActiveAt", dir: "desc" });

  const rows = useMemo(() => {
    if (data.status !== "ready") return [];
    const q = query.trim().toLowerCase();
    return data.data
      .filter((d) => (stateFilter === "all" || d.state === stateFilter) && (!q || d.name.toLowerCase().includes(q)))
      .sort((a, b) => (sort.dir === "asc" ? 1 : -1) * compare(a, b, sort.key) || a.name.localeCompare(b.name));
  }, [data, query, stateFilter, sort]);

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" || key === "state" ? "asc" : "desc" }));
  const now = client.now();

  return (
    <>
      <PageHeader title="Databases" description="Every database sleeps when idle. Open one for its connection string and usage." />

      <div className="toolbar">
        <div className="field grow">
          <label htmlFor="db-search">Search by name</label>
          <div className="input-wrap">
            <Search size={16} aria-hidden="true" />
            <input id="db-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search databases" autoComplete="off" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="db-state">State</label>
          <select id="db-state" value={stateFilter} onChange={(e) => setStateFilter(e.target.value as StateFilter)}>
            <option value="all">All states</option>
            <option value="awake">Awake</option>
            <option value="asleep">Asleep</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="db-sort">Sort by</label>
          <select id="db-sort" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(":"); setSort({ key: key as SortKey, dir: dir as Dir }); }}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {data.status === "loading" && <Message>Loading databases</Message>}
      {data.status === "error" && <Message role="alert">{data.message}</Message>}
      {data.status === "ready" && (
        <>
          <p className="muted result-count" role="status">
            {rows.length} of {data.data.length} databases
          </p>
          {rows.length === 0 ? (
            <div className="empty">
              <p>No databases match these filters.</p>
              <button type="button" className="btn" onClick={() => { setQuery(""); setStateFilter("all"); }}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className="table-card">
              <table className="data responsive">
                <caption className="sr-only">Databases</caption>
                <thead>
                  <tr>
                    {COLUMNS.map((c) => {
                      const active = sort.key === c.key;
                      return (
                        <th key={c.key} scope="col" className={c.num ? "num" : undefined} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                          <button type="button" className="th-btn" onClick={() => toggleSort(c.key)}>
                            {c.label}
                            {active ? sort.dir === "asc" ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" /> : <ArrowUpDown size={14} aria-hidden="true" className="faint" />}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <td data-label="Name">
                        <Link to={`/databases/${d.id}`} className="row-link mono">
                          {d.name}
                        </Link>
                      </td>
                      <td data-label="State">
                        <StateBadge state={d.state} />
                      </td>
                      <td data-label="Storage" className="num mono">
                        {formatStorage(d.storageMb)}
                      </td>
                      <td data-label="Requests (24 h)" className="num mono">
                        {formatCount(d.requests24h)}
                      </td>
                      <td data-label="Last active" className="muted">
                        {formatRelative(d.lastActiveAt, now)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
