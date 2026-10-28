import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { explorer } from "../data/explorer-client";
import { type CollectionInfo, type DocumentItem, type DocumentPage, type Ejson, ExplorerError } from "../data/explorer";
import type { Database } from "../data";
import { describe, idSummary, jsonError, pretty, summary } from "../lib/ejson";
import { formatCount } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { Message } from "./PageHeader";
import { useToast } from "./Toast";

/**
 * The Data tab of a database: its collections on the left, the documents of the chosen one on the right.
 *
 * Every value from a customer's documents is rendered as React text (never as HTML), so markup in the data shows as
 * the characters it is. Requests go to the control plane only when the person does something: nothing polls, so an
 * open tab does not keep the database awake.
 */
const WAKE_RETRIES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a call; while the database wakes (503) it waits as asked and tries again, and tells the page it is waking. */
async function waking<T>(work: () => Promise<T>, onWaking: (on: boolean) => void, slowMs = 900): Promise<T> {
  const slow = setTimeout(() => onWaking(true), slowMs);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (e) {
        if (!(e instanceof ExplorerError) || !e.waking || attempt >= WAKE_RETRIES) throw e;
        onWaking(true);
        await sleep((e.retryAfter ?? 2) * 1000);
      }
    }
  } finally {
    clearTimeout(slow);
    onWaking(false);
  }
}

