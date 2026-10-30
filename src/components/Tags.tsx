/** Tags of a database as small chips. With `onPick` a chip filters the list by that tag. */
import { PHONE, useMedia } from "../lib/useMedia";

export function TagChips({ tags, max: maxWanted = 2, onPick }: { tags: string[]; max?: number; onPick?: (tag: string) => void }) {
  // On a phone every tag is shown: a "+2" button would be a small target, and the tags have room to wrap.
  const phone = useMedia(PHONE);
  const max = phone ? tags.length : maxWanted;
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
          <button type="button" className="chip chip-more" aria-label={`All tags: ${tags.join(", ")}`}>
            +{rest.length}
          </button>
          <span className="chip-pop" role="presentation">
            {tags.map((t) => (
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
