export function formatStorage(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  return `${mb} MB`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function formatCompact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatMoney(n: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
}

export function formatRelative(iso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** 0.973 → "97%". Under 1% and above 99% keep one decimal, so 0.4% never reads as 0%. */
export function formatPercent(share: number): string {
  const p = share * 100;
  if (p > 0 && p < 1) return `${p.toFixed(1)}%`;
  if (p > 99 && p < 100) return `${Math.floor(p * 10) / 10}%`;
  return `${Math.round(p)}%`;
}

/** Milliseconds as "850 ms", "42 s", "3 min 05 s" or "1 h 02 min". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Minutes with one decimal under 100, whole above: "8.8 min", "1,240 min". */
export function formatMinutes(min: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: min < 100 ? 1 : 0 }).format(min)} min`;
}

/** Seven characters of a commit SHA, as GitHub shows it. */
export const shortSha = (sha: string) => sha.slice(0, 7);

/** A price: whole dollars without cents ("$1,350"), cents only when there are some. */
export function formatPrice(n: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
}
