import { useCallback, useEffect, useMemo, useState } from "react";
import { useOrg } from "../session/OrgProvider";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Plus, SlidersHorizontal, X } from "lucide-react";
import { client, type DatabaseFilter, type DatabaseSort } from "../data";
import { PageHeader, Message } from "../components/PageHeader";
import { DbTable, COLUMNS, isTextSort, type Dir } from "../components/DbTable";
import { BulkBar } from "../components/BulkBar";
import { Select } from "../components/Select";
import { Segmented } from "../components/Segmented";
import { SearchInput, SuggestInput } from "../components/SearchInput";
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

const STATE_TABS: { id: string; label: string; state?: string; keep?: string }[] = [
  { id: "all", label: "All" },
  { id: "awake", label: "Awake", state: "awake" },
  { id: "asleep", label: "Asleep", state: "asleep" },
  { id: "keep", label: "Kept awake", keep: "on" },
];

export function DatabasesPage() {
  const { canManage } = useOrg();
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const stateParam = params.get("state");
  const awakeParam = params.get("keep");
  const tagFilters = params.getAll("tag");
  const groupBy = params.get("group") ?? "";
  const sort = { key: (params.get("sort") ?? "name") as DatabaseSort, dir: (params.get("dir") ?? "asc") as Dir };
  const stateTab = awakeParam === "on" ? "keep" : stateParam === "awake" ? "awake" : stateParam === "asleep" ? "asleep" : "all";
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
  const tagOptions = useMemo(() => (tags.status === "ready" ? tags.data.map((t) => `${t.key}:${t.value}`) : []), [tags]);

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
  const countFilter = useMemo(() => ({ ...filter, state: undefined, keepAwake: undefined }), [filter]);
  const counts = useAsync(
    () =>
      Promise.all([
        client.listDatabases({ ...countFilter, pageSize: 1 }),
        client.listDatabases({ ...countFilter, state: "awake", pageSize: 1 }),
        client.listDatabases({ ...countFilter, keepAwake: true, pageSize: 1 }),
      ]).then(([all, awake, keep]) => ({ all: all.total, awake: awake.total, keep: keep.total })),
    [countFilter, version],
  );
  async function selectAllMatching() {
    const ids = await client.listDatabaseIds(filter);
    setSelected(new Set(ids));
  }

  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeCount = (stateTab !== "all" ? 1 : 0) + (groupBy ? 1 : 0) + tagFilters.length;
  const total = counts.status === "ready" ? counts.data.all : 0;
  const awakeN = counts.status === "ready" ? counts.data.awake : 0;
  const keptN = counts.status === "ready" ? Math.min(counts.data.keep, awakeN) : 0;
  const asleepN = total - awakeN;
  const stateOptions = STATE_TABS.map((t) => ({
    value: t.id,
    label: t.label,
    count: counts.status === "ready" ? formatCount(t.id === "all" ? counts.data.all : t.id === "awake" ? counts.data.awake : t.id === "asleep" ? counts.data.all - counts.data.awake : counts.data.keep) : undefined,
  }));

  return (
    <>
      <PageHeader
        title="Databases"
        description="Every database sleeps when idle and wakes on its first request."
        actions={
          canManage ? (
            <Link to="/databases/new" className="btn btn-primary">
              <Plus size={16} strokeWidth={2.25} aria-hidden="true" />
              Create database
            </Link>
          ) : undefined
        }
      />

      {counts.status === "ready" && (
        <section className="fleet" aria-label="Fleet state">
          <div className="fleet-line">
            <span className="counts-bar" role="status">
              <span>
                <b>{formatCount(total)}</b> {total === 1 ? "database" : "databases"}
                {search || tagFilters.length ? " match these filters" : " in this workspace"}
              </span>
              <span className="muted">
                <b>{Math.round((asleepN / Math.max(total, 1)) * 100)}%</b> asleep right now
              </span>
            </span>
            <span className="small faint">Idle databases cost almost nothing</span>
          </div>
          {total > 0 && (
            <div className="fleet-bar" role="img" aria-label={`${awakeN - keptN} awake, ${keptN} kept awake, ${asleepN} asleep`}>
              <span className="fleet-awake" style={{ flex: awakeN - keptN }} />
              <span className="fleet-kept" style={{ flex: keptN }} />
              <span className="fleet-asleep" style={{ flex: asleepN }} />
            </div>
          )}
        </section>
      )}

      <section className="filters" aria-label="Filters">
        <div className="filters-top">
          <div className="field grow search-field">
            <label htmlFor="db-search" className="sr-only">
              Search by name
            </label>
            <SearchInput id="db-search" value={search} onChange={(e) => update({ q: e.target.value || null })} placeholder="Search by name" />
          </div>
          <button type="button" className="btn filters-toggle" aria-expanded={filtersOpen} aria-controls="db-filters" onClick={() => setFiltersOpen((o) => !o)}>
            <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
            Filters{activeCount > 0 ? ` (${activeCount})` : ""}
          </button>
        </div>
        <div id="db-filters" className="filters-panel" data-open={filtersOpen || undefined}>
          <Segmented label="State" value={stateTab} options={stateOptions} onChange={(id) => { const t = STATE_TABS.find((x) => x.id === id)!; update({ state: t.state ?? null, keep: t.keep ?? null }); }} />
          <div className="field">
            <label htmlFor="db-group" className="sr-only">
              Group by tag
            </label>
            <Select id="db-group" value={groupBy} onChange={(v) => update({ group: v || null })} options={[{ value: "", label: "Group by tag" }, ...tagKeys.map((k) => ({ value: k, label: k }))]} />
          </div>
          {!groupBy && (
            <div className="field">
              <label htmlFor="db-sort" className="sr-only">
                Sort by
              </label>
              <Select id="db-sort" value={`${sort.key}:${sort.dir}`} onChange={(v) => { const [key, dir] = v.split(":"); update({ sort: key, dir }); }} options={SORT_OPTIONS} />
            </div>
          )}
          <form className="tag-filter" onSubmit={(e) => (e.preventDefault(), addTagFilter())} noValidate>
            <div className="field">
              <label htmlFor="db-tag" className="sr-only">
                Filter by tag
              </label>
              <SuggestInput id="db-tag" value={tagInput} onChange={(v) => (setTagInput(v), setTagError(null))} suggestions={tagOptions} placeholder="customer:acme-labs" invalid={!!tagError} describedBy={tagError ? "db-tag-error" : undefined} />
            </div>
            <button type="submit" className="btn btn-quiet">
              Add tag filter
            </button>
            {tagError && (
              <p id="db-tag-error" className="error grow-row" role="alert">
                {tagError}
              </p>
            )}
          </form>
        </div>
        {(tagFilters.length > 0 || filtersActive) && (
          <div className="active-filters">
            {search && (
              <span className="chip chip-lg chip-removable">
                name: {search}
                <button type="button" onClick={() => update({ q: null })} aria-label="Clear the name search">
                  <X size={12} strokeWidth={2.5} aria-hidden="true" />
                </button>
              </span>
            )}
            {tagFilters.map((t) => (
              <span key={t} className="chip chip-lg chip-removable">
                {t}
                <button type="button" onClick={() => update({ tag: tagFilters.filter((x) => x !== t) })} aria-label={`Remove tag filter ${t}`}>
                  <X size={12} strokeWidth={2.5} aria-hidden="true" />
                </button>
              </span>
            ))}
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setParams({}, { replace: true })}>
              Clear filters
            </button>
          </div>
        )}
      </section>

      {canManage && selected.size > 0 && <BulkBar selected={[...selected]} matching={matching} onSelectAll={selectAllMatching} onClear={() => setSelected(new Set())} onDone={reloadAll} />}

      {groupBy ? (
        <Grouped key={`${groupBy}`} groupBy={groupBy} filter={filter} filterKey={filterKey} version={version} selection={selection} setMatching={setMatching} update={update} tagFilters={tagFilters} />
      ) : (
        <Flat filter={filter} filterKey={filterKey} version={version} sort={sort} page={page} selection={selection} setMatching={setMatching} update={update} tagFilters={tagFilters} />
      )}
    </>
  );
}

