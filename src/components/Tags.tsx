import { client } from "../data";

/** Visible on every screen while the data is fake. */
export function SampleLabel() {
  if (!client.isSample) return null;
  return <span className="tag tag-sample">Sample data</span>;
}

/** Tags of a database as small chips. With `onPick` a chip filters the list by that tag. */
export function TagChips({ tags, max = 3, onPick }: { tags: string[]; max?: number; onPick?: (tag: string) => void }) {
  if (tags.length === 0) return <span className="muted">No tags</span>;
  const shown = tags.slice(0, max);
  return (
    <span className="chips">
      {shown.map((t) =>
        onPick ? (
          <button key={t} type="button" className="chip chip-btn" onClick={() => onPick(t)} aria-label={`Filter by tag ${t}`}>
            {t}
          </button>
        ) : (
          <span key={t} className="chip">
            {t}
          </span>
        ),
      )}
      {tags.length > max && <span className="chip chip-more" title={tags.slice(max).join(", ")}>+{tags.length - max}</span>}
    </span>
  );
}
