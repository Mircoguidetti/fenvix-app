// Builds the five second-colour kits (kits/*.css) and their contrast table (contrast.json, CONTRAST.md).
// Each direction is a hue and a chroma in OKLCH; every token is found by searching the lightness that gives a target
// contrast against the surface it sits on, then every pairing below is measured again from the final hex values.
// Usage: node second-colour/2026-11-27/palette.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- colour maths (OKLCH -> sRGB, WCAG 2 contrast)
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function oklchToRgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
function oklch(L, C, h) {
  let c = C, rgb = oklchToRgb(L, c, h);
  while (!inGamut(rgb) && c > 0) { c = Math.max(0, c - 0.002); rgb = oklchToRgb(L, c, h); }
  return "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, toGam(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, "0")).join("");
}
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const lum = (hex) => { const [r, g, b] = rgbOf(hex).map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (hex, alpha, base) => "#" + rgbOf(hex).map((v, i) => Math.round((v * alpha + rgbOf(base)[i] * (1 - alpha)) * 255).toString(16).padStart(2, "0")).join("");
const rgba = (hex, a) => `rgba(${rgbOf(hex).map((v) => Math.round(v * 255)).join(", ")}, ${a})`;
// Lightness giving `target` contrast against `against`; `side` "dark" searches below it, "light" above.
function fit(target, against, C, h, side) {
  let lo = side === "dark" ? 0 : 0.0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2, r = ratio(oklch(mid, C, h), against);
    const darker = lum(oklch(mid, C, h)) < lum(against);
    if (side === "dark") { if (!darker || r < target) hi = mid; else lo = mid; } else { if (darker || r < target) lo = mid; else hi = mid; }
  }
  return oklch(side === "dark" ? lo : hi, C, h);
}

// ---- fixed colours that stay (src/styles.css)
const L = { bg: "#ffffff", page: "#f6f6f7", nav: "#fbfbfc", text: "#06080e", cobalt: "#0d4fa3", lead: "#5f636b", muted: "#5f636b" };
const D = { bg: "#0d1321", surface: "#10182b", nav: "#06080e", text: "#f6f6f7", silver2: "#1f2b47" };

// ---- the five directions
const DIRECTIONS = [
  { letter: "A", name: "slate", title: "Slate", hue: 255, chroma: 0.04, intent: "The same blue family, with most of the colour taken out: a grey-blue that sits back and lets the cobalt be the only real blue." },
  { letter: "B", name: "glacier", title: "Glacier", hue: 232, chroma: 0.07, intent: "A cooler, clearer blue leaning towards cyan: still blue, but cleaner and more technical than today's periwinkle." },
  { letter: "C", name: "iris", title: "Iris", hue: 290, chroma: 0.11, intent: "A muted violet: a real second colour, not blue, that stays cool and calm next to the ink and the cobalt." },
  { letter: "D", name: "stone", title: "Stone", hue: 75, chroma: 0.022, intent: "A warm, sandy grey: the cool ink and cobalt set against a quiet paper warmth, like a printed page." },
  { letter: "E", name: "graphite", title: "Graphite", hue: 255, chroma: 0.006, intent: "No second colour at all: neutral greys carry selection and the second chart line, so cobalt is the one accent." },
];

