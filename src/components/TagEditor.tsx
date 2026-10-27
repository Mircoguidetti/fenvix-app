import { useState, type FormEvent } from "react";
import { Pencil, X } from "lucide-react";
import { client, type Database } from "../data";
import { useToast } from "./Toast";
import { mergeTags, parseTag, sortTags, splitTag } from "../lib/tags";

/** Add, edit and remove the tags of one database. */
export function TagEditor({ db, onChanged }: { db: Database; onChanged: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: string[], message: string) {
    setBusy(true);
    try {
      await client.setTags(db.id, next);
      toast(message);
      setError(null);
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the tags.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const parsed = parseTag(draft);
    if ("error" in parsed) return setError(parsed.error);
    const replaced = db.tags.some((t) => splitTag(t).key === splitTag(parsed.tag).key);
    if (await save(mergeTags(db.tags, [parsed.tag]), replaced ? `Updated tag ${parsed.tag}` : `Added tag ${parsed.tag}`)) setDraft("");
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseTag(editDraft);
    if ("error" in parsed) return setError(parsed.error);
    const rest = db.tags.filter((t) => t !== editing);
    if (await save(mergeTags(rest, [parsed.tag]), `Changed ${editing} to ${parsed.tag}`)) setEditing(null);
  }

  return (
    <div className="stack wide">
      {db.tags.length === 0 ? (
        <p className="muted">This database has no tags yet.</p>
      ) : (
        <ul className="tag-list">
          {sortTags(db.tags).map((t) =>
            editing === t ? (
              <li key={t}>
                <form onSubmit={saveEdit} className="row-actions" noValidate>
                  <label className="sr-only" htmlFor="tag-edit">
                    Edit tag {t}
                  </label>
                  <input id="tag-edit" value={editDraft} onChange={(e) => (setEditDraft(e.target.value), setError(null))} autoComplete="off" autoFocus className="tag-input" />
                  <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
                    Save tag
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => (setEditing(null), setError(null))}>
                    Cancel
                  </button>
                </form>
              </li>
            ) : (
              <li key={t} className="chip chip-lg">
                <span>{t}</span>
                <button type="button" onClick={() => (setEditing(t), setEditDraft(t), setError(null))} aria-label={`Edit tag ${t}`}>
                  <Pencil size={13} aria-hidden="true" />
                </button>
                <button type="button" disabled={busy} onClick={() => save(db.tags.filter((x) => x !== t), `Removed tag ${t}`)} aria-label={`Remove tag ${t}`}>
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      <form onSubmit={add} className="inline-form" noValidate>
        <div className="field grow">
          <label htmlFor="tag-add">Add a tag</label>
          <input id="tag-add" value={draft} onChange={(e) => (setDraft(e.target.value), setError(null))} placeholder="customer:acme-labs" autoComplete="off" aria-invalid={error ? true : undefined} aria-describedby={error ? "tag-error" : undefined} />
        </div>
        <button type="submit" className="btn" disabled={busy}>
          Add tag
        </button>
      </form>
      {error && (
        <p id="tag-error" className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted small">Tags are key:value pairs. A database keeps one value per key, so adding customer:other replaces the old customer value.</p>
    </div>
  );
}
