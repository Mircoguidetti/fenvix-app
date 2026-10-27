import type { UsageRow } from "./types";

/** A download link for text the browser builds itself. */
export function blobUrl(content: string, type: string): string {
  return URL.createObjectURL(new Blob([content], { type }));
}

const csvCell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** The usage CSV: one row per database or per tag, header first, UTF-8 and \n line ends. */
export function usageCsv(rows: UsageRow[], by: "database" | "tag"): string {
  const head = by === "database" ? "database,tags,storage_gb_avg,requests" : "tag,databases,storage_gb_avg,requests";
  const lines = rows.map((r) => (by === "database" ? [r.name, r.tags.join(" "), r.storageGb, r.requests] : [r.name, r.databases, r.storageGb, r.requests]).map(csvCell).join(","));
  return [head, ...lines].join("\n") + "\n";
}

export function usageCsvName(month: string, by: "database" | "tag", tagKey?: string): string {
  return `fenvix-usage-${month}-${by === "database" ? "databases" : tagKey ? `by-${tagKey}` : "tags"}.csv`;
}
