import { useId, useMemo, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { Search } from "lucide-react";

/** The one search field of the dashboard: a magnifier, a light border, no browser clear button. */
export function SearchInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <div className="search">
      <Search size={16} aria-hidden="true" />
      <input type="search" autoComplete="off" spellCheck={false} {...props} />
    </div>
  );
}

interface SuggestProps {
  id: string;
  value: string;
  onChange(value: string): void;
  suggestions: readonly string[];
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * A text field with a list of matching suggestions under it, drawn like the select's list (in place of a browser
 * datalist). Typing filters it; arrows move, Enter takes the highlighted one, Escape closes it.
 */
export function SuggestInput({ id, value, onChange, suggestions, placeholder, invalid, describedBy }: SuggestProps) {
  const listId = `${id}-list${useId()}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const q = value.trim().toLowerCase();
  const matches = useMemo(() => suggestions.filter((s) => s.toLowerCase().includes(q) && s.toLowerCase() !== q).slice(0, 8), [suggestions, q]);
  const shown = open && matches.length > 0;

  function take(s: string) {
    onChange(s);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown) return (setOpen(true), setActive(e.key === "ArrowDown" ? 0 : matches.length - 1));
      const n = matches.length;
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === "Enter" && shown && active >= 0) {
      e.preventDefault();
      take(matches[active]);
    } else if (e.key === "Escape" && shown) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="suggest">
      <input
        id={id}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => (onChange(e.target.value), setOpen(true), setActive(-1))}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <ul id={listId} role="listbox" aria-label="Suggestions" className="select-list suggest-list">
          {matches.map((s, i) => (
            <li key={s} id={`${listId}-${i}`} role="option" aria-selected={i === active} data-active={i === active ? "" : undefined} className="select-option" onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => take(s)}>
              <span className="select-value">{s}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
