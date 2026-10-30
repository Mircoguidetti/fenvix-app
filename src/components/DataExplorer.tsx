import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useOrg } from "../session/OrgProvider";
import { ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw } from "lucide-react";
import { explorer } from "../data/explorer-client";
import { type CollectionInfo, type DocumentItem, type DocumentPage, type Ejson, ExplorerError } from "../data/explorer";
import type { Database } from "../data";
import { describe, idSummary, jsonError, pretty, summary } from "../lib/ejson";
import { formatCount } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { Message } from "./PageHeader";
import { useToast } from "./Toast";
import { Segmented } from "./Segmented";
import { FieldForm } from "./explorer/FieldForm";
import { NewDocumentDialog } from "./explorer/NewDocumentDialog";
import { QueryBuilder } from "./explorer/QueryBuilder";
import { message, newObjectId, waking } from "./explorer/util";
import { fieldTypeOf, textOf, typeLabel } from "../lib/fieldValue";

/**
 * The Data tab of a database: its collections on the left, the documents of the chosen one on the right.
 *
 * Every value from a customer's documents is rendered as React text (never as HTML), so markup in the data shows as
 * the characters it is. Requests go to the control plane only when the person does something: nothing polls, so an
 * open tab does not keep the database awake.
 */
export function DataExplorer({ db }: { db: Database }) {
  const { canManage } = useOrg();
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

  const [view, setView] = useState<"panels" | "query">("panels");
  /** Phone and tablet: one column at a time (collections, then documents, then the document). */
  const [level, setLevel] = useState<"collections" | "documents" | "document">("collections");
  const [selected, setSelected] = useState<DocumentItem | null>(null);
  const [fieldBusy, setFieldBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
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
    setSelected(null);
  }

  async function selectDoc(item: DocumentItem) {
    setFieldError(null);
    setLevel("document");
    if (item.tooLarge || !item.id) return setSelected(item);
    if (!item.partial && item.document) return setSelected(item);
    try {
      setSelected(await waking(() => explorer.getDocument(db.id, current!, item.id), setWakingUp));
    } catch (e) {
      setSelected(null);
      setLevel("documents");
      toast(message(e), "error");
    }
  }

  /** After a change: the document as it is now (with its new version), and the list around it. */
  async function afterChange(id: string) {
    void loadDocs();
    void refreshCounts();
    try {
      setSelected(await explorer.getDocument(db.id, current!, id));
    } catch {
      setSelected(null);
    }
  }

  /** Saves the selected document with one field added or changed. */
  async function setField(name: string, value: Ejson, mode: "add" | "edit"): Promise<boolean> {
    const doc = selected?.document;
    if (!current || !selected?.version || !doc) return false;
    if (mode === "add" && name in doc) {
      setFieldError(`The field ${name} is already in this document. Change it with its pencil.`);
      return false;
    }
    setFieldBusy(true);
    setFieldError(null);
    try {
      await waking(() => explorer.replaceDocument(db.id, current, selected.id, { ...doc, [name]: value }, selected.version!), setWakingUp);
      toast(mode === "add" ? `Added field ${name}` : `Saved ${name}`, "success");
      await afterChange(selected.id);
      return true;
    } catch (e) {
      setFieldError(message(e));
      if (e instanceof ExplorerError && e.status === 409) void afterChange(selected.id);
      return false;
    } finally {
      setFieldBusy(false);
    }
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
        toast("Document inserted", "success");
      } else {
        // A retry of a save that did land meets a new version and answers 409: nothing is overwritten.
        await waking(() => explorer.replaceDocument(db.id, current, editing.item!.id, typed, editing.item!.version!), setWakingUp);
        toast("Document saved", "success");
      }
      setEditing(null);
      if (editing.mode === "edit" && editing.item) void afterChange(editing.item.id);
      else {
        void loadDocs();
        void refreshCounts();
      }
    } catch (e) {
      setDialogError(message(e));
      // Someone else changed it: show the list as it is now, so the next action starts from the latest version.
      if (e instanceof ExplorerError && e.status === 409) {
        void loadDocs();
        if (editing.item?.id) void afterChange(editing.item.id);
      }
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
      toast("Document deleted", "success");
      setDeleting(null);
      setSelected(null);
      setLevel("documents");
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
  const phoneBack = (to: "collections" | "documents", label: string) => (
    <button type="button" className="ex-back" onClick={() => setLevel(to)}>
      <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <div className="explorer">
      {wakingUp && (
        <p className="waking" role="status">
          <RefreshCw size={16} aria-hidden="true" className="spin" />
          Waking the database. The first request after it sleeps can take a few seconds.
        </p>
      )}

      {collections && collections.length > 0 && (
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "panels", label: "Panels" },
            { value: "query", label: "Query builder" },
          ]}
        />
      )}

      {view === "query" && collections && collections.length > 0 ? (
        <QueryBuilder dbId={db.id} collections={collections} initial={current} onWaking={setWakingUp} />
      ) : (
        <div className="ex-grid" data-level={level}>
          <section className="ex-col ex-collections" aria-labelledby="collections-h">
            <div className="ex-head">
              <h2 id="collections-h">Collections</h2>
              <button type="button" className="icon-btn" onClick={() => void loadCollections()} aria-label="Reload collections">
                <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <div className="ex-body">
              {collError && <Message role="alert">{collError}</Message>}
              {!collError && collections === null && <Message>Loading collections</Message>}
              {collections?.length === 0 && (
                <div className="empty compact">
                  <p>This database has no collections yet.</p>
                  <p className="muted small">Insert a document into a new collection to create one.</p>
                  <NewCollection onCreate={(name) => (setCollections([{ name, type: "collection", browsable: true, estimatedCount: 0 }]), pick(name), setLevel("documents"))} />
                </div>
              )}
              {collections && collections.length > 0 && (
                <>
                  <ul className="coll-list">
                    {collections.map((c) => (
                      <li key={c.name}>
                        <button
                          type="button"
                          className="coll-btn"
                          aria-current={c.name === current ? "true" : undefined}
                          disabled={!c.browsable}
                          onClick={() => (pick(c.name), setLevel("documents"))}
                          title={c.browsable ? c.name : "This name cannot be opened here"}
                        >
                          <span className="mono ellipsis">{c.name}</span>
                          <span className="coll-count">{c.estimatedCount === null ? "–" : `~${formatCount(c.estimatedCount)}`}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <NewCollection onCreate={(name) => (setCollections((cs) => (cs?.some((c) => c.name === name) ? cs : [...(cs ?? []), { name, type: "collection", browsable: true, estimatedCount: 0 }])), pick(name), setLevel("documents"))} />
                </>
              )}
            </div>
          </section>

          <section className="ex-col ex-docs" aria-labelledby="documents-h">
            {phoneBack("collections", "Collections")}
            <div className="ex-head ex-head-docs">
              <div className="ex-title">
                <h2 id="documents-h">{current ? <span className="mono">{current}</span> : "Documents"}</h2>
                {currentInfo?.estimatedCount != null && <p className="small faint">About {formatCount(currentInfo.estimatedCount)} documents</p>}
              </div>
              {current && canManage && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => (setDialogError(null), setEditing({ mode: "insert" }))}>
                  <Plus size={16} strokeWidth={2} aria-hidden="true" />
                  Insert document
                </button>
              )}
            </div>
            <div className="ex-body ex-body-docs">
              {current && (
                <form className="query" onSubmit={applyQuery} noValidate>
                  <div className="query-line">
                    <label htmlFor="q-filter" className="sr-only">
                      Filter
                    </label>
                    <input id="q-filter" className="mono" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder='Filter, for example {"status": "paid"}' spellCheck={false} autoComplete="off" autoCapitalize="none" aria-invalid={queryError?.field === "filter"} aria-describedby={queryError ? "q-error" : "q-help"} />
                    <button type="submit" className="btn btn-sm">
                      Apply
                    </button>
                  </div>
                  <details className="query-more" open={!!(sort || projection) || queryError?.field === "sort" || queryError?.field === "projection"}>
                    <summary>Sort and fields</summary>
                    <div className="query-row">
                      <div className="field grow">
                        <label htmlFor="q-sort">Sort</label>
                        <input id="q-sort" className="mono" value={sort} onChange={(e) => setSort(e.target.value)} placeholder='{"placedAt": -1}' spellCheck={false} autoComplete="off" autoCapitalize="none" aria-invalid={queryError?.field === "sort"} />
                      </div>
                      <div className="field grow">
                        <label htmlFor="q-projection">Fields</label>
                        <input id="q-projection" className="mono" value={projection} onChange={(e) => setProjection(e.target.value)} placeholder='{"status": 1, "total": 1}' spellCheck={false} autoComplete="off" autoCapitalize="none" aria-invalid={queryError?.field === "projection"} />
                      </div>
                    </div>
                  </details>
                  <div className="query-foot">
                    {queryError ? (
                      <p id="q-error" className="error" role="alert">
                        {queryError.text}
                      </p>
                    ) : (
                      <p id="q-help" className="help">
                        Extended JSON. Allowed: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $and, $or, $not, $exists, $regex.
                      </p>
                    )}
                    {(applied.filter || applied.sort || applied.projection || filter || sort || projection) && (
                      <button type="button" className="btn btn-quiet btn-xs" onClick={resetQuery}>
                        Reset
                      </button>
                    )}
                  </div>
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
                    <li key={item.id || `row-${i}`} className="doc" data-selected={selected && selected.id === item.id && item.id ? "" : undefined}>
                      <button type="button" className="doc-pick" aria-current={selected && selected.id === item.id && item.id ? "true" : undefined} onClick={() => void selectDoc(item)} aria-label={`Open document ${idSummary(item.id, 40)}`}>
                        <span className="mono ellipsis doc-id">{idSummary(item.id, 40)}</span>
                        {item.tooLarge ? <span className="small faint">Too large to list ({formatCount(item.sizeBytes ?? 0)} characters)</span> : <CollapsedFields doc={item.document ?? {}} />}
                      </button>
                    </li>
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
            </div>
          </section>

          <section className="ex-col ex-doc" aria-label="Selected document">
            {phoneBack("documents", current ?? "Documents")}
            {selected ? (
              <DocumentPanel
                key={selected.id}
                item={selected}
                readOnly={!canManage}
                busy={fieldBusy}
                error={fieldError}
                onSetField={setField}
                onEditJson={() => (setDialogError(null), setEditing({ mode: "edit", item: selected }))}
                onDelete={() => (setDialogError(null), setDeleting(selected))}
              />
            ) : (
              <div className="ex-body ex-empty">
                <p className="muted">{result && result.items.length > 0 ? "Choose a document to see its fields." : "Documents you open show their fields here."}</p>
              </div>
            )}
          </section>
        </div>
      )}

      {editing?.mode === "insert" && <NewDocumentDialog collection={current ?? ""} busy={busy} error={dialogError} onSave={(text) => void save(text)} onCancel={() => setEditing(null)} />}
      {editing?.mode === "edit" && (
        <EditorDialog
          key={editing.item?.version ?? "new"}
          title="Edit as JSON"
          initial={pretty(editing.item?.document ?? {})}
          busy={busy}
          error={dialogError}
          conflict={dialogError !== null && /changed this document/.test(dialogError)}
          onReload={() => void reloadEditing()}
          onSave={(text) => void save(text)}
          onCancel={() => setEditing(null)}
        />
      )}

      <ConfirmDialog danger open={deleting !== null} title="Delete this document?" confirmLabel="Delete document" busy={busy} onConfirm={() => void remove()} onCancel={() => setDeleting(null)}>
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

/** The fields of one document, one row each: name, type, value and a pencil; and the form that adds a field. */
function DocumentPanel({ item, readOnly, busy, error, onSetField, onEditJson, onDelete }: { item: DocumentItem; readOnly: boolean; busy: boolean; error: string | null; onSetField: (name: string, value: Ejson, mode: "add" | "edit") => Promise<boolean>; onEditJson: () => void; onDelete: () => void }) {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const doc = item.document;
  return (
    <>
      <div className="ex-head ex-head-doc">
        <div className="ex-title">
          <p className="small faint">Document</p>
          <p className="mono doc-title" title={idSummary(item.id, 200)}>
            {idSummary(item.id, 40)}
          </p>
        </div>
        {!readOnly && (
          <div className="row-actions">
            <button type="button" className="btn btn-sm" onClick={onEditJson} disabled={item.tooLarge || !item.id} aria-label={`Edit as JSON, document ${idSummary(item.id, 40)}`}>
              Edit as JSON
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={onDelete} disabled={!item.version} aria-label={`Delete document ${idSummary(item.id, 40)}`}>
              Delete
            </button>
          </div>
        )}
      </div>
      <div className="ex-body ex-body-doc">
        {item.tooLarge || !doc ? (
          <p className="muted small">This document is too large to show field by field ({formatCount(item.sizeBytes ?? 0)} characters).</p>
        ) : (
          <>
            <ul className="fields" aria-label="Fields">
              {Object.entries(doc).map(([name, value]) => {
                const type = fieldTypeOf(value);
                const d = describe(value);
                const open = editingField === name;
                return (
                  <li key={name} className="field-row" data-editing={open || undefined}>
                    <span className="mono field-name">{name}</span>
                    <span className="type-pill" data-type={typeLabel(value)}>
                      {typeLabel(value)}
                    </span>
                    <span className="mono field-value" title={d.kind === "scalar" ? d.text : undefined}>
                      {d.kind === "scalar" ? d.text : summary(value, 60)}
                    </span>
                    {!readOnly && item.version && name !== "_id" && (
                      <button
                        type="button"
                        className="icon-btn field-edit"
                        disabled={!type}
                        aria-label={type ? `Edit field ${name}` : `Field ${name} has a type that only the JSON editor changes`}
                        title={type ? undefined : "Use Edit as JSON for this type"}
                        aria-expanded={open}
                        onClick={() => setEditingField(open ? null : name)}
                      >
                        <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    )}
                    {open && type && (
                      <div className="field-row-form">
                        <FieldForm
                          idPrefix={`ef-${name}`}
                          initial={{ name, type, text: textOf(value) }}
                          lockName
                          submitLabel="Save field"
                          busy={busy}
                          error={error}
                          onCancel={() => setEditingField(null)}
                          onSubmit={async (n, v) => {
                            if (await onSetField(n, v, "edit")) setEditingField(null);
                          }}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
              {Object.keys(doc).length === 0 && <li className="muted small">This document has no fields.</li>}
            </ul>
            {!readOnly && item.version && (
              <div className="add-field">
                {adding ? (
                  <FieldForm
                    idPrefix="af"
                    title="Add field"
                    submitLabel="Add field"
                    busy={busy}
                    error={editingField === null ? error : null}
                    onCancel={() => setAdding(false)}
                    onSubmit={async (n, v) => {
                      if (await onSetField(n, v, "add")) setAdding(false);
                    }}
                  />
                ) : (
                  <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
                    <Plus size={15} strokeWidth={2} aria-hidden="true" />
                    Add field
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
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
