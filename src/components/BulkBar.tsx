import { useState } from "react";
import { Tag, X } from "lucide-react";
import { client } from "../data";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { parseTag } from "../lib/tags";
import { formatCount } from "../lib/format";

type Action = "add-tag" | "remove-tag";

const plural = (n: number) => `${formatCount(n)} ${n === 1 ? "database" : "databases"}`;

/** Actions for the selected databases. `onDone` clears the selection and reloads the list. */
export function BulkBar({ selected, matching, onSelectAll, onClear, onDone }: { selected: string[]; matching: number; onSelectAll: () => void; onClear: () => void; onDone: () => void }) {
  const toast = useToast();
  const [action, setAction] = useState<Action | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = selected.length;

  function close() {
    setAction(null);
    setInput("");
    setError(null);
    setBusy(false);
  }

  async function run(message: string, work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      toast(message);
      close();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Try again.");
      setBusy(false);
    }
  }

  function submitTag() {
    const trimmed = input.trim();
    if (action === "remove-tag" && trimmed && !trimmed.includes(":")) {
      if (!/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(trimmed)) return setError("Enter a tag key, or key:value.");
      return run(`Removed tag key ${trimmed.toLowerCase()} from ${plural(n)}`, () => client.removeTags(selected, [trimmed]));
    }
    const parsed = parseTag(input);
    if ("error" in parsed) return setError(parsed.error);
    if (action === "add-tag") return run(`Added tag ${parsed.tag} to ${plural(n)}`, () => client.addTags(selected, [parsed.tag]));
    return run(`Removed tag ${parsed.tag} from ${plural(n)}`, () => client.removeTags(selected, [parsed.tag]));
  }

  return (
    <div className="bulk-bar" role="region" aria-label="Bulk actions">
      <div className="bulk-count">
        <strong>{formatCount(n)} selected</strong>
        {n < matching && (
          <button type="button" className="btn btn-quiet" onClick={onSelectAll}>
            Select all {formatCount(matching)} matching
          </button>
        )}
      </div>
      <div className="row-actions">
        <button type="button" className="btn btn-sm" onClick={() => setAction("add-tag")}>
          <Tag size={15} aria-hidden="true" />
          Add tag
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setAction("remove-tag")}>
          Remove tag
        </button>
        <button type="button" className="btn btn-sm" onClick={onClear}>
          <X size={15} aria-hidden="true" />
          Clear selection
        </button>
      </div>

      <ConfirmDialog
        open={action === "add-tag" || action === "remove-tag"}
        title={action === "add-tag" ? `Add a tag to ${plural(n)}` : `Remove a tag from ${plural(n)}`}
        confirmLabel={action === "add-tag" ? "Add tag" : "Remove tag"}
        busy={busy}
        onConfirm={submitTag}
        onCancel={close}
      >
        <div className="field">
          <label htmlFor="bulk-tag">{action === "add-tag" ? "Tag (key:value)" : "Tag (key:value, or just the key)"}</label>
          <input id="bulk-tag" value={input} onChange={(e) => (setInput(e.target.value), setError(null))} placeholder="customer:acme-labs" autoComplete="off" autoFocus aria-invalid={error ? true : undefined} aria-describedby={error ? "bulk-tag-error" : undefined} />
          {error && (
            <p id="bulk-tag-error" className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        {action === "add-tag" && <p className="small muted">A database keeps one value per key, so an existing value for this key is replaced.</p>}
      </ConfirmDialog>
    </div>
  );
}
