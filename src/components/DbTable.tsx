import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { client, type Database, type DatabaseSort } from "../data";
import { StateBadge } from "./StateBadge";
import { TagChips } from "./Tags";
import { formatCount, formatRelative, formatStorage } from "../lib/format";

export type Dir = "asc" | "desc";

export const COLUMNS: { key: DatabaseSort; label: string; num?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "state", label: "State" },
  { key: "keepAwake", label: "Keep awake" },
  { key: "storageMb", label: "Storage", num: true },
  { key: "requests24h", label: "Requests (24 h)", num: true },
  { key: "lastActiveAt", label: "Last active" },
];

const TEXT_SORT: DatabaseSort[] = ["name", "state", "keepAwake"];
export const isTextSort = (key: DatabaseSort) => TEXT_SORT.includes(key);

function Check({ label, checked, indeterminate, onChange }: { label: string; checked: boolean; indeterminate?: boolean; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <label className="select-hit">
      <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </label>
  );
}

function Head({ col, sort, onSort }: { col: (typeof COLUMNS)[number]; sort?: { key: DatabaseSort; dir: Dir }; onSort?: (key: DatabaseSort) => void }) {
  const active = sort?.key === col.key;
  return (
    <th scope="col" className={col.num ? "num" : undefined} aria-sort={sort ? (active ? (sort.dir === "asc" ? "ascending" : "descending") : "none") : undefined}>
      {onSort ? (
        <button type="button" className="th-btn" onClick={() => onSort(col.key)}>
          {col.label}
          {active ? sort.dir === "asc" ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" /> : <ArrowUpDown size={14} aria-hidden="true" className="faint" />}
        </button>
      ) : (
        col.label
      )}
    </th>
  );
}

/** Databases as a table on wide screens and as stacked rows on phones. Every row is the same height. */
export function DbTable({
  items,
  selected,
  onToggle,
  sort,
  onSort,
  onPickTag,
  caption,
  selectable = true,
}: {
  items: Database[];
  /** False for a member: nothing can be done to a selection, so there is none. */
  selectable?: boolean;
  selected: Set<string>;
  onToggle: (ids: string[], on: boolean) => void;
  sort?: { key: DatabaseSort; dir: Dir };
  onSort?: (key: DatabaseSort) => void;
  onPickTag?: (tag: string) => void;
  caption: string;
}) {
  const now = client.now();
  const ids = items.map((d) => d.id);
  const picked = ids.filter((id) => selected.has(id)).length;
  return (
    <div className="table-card">
      {selectable && (
        <div className="select-all-mobile">
          <Check label="Select all on this page" checked={picked > 0 && picked === ids.length} indeterminate={picked > 0 && picked < ids.length} onChange={(on) => onToggle(ids, on)} />
          <span aria-hidden="true">Select all on this page</span>
        </div>
      )}
      <table className="data responsive dbs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {selectable && (
              <th scope="col" className="select-col">
                <Check label="Select all on this page" checked={picked > 0 && picked === ids.length} indeterminate={picked > 0 && picked < ids.length} onChange={(on) => onToggle(ids, on)} />
              </th>
            )}
            <Head col={COLUMNS[0]} sort={sort} onSort={onSort} />
            <th scope="col">Tags</th>
            {COLUMNS.filter((c) => c.key !== "name" && c.key !== "keepAwake").map((c) => (
              <Head key={c.key} col={c} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id} data-selected={selected.has(d.id) || undefined}>
              {selectable && (
                <td className="select-cell">
                  <Check label={`Select ${d.name}`} checked={selected.has(d.id)} onChange={(on) => onToggle([d.id], on)} />
                </td>
              )}
              <td data-label="Name" className="name-cell">
                <Link to={`/databases/${d.id}`} className="row-link mono">
                  {d.name}
                </Link>
              </td>
              <td data-label="Tags" className="tags-cell">
                <TagChips tags={d.tags} max={2} onPick={onPickTag} />
              </td>
              <td data-label="State" className="state-cell">
                <StateBadge state={d.state} />
                {d.keepAwake && <span className="muted small kept">Kept awake</span>}
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
  );
}
