/** Tags of a database as small chips. With `onPick` a chip filters the list by that tag. */
export function TagChips({ tags, max = 2, onPick }: { tags: string[]; max?: number; onPick?: (tag: string) => void }) {
  if (tags.length === 0) return <span className="muted">No tags</span>;
  const shown = tags.slice(0, max);
  const rest = tags.slice(max);
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
      {rest.length > 0 && (
        <span className="chip-rest">
          <button type="button" className="chip chip-more" aria-label={`${rest.length} more tags: ${rest.join(", ")}`}>
            +{rest.length}
          </button>
          <span className="chip-pop" role="presentation">
            {rest.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}
