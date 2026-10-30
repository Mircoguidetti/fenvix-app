/** Initial and colours of an organization avatar. Pure functions: no React, so the unit tests can run them. */

/** The avatar of an organization: a black square with a white initial, like the rest of the dashboard. */
export const AVATAR_BG = "#0b1220";
export const AVATAR_FG = "#ffffff";

/** The first visible character of the name, upper-cased: a whole emoji or accented letter, never half of one. "W" for an empty name. */
export function workspaceInitial(name: string): string {
  const text = name.trim();
  if (!text) return "W";
  const first = firstGrapheme(text);
  return first.toLocaleUpperCase();
}

function firstGrapheme(text: string): string {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const { segment } of seg.segment(text)) return segment;
  }
  return Array.from(text)[0] ?? "";
}

/** Contrast ratio between two #rrggbb colours (WCAG 2.x). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
