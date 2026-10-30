import { useEffect, useId, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { Ejson } from "../../data/explorer";
import { jsonError, pretty, summary } from "../../lib/ejson";
import { fieldNameProblem, fieldTypeOf, textOf, typeLabel } from "../../lib/fieldValue";
import { FieldForm } from "./FieldForm";

/**
 * A new document, built field by field with the same form as "Add field", or typed as Extended JSON. The two views
 * edit the same document: moving to JSON writes the fields out, moving back reads them in (when the JSON is valid).
 */
export function NewDocumentDialog({ collection, busy, error, onSave, onCancel }: { collection: string; busy: boolean; error: string | null; onSave: (text: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [mode, setMode] = useState<"fields" | "json">("fields");
  const [fields, setFields] = useState<[string, Ejson][]>([]);
  const [text, setText] = useState("{\n  \n}");
  const [formKey, setFormKey] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const local = mode === "json" ? jsonError(text, "The document") : null;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  function toJson() {
    setText(fields.length ? pretty(Object.fromEntries(fields)) : "{\n  \n}");
    setMode("json");
    setNote(null);
  }
  function toFields() {
    const problem = jsonError(text, "The document");
    if (problem) return setNote(problem);
    const obj = JSON.parse(text || "{}") as { [k: string]: Ejson };
    setFields(Object.entries(obj));
    setMode("fields");
    setNote(null);
  }
  function add(name: string, value: Ejson) {
    if (fields.some(([n]) => n === name)) return setNote(`The field ${name} is already in this document.`);
    const p = name === "_id" ? null : fieldNameProblem(name);
    if (p) return setNote(p);
    setFields((f) => [...f, [name, value]]);
    setFormKey((k) => k + 1);
    setNote(null);
  }

  return (
    <dialog ref={ref} className="dialog dialog-wide" aria-labelledby={titleId} onCancel={(e) => (e.preventDefault(), onCancel())}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || local) return;
          if (mode === "json") onSave(text);
          else onSave(JSON.stringify(Object.fromEntries(fields)));
        }}
        noValidate
      >
        <h2 id={titleId}>Insert into {collection}</h2>
        <div className="dialog-body">
          <div className="seg" role="group" aria-label="How to write the document">
            <button type="button" aria-pressed={mode === "fields"} onClick={() => mode !== "fields" && toFields()}>
              Field by field
            </button>
            <button type="button" aria-pressed={mode === "json"} onClick={() => mode !== "json" && toJson()}>
              Edit as JSON
            </button>
          </div>
          {mode === "fields" ? (
            <>
              <p className="small">An _id is made for you unless you add one. Add as many fields as you need, then insert.</p>
              {fields.length > 0 && (
                <ul className="new-fields" aria-label="Fields of the new document">
                  {fields.map(([n, v]) => (
                    <li key={n}>
                      <span className="mono nf-name">{n}</span>
                      <span className="type-pill">{typeLabel(v)}</span>
                      <span className="mono nf-value" title={fieldTypeOf(v) ? textOf(v) : undefined}>
                        {summary(v, 60)}
                      </span>
                      <button type="button" className="icon-btn" aria-label={`Remove field ${n}`} onClick={() => setFields((f) => f.filter(([x]) => x !== n))}>
                        <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <FieldForm key={formKey} idPrefix="nd" title="Add field" submitLabel="Add field" onSubmit={add} />
            </>
          ) : (
            <>
              <p className="small">Extended JSON (canonical): types are kept, for example {'{"$oid": "…"}'}, {'{"$date": "…"}'}, {'{"$numberDecimal": "…"}'}.</p>
              <label htmlFor="doc-editor" className="sr-only">
                Document
              </label>
              <textarea id="doc-editor" className="code editor" rows={14} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoCapitalize="none" aria-invalid={!!(local || error)} />
            </>
          )}
          {(local || error || note) && (
            <p className="error" role="alert">
              {local ?? error ?? note}
            </p>
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
