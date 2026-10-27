import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { client, type DatabaseFilter, type DatabaseSort } from "../data";
import { PageHeader, Message } from "../components/PageHeader";
import { DbTable, COLUMNS, isTextSort, type Dir } from "../components/DbTable";
import { BulkBar } from "../components/BulkBar";
import { Pagination } from "../components/Pagination";
import { useAsync } from "../lib/useAsync";
import { parseTag, splitTag } from "../lib/tags";
import { formatCount, formatStorage } from "../lib/format";

const PAGE_SIZE = 50;
const GROUP_PAGE_SIZE = 25;

const SORT_OPTIONS = COLUMNS.flatMap((c) => [
  { value: `${c.key}:asc`, label: `${c.label}, ${isTextSort(c.key) ? "A to Z" : "low to high"}` },
  { value: `${c.key}:desc`, label: `${c.label}, ${isTextSort(c.key) ? "Z to A" : "high to low"}` },
]);

type Selection = { selected: Set<string>; toggle: (ids: string[], on: boolean) => void };

export function DatabasesPage() {
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const stateParam = params.get("state");
  const awakeParam = params.get("keep");
  const tagFilters = params.getAll("tag");
  const groupBy = params.get("group") ?? "";
  const sort = { key: (params.get("sort") ?? "lastActiveAt") as DatabaseSort, dir: (params.get("dir") ?? "desc") as Dir };
  const page = Math.max(1, Number(params.get("page")) || 1);

  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagInput, setTagInput] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);

  const filter: DatabaseFilter = useMemo(
    () => ({
      search: search || undefined,
      state: stateParam === "awake" || stateParam === "asleep" ? stateParam : undefined,
      keepAwake: awakeParam === "on" ? true : awakeParam === "off" ? false : undefined,
      tags: tagFilters.length ? tagFilters : undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, stateParam, awakeParam, tagFilters.join("|")],
  );
  const filterKey = JSON.stringify(filter);
  const filtersActive = !!(search || stateParam || awakeParam || tagFilters.length);

  const tags = useAsync(() => client.listTags(), [version]);
  const tagKeys = useMemo(() => (tags.status === "ready" ? [...new Set(tags.data.map((t) => t.key))] : []), [tags]);

  const update = useCallback(
    (changes: Record<string, string | string[] | null>, keepPage = false) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(changes)) {
            next.delete(k);
            for (const x of Array.isArray(v) ? v : v ? [v] : []) next.append(k, x);
          }
          if (!keepPage) next.delete("page");
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const selection: Selection = useMemo(
    () => ({
      selected,
      toggle: (ids, on) =>
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of ids) on ? next.add(id) : next.delete(id);
          return next;
        }),
    }),
    [selected],
  );

  function addTagFilter() {
    const raw = tagInput.trim().toLowerCase();
    if (!raw) return;
    let value: string;
    if (raw.includes(":")) {
      const parsed = parseTag(raw);
      if ("error" in parsed) return setTagError(parsed.error);
      value = parsed.tag;
    } else if (/^!?[a-z0-9][a-z0-9._-]{0,39}$/.test(raw)) {
      value = raw;
    } else {
      return setTagError("Write key:value, a key, or !key for databases without it.");
    }
    setTagError(null);
    setTagInput("");
    if (!tagFilters.includes(value)) update({ tag: [...tagFilters, value] });
  }

  const reloadAll = () => {
    setSelected(new Set());
    setVersion((v) => v + 1);
  };

  const [matching, setMatching] = useState(0);
  async function selectAllMatching() {
    const ids = await client.listDatabaseIds(filter);
    setSelected(new Set(ids));
  }

  return (
    <>
      <PageHeader
        title="Databases"
        description="Every database sleeps when idle. Tag them, filter by tag, and group by a tag key such as customer."
      />

      <div className="toolbar">
        <div className="field grow">
          <label htmlFor="db-search">Search by name</label>
          <div className="input-wrap">
            <Search size={16} aria-hidden="true" />
            <input id="db-search" type="search" value={search} onChange={(e) => update({ q: e.target.value || null })} placeholder="Search databases" autoComplete="off" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="db-state">State</label>
          <select id="db-state" value={stateParam ?? "all"} onChange={(e) => update({ state: e.target.value === "all" ? null : e.target.value })}>
            <option value="all">All states</option>
            <option value="awake">Awake</option>
            <option value="asleep">Asleep</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="db-keep">Keep awake</label>
          <select id="db-keep" value={awakeParam ?? "all"} onChange={(e) => update({ keep: e.target.value === "all" ? null : e.target.value })}>
            <option value="all">Any</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="db-group">Group by tag</label>
          <select id="db-group" value={groupBy} onChange={(e) => update({ group: e.target.value || null })}>
            <option value="">No grouping</option>
            {tagKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        {!groupBy && (
          <div className="field">
            <label htmlFor="db-sort">Sort by</label>
            <select id="db-sort" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(":"); update({ sort: key, dir }); }}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <form className="toolbar" onSubmit={(e) => (e.preventDefault(), addTagFilter())} noValidate>
        <div className="field grow">
          <label htmlFor="db-tag">Filter by tag</label>
          <input id="db-tag" list="tag-options" value={tagInput} onChange={(e) => (setTagInput(e.target.value), setTagError(null))} placeholder="customer:acme-labs" autoComplete="off" aria-invalid={tagError ? true : undefined} aria-describedby={tagError ? "db-tag-error" : undefined} />
          <datalist id="tag-options">
            {tags.status === "ready" && tags.data.map((t) => <option key={`${t.key}:${t.value}`} value={`${t.key}:${t.value}`} />)}
          </datalist>
        </div>
        <button type="submit" className="btn">
          Add tag filter
        </button>
        {tagError && (
          <p id="db-tag-error" className="error grow-row" role="alert">
            {tagError}
          </p>
        )}
      </form>

      {(tagFilters.length > 0 || filtersActive) && (
        <div className="active-filters">
          {tagFilters.map((t) => (
            <span key={t} className="chip chip-removable">
              {t}
              <button type="button" onClick={() => update({ tag: tagFilters.filter((x) => x !== t) })} aria-label={`Remove tag filter ${t}`}>
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <button type="button" className="btn btn-quiet" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </button>
        </div>
      )}

      {selected.size > 0 && <BulkBar selected={[...selected]} matching={matching} onSelectAll={selectAllMatching} onClear={() => setSelected(new Set())} onDone={reloadAll} />}

      {groupBy ? (
        <Grouped key={`${groupBy}`} groupBy={groupBy} filter={filter} filterKey={filterKey} version={version} selection={selection} setMatching={setMatching} update={update} tagFilters={tagFilters} />
      ) : (
        <Flat filter={filter} filterKey={filterKey} version={version} sort={sort} page={page} selection={selection} setMatching={setMatching} filtersActive={filtersActive} update={update} tagFilters={tagFilters} />
      )}
    </>
  );
}

function Flat({ filter, filterKey, version, sort, page, selection, setMatching, filtersActive, update, tagFilters }: { filter: DatabaseFilter; filterKey: string; version: number; sort: { key: DatabaseSort; dir: Dir }; page: number; selection: Selection; setMatching: (n: number) => void; filtersActive: boolean; update: (c: Record<string, string | string[] | null>, keepPage?: boolean) => void; tagFilters: string[] }) {
  const data = useAsync(() => client.listDatabases({ ...filter, sort: sort.key, dir: sort.dir, page, pageSize: PAGE_SIZE }), [filterKey, sort.key, sort.dir, page, version]);
  useEffect(() => {
    if (data.status === "ready") setMatching(data.data.total);
  }, [data, setMatching]);

  const toggleSort = (key: DatabaseSort) => update({ sort: key, dir: sort.key === key ? (sort.dir === "asc" ? "desc" : "asc") : isTextSort(key) ? "asc" : "desc" });

  if (data.status === "loading") return <Message>Loading databases</Message>;
  if (data.status === "error") return <Message role="alert">{data.message}</Message>;
  const { items, total } = data.data;
  return (
    <>
      <p className="muted result-count" role="status">
        {formatCount(total)} {total === 1 ? "database" : "databases"}
        {filtersActive ? " match these filters" : ""}
      </p>
      {items.length === 0 ? (
        <div className="empty">
          <p>No databases match these filters.</p>
          <button type="button" className="btn" onClick={() => update({ q: null, state: null, keep: null, tag: null })}>
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <DbTable items={items} selected={selection.selected} onToggle={selection.toggle} sort={sort} onSort={toggleSort} onPickTag={(t) => !tagFilters.includes(t) && update({ tag: [...tagFilters, t] })} caption="Databases" />
          <Pagination page={data.data.page} pageSize={data.data.pageSize} total={total} onPage={(p) => update({ page: p === 1 ? null : String(p) }, true)} />
        </>
      )}
    </>
  );
}

function Grouped({ groupBy, filter, filterKey, version, selection, setMatching, update, tagFilters }: { groupBy: string; filter: DatabaseFilter; filterKey: string; version: number; selection: Selection; setMatching: (n: number) => void; update: (c: Record<string, string | string[] | null>, keepPage?: boolean) => void; tagFilters: string[] }) {
  const data = useAsync(() => client.groupDatabases(groupBy, filter), [groupBy, filterKey, version]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (data.status === "ready") setMatching(data.data.total);
  }, [data, setMatching]);

  if (data.status === "loading") return <Message>Loading groups</Message>;
  if (data.status === "error") return <Message role="alert">{data.message}</Message>;
  const { groups, total } = data.data;
  const key = (v: string | null) => v ?? "\u0000none";
  const toggleOpen = (v: string | null) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(key(v)) ? next.delete(key(v)) : next.add(key(v));
      return next;
    });

  return (
    <>
      <p className="muted result-count" role="status">
        {formatCount(total)} {total === 1 ? "database" : "databases"} in {formatCount(groups.length)} {groups.length === 1 ? "group" : "groups"}, grouped by {groupBy}
      </p>
      {groups.length === 0 ? (
        <div className="empty">
          <p>No databases match these filters.</p>
        </div>
      ) : (
        <ul className="groups">
          {groups.map((g) => {
            const label = g.value ?? `No ${groupBy} tag`;
            const isOpen = open.has(key(g.value));
            const groupTag = g.value === null ? `!${groupBy}` : `${groupBy}:${g.value}`;
            return (
              <li key={key(g.value)} className="group">
                <h2 className="group-head">
                  <button type="button" className="group-toggle" aria-expanded={isOpen} onClick={() => toggleOpen(g.value)}>
                    {isOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                    <span className="mono group-name">{label}</span>
                  </button>
                  <span className="group-meta">
                    <strong className="mono">{formatCount(g.count)}</strong> {g.count === 1 ? "database" : "databases"}
                    <span className="muted"> · {formatCount(g.awake)} awake · {formatStorage(g.storageMb)}</span>
                  </span>
                </h2>
                {isOpen && <GroupBody groupTag={groupTag} filter={filter} version={version} selection={selection} update={update} tagFilters={tagFilters} label={label} />}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function GroupBody({ groupTag, filter, version, selection, update, tagFilters, label }: { groupTag: string; filter: DatabaseFilter; version: number; selection: Selection; update: (c: Record<string, string | string[] | null>, keepPage?: boolean) => void; tagFilters: string[]; label: string }) {
  const groupFilter = useMemo(() => ({ ...filter, tags: [...(filter.tags ?? []), groupTag] }), [filter, groupTag]);
  const [pages, setPages] = useState(1);
  const data = useAsync(() => client.listDatabases({ ...groupFilter, sort: "name", dir: "asc", page: 1, pageSize: GROUP_PAGE_SIZE * pages }), [groupFilter, pages, version]);
  const selectGroup = async () => selection.toggle(await client.listDatabaseIds(groupFilter), true);

  if (data.status === "loading") return <Message>Loading databases</Message>;
  if (data.status === "error") return <Message role="alert">{data.message}</Message>;
  const { items, total } = data.data;
  return (
    <div className="group-body">
      <div className="row-actions">
        <button type="button" className="btn btn-sm" onClick={selectGroup}>
          Select all {formatCount(total)} in {label}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => update({ group: null, tag: [...tagFilters.filter((t) => splitTag(t).key !== splitTag(groupTag.replace(/^!/, "")).key), groupTag] })}>
          Show only {label}
        </button>
      </div>
      <DbTable items={items} selected={selection.selected} onToggle={selection.toggle} caption={`Databases in ${label}`} />
      {items.length < total && (
        <button type="button" className="btn" onClick={() => setPages((p) => p + 1)}>
          Show more ({formatCount(total - items.length)} left)
        </button>
      )}
    </div>
  );
}


