import type { ReactNode } from "react";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A number shown after the label (for example how many databases are in that state). */
  count?: number | string;
}

/** A row of buttons of which one is chosen (aria-pressed), for filters and ranges. `label` names the group. */
export function Segmented<T extends string>({ label, value, options, onChange, className }: { label: string; value: T; options: readonly SegmentOption<T>[]; onChange: (value: T) => void; className?: string }) {
  return (
    <div className={`seg${className ? ` ${className}` : ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="seg-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
