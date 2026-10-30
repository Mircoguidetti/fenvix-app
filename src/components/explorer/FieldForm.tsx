import { useId, useState } from "react";
import type { Ejson } from "../../data/explorer";
import { FIELD_HINTS, FIELD_TYPES, fieldNameProblem, toEjson, type FieldType } from "../../lib/fieldValue";
import { Select } from "../Select";

/**
 * One field: a name, a type and a value. The value is checked against the type and handed back as canonical
 * Extended JSON. Used to add a field, to change one, and to build a new document field by field.
 */
export function FieldForm({
  title,
  initial,
  lockName,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
  idPrefix,
}: {
  title?: string;
  initial?: { name: string; type: FieldType; text: string };
  /** The name of an existing field cannot change here. */
  lockName?: boolean;
  submitLabel: string;
  busy?: boolean;
  /** An error from the save itself (the field form shows its own checks). */
  error?: string | null;
  onSubmit: (name: string, value: Ejson) => void;
  onCancel?: () => void;
  idPrefix: string;
}) {
  const uid = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<FieldType>(initial?.type ?? "String");
  const [text, setText] = useState(initial?.text ?? "");
  const [problem, setProblem] = useState<{ field: "name" | "value"; text: string } | null>(null);
  const id = (s: string) => `${idPrefix}-${s}`;
  const big = type === "Array" || type === "Object";

  function submit() {
    const n = fieldNameProblem(name);
    if (!lockName && n) return setProblem({ field: "name", text: n });
    const v = toEjson(type, text);
    if (!v.ok) return setProblem({ field: "value", text: v.error });
    setProblem(null);
    onSubmit(name, v.value);
  }

  return (
    <div className="field-form" role="group" aria-labelledby={title ? `${uid}-t` : undefined}>
      {title && (
        <h3 id={`${uid}-t`} className="field-form-title">
          {title}
        </h3>
      )}
      <div className="field-form-row">
        <div className="field">
          <label htmlFor={id("name")}>Name</label>
          <input id={id("name")} className="mono" value={name} disabled={lockName} onChange={(e) => (setName(e.target.value), setProblem(null))} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={problem?.field === "name" || undefined} aria-describedby={problem?.field === "name" ? id("err") : undefined} placeholder="total" />
        </div>
        <div className="field">
          <label htmlFor={id("type")}>Type</label>
          <Select
            id={id("type")}
            value={type}
            onChange={(v) => (setType(v as FieldType), setProblem(null), v === "Boolean" && !/^(true|false)$/i.test(text) && setText("true"))}
            options={FIELD_TYPES.map((t) => ({ value: t, label: t, hint: FIELD_HINTS[t] }))}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={id("value")}>Value</label>
        {type === "Boolean" ? (
          <Select id={id("value")} value={/^false$/i.test(text) ? "false" : "true"} onChange={setText} options={[{ value: "true", label: "true" }, { value: "false", label: "false" }]} />
        ) : type === "Null" ? (
          <input id={id("value")} className="mono" value="null" disabled readOnly />
        ) : big ? (
          <textarea id={id("value")} className="code" rows={4} value={text} onChange={(e) => (setText(e.target.value), setProblem(null))} placeholder={type === "Array" ? '[1, "a"]' : '{"a": 1}'} spellCheck={false} autoCapitalize="none" aria-invalid={problem?.field === "value" || undefined} aria-describedby={problem?.field === "value" ? id("err") : undefined} />
        ) : (
          <input id={id("value")} className="mono" value={text} onChange={(e) => (setText(e.target.value), setProblem(null))} inputMode={type === "Number" ? "decimal" : undefined} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={type === "Date" ? "2026-10-30T17:48:12Z" : type === "ObjectId" ? "6ae4c8d2269f379558baa0b7" : type === "Number" ? "42.5" : "abc"} aria-invalid={problem?.field === "value" || undefined} aria-describedby={problem?.field === "value" ? id("err") : undefined} />
        )}
        {type === "Date" && <p className="help">ISO format. Without a time zone it is read as UTC.</p>}
      </div>
      {(problem || error) && (
        <p id={id("err")} className="error" role="alert">
          {problem?.text ?? error}
        </p>
      )}
      <div className="field-form-actions">
        {onCancel && (
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
