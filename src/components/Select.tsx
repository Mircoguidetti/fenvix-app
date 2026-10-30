import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { labelOf, moveIndex, typeahead, type ListOption } from "../lib/listbox";

export type { ListOption } from "../lib/listbox";

interface SelectProps {
  /** The id a `<label htmlFor>` points at: the label names the select, as with a native one. */
  id?: string;
  value: string;
  options: readonly ListOption[];
  onChange(value: string): void;
  disabled?: boolean;
  /** "sm" is the 34px height used in card headers and table rows. */
  size?: "sm";
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

/**
 * The one select of the dashboard, in place of the browser's: a button showing the choice and a list under it
 * (WAI-ARIA select-only combobox). Focus stays on the button; arrows, Home, End, Page Up/Down and typing move the
 * highlight, Enter or Space picks, Escape closes, Tab picks and moves on. The list is fixed to the window, so a card
 * or a table that clips its content never cuts it off.
 */
export function Select({ id, value, options, onChange, disabled, size, className, "aria-label": ariaLabel, "aria-describedby": describedBy }: SelectProps) {
  const autoId = useId();
  const buttonId = id ?? `select-${autoId}`;
  const listId = `${buttonId}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<CSSProperties>({});
  const [name, setName] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const selected = options.findIndex((o) => o.value === value);

  function measure() {
    const r = button.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 180 && above > below;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 160) - 8));
    setPlace({
      left,
      minWidth: r.width,
      maxWidth: window.innerWidth - left - 8,
      maxHeight: Math.max(120, Math.min(320, up ? above : below)),
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  }

  function show(at: number) {
    if (disabled || options.length === 0) return;
    measure();
    setName(ariaLabel ?? button.current?.labels?.[0]?.textContent ?? "");
    setActive(at < 0 ? 0 : at);
    setOpen(true);
  }

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) button.current?.focus();
  }

  function pick(i: number, refocus = true) {
    const o = options[i];
    if (o?.disabled) return;
    close(refocus);
    if (o && o.value !== value) onChange(o.value);
  }

  // A click elsewhere closes it. Scrolling the page or resizing the window moves it with its button, and closes it
  // once the button is out of sight.
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !list.current?.contains(t)) close(false);
    };
    const moved = (e: Event) => {
      if (list.current?.contains(e.target as Node) || !button.current) return;
      const r = button.current.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) close(false);
      else measure();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [open]);

  // Keeps the highlighted option in view by scrolling the list only (scrollIntoView would scroll the page too).
  useLayoutEffect(() => {
    const ul = list.current;
    const li = ul?.children[active] as HTMLElement | undefined;
    if (!open || !ul || !li) return;
    if (li.offsetTop < ul.scrollTop) ul.scrollTop = li.offsetTop - 4;
    else if (li.offsetTop + li.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = li.offsetTop + li.offsetHeight - ul.clientHeight + 4;
  }, [open, active]);

  /** The index typing `key` jumps to; letters typed within half a second add up to one search. */
  function jump(key: string, from: number): number {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < 500 ? typed.current.text : "") + key, at: now };
    return typeahead(options, typed.current.text, from);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const letter = e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show(e.key === "ArrowUp" && selected < 0 ? options.length - 1 : selected);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        show(e.key === "Home" ? 0 : options.length - 1);
      } else if (letter) {
        const at = jump(e.key, selected);
        if (at >= 0) show(at);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // closes the list only, not the dialog around it
      close(true);
    } else if (e.key === "Enter" || e.key === " " || (e.key === "ArrowUp" && e.altKey)) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Tab") {
      pick(active, false);
    } else if (letter) {
      const at = jump(e.key, active);
      if (at >= 0) setActive(at);
    } else {
      const next = moveIndex(e.key, active, options.length);
      if (next !== null) {
        e.preventDefault();
        setActive(next);
      }
    }
  }

  return (
    <div className={["select", size === "sm" ? "select-sm" : "", className ?? ""].filter(Boolean).join(" ")}>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="select-btn"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (open ? close(true) : show(selected))}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{labelOf(options, value)}</span>
        <ChevronDown size={16} aria-hidden="true" className="select-chevron" />
      </button>
      {open && (
        <ul ref={list} id={listId} role="listbox" className="select-list" style={place} aria-label={name || undefined} tabIndex={-1}>
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === selected}
              aria-disabled={o.disabled || undefined}
              data-value={o.value}
              data-active={i === active ? "" : undefined}
              className="select-option"
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="select-value">{o.label}</span>
              {o.hint && <span className="select-hint mono">{o.hint}</span>}
              {i === selected && !o.hint && <Check size={15} aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