function build(d) {
  const { hue: h, chroma: C } = d;
  const tintC = Math.min(C, 0.03) * 0.8;
  const t = {};
  // light
  t.l = {
    "nav-active": fit(1.13, L.bg, tintC, h, "dark"),
    "ink-2": fit(3.4, L.bg, C, h, "dark"),
    "ink-3": fit(1.42, L.bg, C * 0.45, h, "dark"),
    "stack-1": fit(5.6, L.bg, C, h, "dark"),
    "stack-2": fit(4.4, L.bg, C, h, "dark"),
    "stack-3": fit(3.6, L.bg, C, h, "dark"),
    "stack-4": fit(3.05, L.bg, C, h, "dark"),
    "signin-1": fit(1.045, L.bg, tintC * 0.8, h, "dark"),
    "signin-2": fit(1.1, L.bg, tintC, h, "dark"),
    "signin-3": fit(1.17, L.bg, tintC * 1.2, h, "dark"),
  };
  // dark
  const tone = fit(5.2, D.nav, C, h, "light"); // the colour of the menu tints, used at 10 % and 20 %
  t.d = {
    chart: fit(10.5, D.bg, C * 0.8, h, "light"),
    "nav-tone": tone,
    "ink-2": fit(3.4, D.bg, C, h, "light"),
    "silver-1": fit(2.6, D.bg, C, h, "light"),
    "silver-3": fit(6.0, D.bg, C, h, "light"),
    "stack-0": fit(14, D.bg, C * 0.5, h, "light"),
    "stack-1": fit(9.5, D.bg, C * 0.8, h, "light"),
    "stack-2": fit(6.2, D.bg, C, h, "light"),
    "stack-3": fit(4.2, D.bg, C, h, "light"),
    "stack-4": fit(3.05, D.bg, C, h, "light"),
    "nav-label": fit(6.0, D.bg, C * 0.6, h, "light"),
  };
  return t;
}

const REF = {
  l: { "nav-active": "#e6eef9", "ink-2": "#6f9bd8", "ink-3": "#c9d8ef", "stack-1": "#3f72bd", "stack-2": "#7199d3", "stack-3": "#a3bfe5", "stack-4": "#cfdcf0", "signin-1": "#f3f6fb", "signin-2": "#e5edf8", "signin-3": "#d8e4f4" },
  d: { chart: "#b6c6ed", "nav-tone": "#6e91e6", "ink-2": "#4262ae", "silver-1": "#4560a1", "silver-3": "#819bda", "stack-0": "#dae1f1", "stack-1": "#a6b7dd", "stack-2": "#728dca", "stack-3": "#4364b1", "stack-4": "#30477e", "nav-label": "#8898bf" },
};

// Every pairing measured: [label, kind, foreground, background]; kind "text" needs 4.5, "ui" needs 3.
function checks(t) {
  const hoverL = over(t.d["nav-tone"], 0.1, D.nav), activeL = over(t.d["nav-tone"], 0.2, D.nav);
  const activeSub = over(t.d["nav-tone"], 0.2, D.bg);
  const rows = [
    ["Light: selected item text (cobalt) on --nav-active", "text", L.cobalt, t.l["nav-active"]],
    ["Light: tab / segment text (ink) on --nav-active", "text", L.text, t.l["nav-active"]],
    ["Light: --ink-2 dashed line, hover border, on card", "ui", t.l["ink-2"], L.bg],
    ["Light: --ink-2 on page", "ui", t.l["ink-2"], L.page],
    ["Light: bar fill (cobalt) on --ink-3 track", "ui", L.cobalt, t.l["ink-3"]],
    ...[1, 2, 3, 4].map((i) => [`Light: --stack-${i} bar segment on card`, "ui", t.l[`stack-${i}`], L.bg]),
    ["Light: sign-in title (ink) on darkest gradient stop", "text", L.text, t.l["signin-3"]],
    ["Light: sign-in lead (#5f636b) on darkest gradient stop", "text", L.lead, t.l["signin-3"]],
    ["Dark: --chart line and bars on card", "ui", t.d.chart, D.bg],
    ["Dark: --chart on surface", "ui", t.d.chart, D.surface],
    ["Dark: menu text on --nav-hover (rail)", "text", D.text, hoverL],
    ["Dark: menu text on --nav-active (rail)", "text", D.text, activeL],
    ["Dark: menu text on --nav-active (second bar)", "text", D.text, activeSub],
    ["Dark: --ink-2 dashed line on card", "ui", t.d["ink-2"], D.bg],
    ["Dark: --silver-3 current-plan border on card", "ui", t.d["silver-3"], D.bg],
    ...[0, 1, 2, 3, 4].map((i) => [`Dark: --stack-${i} bar segment on card`, "ui", t.d[`stack-${i}`], D.bg]),
    ["Dark: --nav-label text on rail", "text", t.d["nav-label"], D.nav],
    ["Dark: --nav-label text on second bar", "text", t.d["nav-label"], D.bg],
  ];
  return rows.map(([label, kind, fg, bg]) => ({ label, kind, fg, bg, ratio: Math.round(ratio(fg, bg) * 100) / 100, pass: ratio(fg, bg) >= (kind === "text" ? 4.5 : 3) }));
}