/** A new ObjectId (time, then random), as MongoDB makes them. */
function newObjectId(): string {
  const time = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  return time + rand;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");

export function DataExplorer({ db }: { db: Database }) {
  const toast = useToast();
  const [wakingUp, setWakingUp] = useState(false);
  const [collections, setCollections] = useState<CollectionInfo[] | null>(null);
  const [collError, setCollError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("");
  const [projection, setProjection] = useState("");
  const [applied, setApplied] = useState({ filter: "", sort: "", projection: "" });
  const [queryError, setQueryError] = useState<{ field: string; text: string } | null>(null);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<DocumentPage | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(false);

  const [editing, setEditing] = useState<{ mode: "insert" | "edit"; item?: DocumentItem } | null>(null);
  const [deleting, setDeleting] = useState<DocumentItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const loadCollections = useCallback(async () => {
    setCollError(null);
    setCollections(null);
    try {
      const r = await waking(() => explorer.listCollections(db.id), setWakingUp, db.state === "asleep" ? 0 : 900);
      setCollections(r.items);
      setCurrent((c) => c ?? r.items.find((x) => x.browsable)?.name ?? null);
    } catch (e) {
      setCollError(message(e));
    }
  }, [db.id, db.state]);

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  const seq = useRef(0);
  const loadDocs = useCallback(async () => {
    if (!current) return;
    const mine = ++seq.current;
    setLoadingDocs(true);
    setDocsError(null);
    try {
      const r = await waking(() => explorer.findDocuments(db.id, current, { ...applied, page }), setWakingUp);
      if (mine === seq.current) setResult(r);
    } catch (e) {
      if (mine !== seq.current) return;
      setResult(null);
      if (e instanceof ExplorerError && e.status === 400 && (e.field === "filter" || e.field === "sort" || e.field === "projection")) setQueryError({ field: e.field, text: e.message });
      else setDocsError(message(e));
    } finally {
      if (mine === seq.current) setLoadingDocs(false);
    }
  }, [db.id, current, applied, page]);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

  function pick(name: string) {
    if (name === current) return;
    setCurrent(name);
    setPage(1);
    setResult(null);
    setQueryError(null);
  }

  function applyQuery(e: FormEvent) {
    e.preventDefault();
    const problem =
      (jsonError(filter, "The filter") && { field: "filter", text: jsonError(filter, "The filter")! }) ||
      (jsonError(sort, "The sort") && { field: "sort", text: jsonError(sort, "The sort")! }) ||
      (jsonError(projection, "The projection") && { field: "projection", text: jsonError(projection, "The projection")! }) ||
      null;
    setQueryError(problem);
    if (problem) return;
    setPage(1);
    setApplied({ filter, sort, projection });
  }

  function resetQuery() {
    setFilter("");
    setSort("");
    setProjection("");
    setQueryError(null);
    setPage(1);
    setApplied({ filter: "", sort: "", projection: "" });
  }

  async function openEditor(item: DocumentItem) {
    setDialogError(null);
    if (!item.partial && item.document) return setEditing({ mode: "edit", item });
    // A projected or large document is opened whole before editing, so nothing is lost on save.
    try {
      setEditing({ mode: "edit", item: await waking(() => explorer.getDocument(db.id, current!, item.id), setWakingUp) });
    } catch (e) {
      toast(message(e));
    }
  }

  async function save(text: string) {
    if (!current || !editing) return;
    const problem = jsonError(text, "The document");
    if (problem) return setDialogError(problem);
    setBusy(true);
    setDialogError(null);
    try {
      const typed = JSON.parse(text) as { [k: string]: Ejson };
      if (editing.mode === "insert") {
        // The _id is chosen here, once, so a retry after a timeout (the database waking) cannot insert twice:
        // if the first attempt did land, the retry meets its own _id and that is the success it looks like.
        const generated = !("_id" in typed);
        const doc = generated ? { _id: { $oid: newObjectId() }, ...typed } : typed;
        let tries = 0;
        await waking(async () => {
          try {
            return await explorer.insertDocument(db.id, current, doc);
          } catch (e) {
            if (tries > 0 && generated && e instanceof ExplorerError && e.status === 409 && e.field === "document") return;
            throw e;
          } finally {
            tries++;
          }
        }, setWakingUp);
        toast("Document inserted");
      } else {
        // A retry of a save that did land meets a new version and answers 409: nothing is overwritten.
        await waking(() => explorer.replaceDocument(db.id, current, editing.item!.id, typed, editing.item!.version!), setWakingUp);
        toast("Document saved");
      }
      setEditing(null);
      void loadDocs();
      void refreshCounts();
    } catch (e) {
      setDialogError(message(e));
      // Someone else changed it: show the list as it is now, so the next action starts from the latest version.
      if (e instanceof ExplorerError && e.status === 409) void loadDocs();
    } finally {
      setBusy(false);
    }
  }

  async function reloadEditing() {
    if (!current || !editing?.item) return;
    try {
      setEditing({ mode: "edit", item: await explorer.getDocument(db.id, current, editing.item.id) });
      setDialogError(null);
    } catch (e) {
      setDialogError(message(e));
    }
  }

  async function remove() {
    if (!current || !deleting?.version) return;
    setBusy(true);
    setDialogError(null);
    try {
      await waking(() => explorer.deleteDocument(db.id, current, deleting.id, deleting.version!), setWakingUp);
      toast("Document deleted");
      setDeleting(null);
      void loadDocs();
      void refreshCounts();
    } catch (e) {
      setDialogError(message(e));
      if (e instanceof ExplorerError && (e.status === 409 || e.status === 404)) void loadDocs();
    } finally {
      setBusy(false);
    }
  }

  async function refreshCounts() {
    try {
      setCollections((await explorer.listCollections(db.id)).items);
    } catch {
      /* the list stays as it was */
    }
  }

  const currentInfo = collections?.find((c) => c.name === current);

  return (
    <div className="explorer">
      {wakingUp && (
        <p className="waking" role="status">
          <RefreshCw size={16} aria-hidden="true" className="spin" />
          Waking the database. The first request after it sleeps can take a few seconds.
        </p>
      )}

      <section className="explorer-side card" aria-labelledby="collections-h">
        <div className="card-head">
          <h2 id="collections-h">Collections</h2>
          <button type="button" className="icon-btn" onClick={() => void loadCollections()} aria-label="Reload collections">
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
        {collError && <Message role="alert">{collError}</Message>}
        {!collError && collections === null && <Message>Loading collections</Message>}
        {collections?.length === 0 && (
          <div className="empty compact">
            <p>This database has no collections yet.</p>
            <p className="muted small">Insert a document into a new collection to create one.</p>
            <NewCollection onCreate={(name) => (setCollections([{ name, type: "collection", browsable: true, estimatedCount: 0 }]), pick(name))} />
          </div>
        )}
        {collections && collections.length > 0 && (
          <>
            <label className="sr-only" htmlFor="coll-select">
              Collection
            </label>
            <select id="coll-select" className="coll-select" value={current ?? ""} onChange={(e) => pick(e.target.value)}>
              {collections.map((c) => (
                <option key={c.name} value={c.name} disabled={!c.browsable}>
                  {c.name} {c.estimatedCount === null ? "" : `(${formatCount(c.estimatedCount)})`}
                </option>
              ))}
            </select>
            <ul className="coll-list">
              {collections.map((c) => (
                <li key={c.name}>
                  <button type="button" className="coll-btn" aria-current={c.name === current ? "true" : undefined} disabled={!c.browsable} onClick={() => pick(c.name)} title={c.browsable ? c.name : "This name cannot be opened here"}>
                    <span className="mono ellipsis">{c.name}</span>
                    <span className="muted small">{c.estimatedCount === null ? "–" : `~${formatCount(c.estimatedCount)}`}</span>
                  </button>
                </li>
              ))}
            </ul>
            <NewCollection onCreate={(name) => (setCollections((cs) => (cs?.some((c) => c.name === name) ? cs : [...(cs ?? []), { name, type: "collection", browsable: true, estimatedCount: 0 }])), pick(name))} />
          </>
        )}
      </section>

      <section className="explorer-main card" aria-labelledby="documents-h">
        <div className="card-head">
          <div className="card-head-main">
            <h2 id="documents-h">{current ? <span className="mono">{current}</span> : "Documents"}</h2>
            {currentInfo?.estimatedCount != null && <p className="muted card-desc">About {formatCount(currentInfo.estimatedCount)} documents</p>}
          </div>
          {current && (
            <button type="button" className="btn btn-sm" onClick={() => (setDialogError(null), setEditing({ mode: "insert" }))}>
              <Plus size={16} aria-hidden="true" />
              Insert document
            </button>
          )}
        </div>

        {current && (
          <form className="query" onSubmit={applyQuery} noValidate>
            <div className="field grow">
              <label htmlFor="q-filter">Filter</label>
              <input id="q-filter" className="mono" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder='{"status": "paid"}' spellCheck={false} autoComplete="off" aria-invalid={queryError?.field === "filter"} aria-describedby={queryError ? "q-error" : "q-help"} />
            </div>
            <details className="query-more" open={!!(sort || projection) || queryError?.field === "sort" || queryError?.field === "projection"}>
              <summary>Sort and fields</summary>
              <div className="query-row">
                <div className="field grow">
                  <label htmlFor="q-sort">Sort</label>
                  <input id="q-sort" className="mono" value={sort} onChange={(e) => setSort(e.target.value)} placeholder='{"placedAt": -1}' spellCheck={false} autoComplete="off" aria-invalid={queryError?.field === "sort"} />
                </div>
                <div className="field grow">
                  <label htmlFor="q-projection">Fields</label>
                  <input id="q-projection" className="mono" value={projection} onChange={(e) => setProjection(e.target.value)} placeholder='{"status": 1, "total": 1}' spellCheck={false} autoComplete="off" aria-invalid={queryError?.field === "projection"} />
                </div>
              </div>
            </details>
            <div className="row-actions">
              <button type="submit" className="btn btn-primary btn-sm">
                Apply
              </button>
              <button type="button" className="btn btn-sm" onClick={resetQuery}>
                Reset
              </button>
            </div>
            {queryError ? (
              <p id="q-error" className="error" role="alert">
                {queryError.text}
              </p>
            ) : (
              <p id="q-help" className="muted small">
                MongoDB query in Extended JSON. Allowed: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $and, $or, $not, $exists, $regex.
              </p>
            )}
          </form>
        )}

        {!current && collections && collections.length > 0 && <Message>Choose a collection.</Message>}
        {current && docsError && <Message role="alert">{docsError}</Message>}
        {current && !docsError && loadingDocs && !result && <Message>Loading documents</Message>}
        {current && result && result.items.length === 0 && (
          <div className="empty compact">
            <p>{applied.filter ? "No document matches this filter." : "This collection is empty."}</p>
          </div>
        )}
        {current && result && result.items.length > 0 && (
          <ol className="doc-list" aria-busy={loadingDocs}>
            {result.items.map((item, i) => (
              <DocumentRow key={item.id || `row-${i}`} item={item} onEdit={() => void openEditor(item)} onDelete={() => (setDialogError(null), setDeleting(item))} />
            ))}
          </ol>
        )}
        {current && result && (result.page > 1 || result.hasMore) && (
          <nav className="pagination" aria-label="Pages">
            <span className="muted small">
              Page {result.page}
              {result.truncated ? " (shortened: these documents are large)" : ""}
            </span>
            <div className="row-actions">
              <button type="button" className="btn btn-sm" disabled={page <= 1 || loadingDocs} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft size={16} aria-hidden="true" />
                Previous
              </button>
              <button type="button" className="btn btn-sm" disabled={!result.hasMore || loadingDocs} onClick={() => setPage((p) => p + 1)}>
                Next
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          </nav>
        )}
      </section>

      {editing && (
        <EditorDialog
          key={editing.item?.version ?? "new"}
          title={editing.mode === "insert" ? `Insert into ${current}` : "Edit document"}
          initial={editing.mode === "insert" ? '{\n  \n}' : pretty(editing.item?.document ?? {})}
          busy={busy}
          error={dialogError}
          conflict={dialogError !== null && /changed this document/.test(dialogError)}
          onReload={() => void reloadEditing()}
          onSave={(text) => void save(text)}
          onCancel={() => setEditing(null)}
        />
      )}

      <ConfirmDialog open={deleting !== null} title="Delete this document?" confirmLabel="Delete document" busy={busy} onConfirm={() => void remove()} onCancel={() => setDeleting(null)}>
        <p>
          This permanently deletes the document with _id <span className="mono">{deleting ? idSummary(deleting.id) : ""}</span> from {current}. It cannot be undone.
        </p>
        {dialogError && (
          <p className="error" role="alert">
            {dialogError}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function NewCollection({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open)
    return (
      <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(true)}>
        New collection
      </button>
    );
  const valid = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$/.test(name) && !/^system\./i.test(name) && !name.includes("..") && !name.endsWith(".");
  return (
    <form
      className="new-coll"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) (onCreate(name), setOpen(false), setName(""));
      }}
    >
      <label htmlFor="new-coll">Collection name</label>
      <input id="new-coll" className="mono" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus />
      {name && !valid && <p className="error small">Use letters, digits, "_", "-" or "."; not "system."</p>}
      <div className="row-actions">
        <button type="submit" className="btn btn-sm" disabled={!valid}>
          Open
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DocumentRow({ item, onEdit, onDelete }: { item: DocumentItem; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <li className="doc">
      <div className="doc-head">
        <button type="button" className="doc-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          <span className="mono ellipsis">_id: {idSummary(item.id, 64)}</span>
        </button>
        <div className="row-actions">
          <button type="button" className="btn btn-sm" onClick={onEdit} disabled={item.tooLarge || !item.id} aria-label={`Edit document ${idSummary(item.id, 40)}`}>
            <Pencil size={14} aria-hidden="true" />
            <span className="hide-narrow">Edit</span>
          </button>
          <button type="button" className="btn btn-sm" onClick={onDelete} disabled={!item.version} aria-label={`Delete document ${idSummary(item.id, 40)}`} title={item.version ? undefined : "Open the whole document (no field list) to delete it"}>
            <Trash2 size={14} aria-hidden="true" />
            <span className="hide-narrow">Delete</span>
          </button>
        </div>
      </div>
      {item.tooLarge ? (
        <p className="muted small doc-body">This document is too large to list ({formatCount(item.sizeBytes ?? 0)} characters).</p>
      ) : (
        <div id={bodyId} className="doc-body">
          {open ? <JsonTree value={item.document ?? {}} /> : <CollapsedFields doc={item.document ?? {}} />}
        </div>
      )}
    </li>
  );
}

/** The first fields on one or two lines. Text only. */
function CollapsedFields({ doc }: { doc: { [k: string]: Ejson } }) {
  const entries = Object.entries(doc).filter(([k]) => k !== "_id");
  return (
    <p className="doc-summary mono">
      {entries.length === 0 && <span className="muted">No other fields</span>}
      {entries.slice(0, 6).map(([k, v]) => (
        <span key={k} className="kv">
          <span className="k">{k}</span>: <span className="v">{summary(v, 48)}</span>
        </span>
      ))}
      {entries.length > 6 && <span className="muted"> and {entries.length - 6} more</span>}
    </p>
  );
}

/** Expandable tree of a document. Every key and value is a React text node. */
export function JsonTree({ value }: { value: Ejson }) {
  return (
    <div className="json-tree mono">
      <Node value={value} depth={0} />
    </div>
  );
}

function Node({ name, value, depth }: { name?: string; value: Ejson; depth: number }) {
  const d = describe(value);
  const [open, setOpen] = useState(depth < 2);
  const label: ReactNode = name !== undefined && (
    <>
      <span className="k">{name}</span>:{" "}
    </>
  );
  if (d.kind === "scalar") {
    return (
      <div className="node">
        {label}
        <span className={`v t-${d.type}`}>{d.text}</span>
      </div>
    );
  }
  const children = d.kind === "array" ? d.items.map((v, i) => [String(i), v] as const) : d.entries;
  return (
    <div className="node">
      <button type="button" className="node-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
        <span className="muted">{summary(value)}</span>
      </button>
      {open && (
        <div className="node-children">
          {children.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function EditorDialog({ title, initial, busy, error, conflict, onSave, onCancel, onReload }: { title: string; initial: string; busy: boolean; error: string | null; conflict: boolean; onSave: (text: string) => void; onCancel: () => void; onReload: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [text, setText] = useState(initial);
  const local = jsonError(text, "The document");
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} className="dialog dialog-wide" aria-labelledby={titleId} onCancel={(e) => (e.preventDefault(), onCancel())}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !local) onSave(text);
        }}
        noValidate
      >
        <h2 id={titleId}>{title}</h2>
        <div className="dialog-body">
          <p className="small">Extended JSON (canonical): types are kept, for example {'{"$oid": "…"}'}, {'{"$date": "…"}'}, {'{"$numberDecimal": "…"}'}.</p>
          <label htmlFor="doc-editor" className="sr-only">
            Document
          </label>
          <textarea id="doc-editor" className="code editor" rows={16} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-invalid={!!(local || error)} />
          {(local || error) && (
            <p className="error" role="alert">
              {local ?? error}
            </p>
          )}
          {conflict && (
            <button type="button" className="btn btn-sm" onClick={onReload}>
              <RefreshCw size={14} aria-hidden="true" />
              Load the latest version
            </button>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !!local}>
            {busy ? "Saving" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