function Flat({ filter, filterKey, version, sort, page, selection, setMatching, update, tagFilters }: { filter: DatabaseFilter; filterKey: string; version: number; sort: { key: DatabaseSort; dir: Dir }; page: number; selection: Selection; setMatching: (n: number) => void; update: (c: Record<string, string | string[] | null>, keepPage?: boolean) => void; tagFilters: string[] }) {
  const { canManage } = useOrg();
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
      {items.length === 0 ? (
        <div className="empty">
          <h2>No databases match these filters</h2>
          <p className="muted">Clear the filters to see the whole fleet, or create a database with these tags.</p>
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => update({ q: null, state: null, keep: null, tag: null })}>
              Clear filters
            </button>
            {canManage && (
              <Link to="/databases/new" className="btn btn-primary">
                Create database
              </Link>
            )}
          </div>
        </div>
      ) : (
        <>
          <DbTable items={items} selectable={canManage} selected={selection.selected} onToggle={selection.toggle} sort={sort} onSort={toggleSort} onPickTag={(t) => !tagFilters.includes(t) && update({ tag: [...tagFilters, t] })} caption="Databases" />
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
  const { canManage } = useOrg();
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
        {canManage && (
          <button type="button" className="btn btn-sm" onClick={selectGroup}>
            Select all {formatCount(total)} in {label}
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => update({ group: null, tag: [...tagFilters.filter((t) => splitTag(t).key !== splitTag(groupTag.replace(/^!/, "")).key), groupTag] })}>
          Show only {label}
        </button>
      </div>
      <DbTable items={items} selectable={canManage} selected={selection.selected} onToggle={selection.toggle} caption={`Databases in ${label}`} />
      {items.length < total && (
        <button type="button" className="btn" onClick={() => setPages((p) => p + 1)}>
          Show more ({formatCount(total - items.length)} left)
        </button>
      )}
    </div>
  );
}