function css(d, t) {
  const l = t.l, k = t.d;
  const darkVars = `--nav-label: ${k["nav-label"]}; --nav-hover: ${rgba(k["nav-tone"], 0.1)}; --nav-active: ${rgba(k["nav-tone"], 0.2)}; --ink-2: ${k["ink-2"]}; --chart: ${k.chart}; --silver-1: ${k["silver-1"]}; --silver-3: ${k["silver-3"]}; --stack-0: ${k["stack-0"]}; --stack-1: ${k["stack-1"]}; --stack-2: ${k["stack-2"]}; --stack-3: ${k["stack-3"]}; --stack-4: ${k["stack-4"]};`;
  return `/* Direction ${d.letter}, ${d.title}: ${d.intent}
   Replaces only the light-blue second colour (see ../TOKENS.md). Cobalt #0d4fa3, the near-night blues, greys, status
   colours, fonts and layout are unchanged. Generated by ../palette.mjs; injected by ../shots.mjs, never loaded by src/. */
:root { --nav-active: ${l["nav-active"]}; --ink-2: ${l["ink-2"]}; --ink-3: ${l["ink-3"]}; --stack-1: ${l["stack-1"]}; --stack-2: ${l["stack-2"]}; --stack-3: ${l["stack-3"]}; --stack-4: ${l["stack-4"]}; }
:root[data-theme="dark"] { ${darkVars} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${darkVars} } }
.signin-hero { background: radial-gradient(70% 46% at 50% 104%, rgba(13, 79, 163, 0.2), rgba(13, 79, 163, 0) 70%), linear-gradient(180deg, #ffffff 0%, #ffffff 40%, ${l["signin-1"]} 60%, ${l["signin-2"]} 80%, ${l["signin-3"]} 100%); }
`;
}

const out = { reference: { tokens: REF, checks: checks(REF) }, directions: [] };
for (const d of DIRECTIONS) {
  const t = build(d);
  writeFileSync(join(HERE, "kits", `${d.letter.toLowerCase()}-${d.name}.css`), css(d, t));
  out.directions.push({ ...d, tokens: t, checks: checks(t) });
}
writeFileSync(join(HERE, "contrast.json"), JSON.stringify(out, null, 2) + "\n");

let md = "# Contrast, per direction\n\nGenerated by `node second-colour/2026-11-27/palette.mjs`. Bars: text 4.5:1, non-text UI 3:1 (WCAG 2.2, 1.4.3 and 1.4.11). Tints are measured with the text that sits on them; dark menu tints are composited at their alpha over the bar they sit on.\n\n";
const all = [["Today (reference)", out.reference.checks], ...out.directions.map((d) => [`${d.letter}, ${d.title}`, d.checks])];
md += `| Pairing | Bar | ${all.map(([n]) => n).join(" | ")} |\n|---|---|${all.map(() => "---|").join("")}\n`;
for (let i = 0; i < out.reference.checks.length; i++) {
  const r = out.reference.checks[i];
  md += `| ${r.label} | ${r.kind === "text" ? "4.5" : "3.0"} | ${all.map(([, c]) => `${c[i].ratio.toFixed(2)}${c[i].pass ? "" : " FAIL"}`).join(" | ")} |\n`;
}
const fails = out.directions.flatMap((d) => d.checks.filter((c) => !c.pass).map((c) => `${d.letter}: ${c.label} ${c.ratio}`));
md += `\nDirections failing a bar: ${fails.length ? fails.join("; ") : "none"}. Reference failures: ${out.reference.checks.filter((c) => !c.pass).map((c) => `${c.label} ${c.ratio}`).join("; ") || "none"}.\n`;
writeFileSync(join(HERE, "CONTRAST.md"), md);
console.log(md);
