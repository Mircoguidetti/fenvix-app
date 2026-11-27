// Round 2: six red-orange accents that replace cobalt (and the light blue around it). Builds kits/*.css, contrast.json,
// CONTRAST.md and STATUS.md (OKLCH distance of each accent to the danger and warning colours, and the adjusted status
// colours where a direction is too close). Usage: node second-colour/2026-11-27-r2/palette.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- colour maths
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function oklchToLin(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = (v) => v.every((x) => x >= -1e-4 && x <= 1 + 1e-4);
function oklch(L, C, h) {
  let c = C, v = oklchToLin(L, c, h);
  while (!inGamut(v) && c > 0) { c = Math.max(0, c - 0.002); v = oklchToLin(L, c, h); }
  return "#" + v.map((x) => Math.round(toGam(Math.min(1, Math.max(0, x))) * 255).toString(16).padStart(2, "0")).join("");
}
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
function toOklch(hex) {
  const [r, g, b] = rgbOf(hex).map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360, A, B };
}
const lum = (hex) => { const [r, g, b] = rgbOf(hex).map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (hex, alpha, base) => "#" + rgbOf(hex).map((v, i) => Math.round((v * alpha + rgbOf(base)[i] * (1 - alpha)) * 255).toString(16).padStart(2, "0")).join("");
const rgba = (hex, a) => `rgba(${rgbOf(hex).map((v) => Math.round(v * 255)).join(", ")}, ${a})`;
function fit(target, against, C, h, side) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2, c = oklch(mid, C, h), r = ratio(c, against), darker = lum(c) < lum(against);
    if (side === "dark") { if (!darker || r < target) hi = mid; else lo = mid; } else { if (darker || r < target) lo = mid; else hi = mid; }
  }
  return oklch(side === "dark" ? lo : hi, C, h);
}
function dist(a, b) {
  const x = toOklch(a), y = toOklch(b);
  const dh = Math.abs(((x.h - y.h + 540) % 360) - 180);
  return { dh: Math.round(dh), dL: Math.round(Math.abs(x.L - y.L) * 100) / 100, dE: Math.round(Math.hypot(x.L - y.L, x.A - y.A, x.B - y.B) * 1000) / 1000 };
}

// ---- what stays
const L = { bg: "#ffffff", page: "#f6f6f7", text: "#06080e", lead: "#5f636b", danger: "#d6140a", warning: "#9c5900", success: "#067a3a" };
const D = { bg: "#0d1321", surface: "#10182b", nav: "#06080e", text: "#f6f6f7", danger: "#ff6a5c", warning: "#ffb020", success: "#3ddc84" };

// ---- six directions. accent: hue/chroma of the accent; text: contrast of the accent used as text (nav-on) on white;
// chart: contrast of the chart colour on white (lighter = more colour); dark: contrast of the dark chart colour;
// neutral: hue/chroma of the tints (selected item, track, sky) when they are not the accent's own.
const DIRECTIONS = [
  { letter: "A", name: "vermilion", title: "Vermilion", h: 30, C: 0.23, text: 5.2, chart: 4.4, dark: 6.0, tintC: 0.012, tint: 1.08, intent: "A saturated red-orange on almost-white tints: the most signal-like of the six, every mark of the accent reads strongly." },
  { letter: "B", name: "coral", title: "Coral", h: 22, C: 0.1, text: 5.6, chart: 3.3, dark: 8.5, tintC: 0.05, tint: 1.2, intent: "A soft, pastel pink-orange with a clearly tinted selection: light and friendly rather than loud." },
  { letter: "C", name: "burnt-orange", title: "Burnt orange", h: 56, C: 0.14, text: 6.3, chart: 6.3, dark: 6.5, intent: "An earthy, dark orange close to copper: confident and grounded, a material rather than a signal." },
  { letter: "D", name: "amber", title: "Amber orange", h: 70, C: 0.16, text: 5.2, chart: 3.3, dark: 10, intent: "A golden orange that stays bright in charts and the dark theme, with a deep amber for text." },
  { letter: "E", name: "rust", title: "Rust", h: 38, C: 0.11, text: 7.5, chart: 7.5, dark: 5.0, intent: "A deep, muted brick: quiet and serious, the darkest of the six, reads almost as a warm ink." },
  { letter: "F", name: "ember", title: "Tangerine on sand", h: 47, C: 0.2, text: 5.2, chart: 3.3, dark: 7.5, neutral: { h: 85, C: 0.014 }, tint: 1.14, intent: "A bright, clean orange on beige-grey sand neutrals for tints and tracks: the warmest overall feel." },
];

// Status colours proposed when a direction sits too close (crimson danger, ochre warning).
const ADJUST = {
  danger: { l: oklch(0.5, 0.2, 12), d: null },
  warning: { l: null, d: null },
};
ADJUST.danger.l = fit(7.0, L.bg, 0.2, 10, "dark");
ADJUST.danger.d = fit(5.0, D.bg, 0.19, 4, "light");
ADJUST.warning.l = fit(5.6, L.bg, 0.12, 96, "dark");
ADJUST.warning.d = fit(11, D.bg, 0.16, 98, "light");
const TOO_CLOSE = (d) => d.dE < 0.1 || (d.dh < 14 && d.dL < 0.12);

function build(d) {
  const { h, C } = d;
  const n = d.neutral ?? { h, C: d.tintC ?? Math.min(C * 0.18, 0.035) };
  const accent = fit(d.text, L.bg, C, h, "dark");
  let chart = fit(Math.max(d.chart, d.chartMin ?? 0), L.bg, C, h, "dark");
  const t = { l: {}, d: {} };
  t.l = {
    accent, chart,
    "nav-active": fit(d.tint ?? 1.12, L.bg, n.C * 1.1, n.h, "dark"),
    "ink-2": fit(3.4, L.bg, C * 0.75, h, "dark"),
    "ink-3": fit(Math.max(1.06, Math.min(1.4, ratio(chart, L.bg) / 3.15)), L.bg, n.C * 1.3, n.h, "dark"),
    "stack-1": fit(Math.max(3.3, ratio(chart, L.bg) * 0.8), L.bg, C * 0.8, h + 4, "dark"),
    "stack-2": fit(Math.max(3.2, ratio(chart, L.bg) * 0.65), L.bg, C * 0.6, h + 8, "dark"),
    "stack-3": fit(3.1, L.bg, C * 0.42, h + 12, "dark"),
    "stack-4": fit(3.03, L.bg, d.neutral ? 0.02 : C * 0.22, d.neutral ? n.h : h + 16, "dark"),
    "signin-1": fit(1.045, L.bg, n.C * 0.8, n.h, "dark"),
    "signin-2": fit(1.1, L.bg, n.C, n.h, "dark"),
    "signin-3": fit(1.18, L.bg, n.C * 1.25, n.h, "dark"),
  };
  // The stack ramp keeps the same order as today (0 darkest), so --stack-0 is the accent.
  const dk = fit(d.dark, D.bg, C * 0.85, h, "light");
  t.d = {
    chart: dk,
    "nav-tone": fit(5.0, D.nav, C * 0.7, h, "light"),
    "ink-2": fit(3.4, D.bg, C * 0.6, h, "light"),
    "silver-1": fit(2.4, D.bg, C * 0.7, h, "light"),
    "silver-3": fit(Math.min(d.dark, 6.5), D.bg, C * 0.8, h, "light"),
    "stack-0": fit(Math.max(d.dark, 11), D.bg, C * 0.45, h, "light"),
    "stack-1": fit(Math.min(Math.max(d.dark, 8.5), 9), D.bg, C * 0.7, h + 4, "light"),
    "stack-2": fit(6.0, D.bg, C * 0.75, h + 8, "light"),
    "stack-3": fit(4.2, D.bg, C * 0.7, h + 12, "light"),
    "stack-4": fit(3.05, D.bg, C * 0.55, h + 16, "light"),
  };
  // status distances, and the status colours this direction would use
  const s = {
    lDanger: dist(accent, L.danger), lDangerChart: dist(chart, L.danger), lWarning: dist(accent, L.warning), lWarningChart: dist(chart, L.warning),
    dDanger: dist(dk, D.danger), dWarning: dist(dk, D.warning),
  };
  const dangerClose = [s.lDanger, s.lDangerChart, s.dDanger].some(TOO_CLOSE);
  const warningClose = [s.lWarning, s.lWarningChart, s.dWarning].some(TOO_CLOSE);
  // Danger moves to a deeper, purer crimson at least ~24 degrees below the accent; warning to an ochre ~32 above it.
  const dh = Math.min(10, h - 24), wh = Math.min(104, Math.max(92, h + 32));
  const adj = { danger: fit(7.0, L.bg, 0.2, dh, "dark"), dangerDark: fit(5.0, D.bg, 0.19, dh - 4, "light"), warning: fit(5.6, L.bg, 0.12, wh, "dark"), warningDark: fit(11, D.bg, 0.16, wh + 2, "light") };
  t.status = {
    danger: dangerClose ? adj.danger : L.danger, dangerDark: dangerClose ? adj.dangerDark : D.danger,
    warning: warningClose ? adj.warning : L.warning, warningDark: warningClose ? adj.warningDark : D.warning,
    dangerClose, warningClose,
  };
  if (dangerClose) Object.assign(s, { lDangerNew: dist(accent, t.status.danger), lDangerChartNew: dist(chart, t.status.danger), dDangerNew: dist(dk, t.status.dangerDark) });
  if (warningClose) Object.assign(s, { lWarningNew: dist(accent, t.status.warning), lWarningChartNew: dist(chart, t.status.warning), dWarningNew: dist(dk, t.status.warningDark) });
  t.dist = s;
  return t;
}

const REF = {
  l: { accent: "#0d4fa3", chart: "#0d4fa3", "nav-active": "#e6eef9", "ink-2": "#6f9bd8", "ink-3": "#c9d8ef", "stack-1": "#3f72bd", "stack-2": "#7199d3", "stack-3": "#a3bfe5", "stack-4": "#cfdcf0", "signin-1": "#f3f6fb", "signin-2": "#e5edf8", "signin-3": "#d8e4f4" },
  d: { chart: "#b6c6ed", "nav-tone": "#6e91e6", "ink-2": "#4262ae", "silver-1": "#4560a1", "silver-3": "#819bda", "stack-0": "#dae1f1", "stack-1": "#a6b7dd", "stack-2": "#728dca", "stack-3": "#4364b1", "stack-4": "#30477e" },
  status: { danger: L.danger, dangerDark: D.danger, warning: L.warning, warningDark: D.warning },
};

function checks(t) {
  const st = t.status;
  const rows = [
    ["Light: selected item text (accent) on --nav-active", "text", t.l.accent, t.l["nav-active"]],
    ["Light: accent text on page", "text", t.l.accent, L.page],
    ["Light: tab text (ink) on --nav-active", "text", L.text, t.l["nav-active"]],
    ["Light: --chart lines and bars on card", "ui", t.l.chart, L.bg],
    ["Light: --chart on page", "ui", t.l.chart, L.page],
    ["Light: --ink-2 dashed line on card", "ui", t.l["ink-2"], L.bg],
    ["Light: bar fill (--chart) on --ink-3 track", "ui", t.l.chart, t.l["ink-3"]],
    ...[1, 2, 3, 4].map((i) => [`Light: --stack-${i} segment on card`, "ui", t.l[`stack-${i}`], L.bg]),
    ["Light: sign-in lead (#5f636b) on darkest sky stop", "text", L.lead, t.l["signin-3"]],
    ["Light: danger text on card", "text", st.danger, L.bg],
    ["Light: warning text on card", "text", st.warning, L.bg],
    ["Dark: --chart on card", "ui", t.d.chart, D.bg],
    ["Dark: --chart on surface", "ui", t.d.chart, D.surface],
    ["Dark: menu text on --nav-active (rail)", "text", D.text, over(t.d["nav-tone"], 0.2, D.nav)],
    ["Dark: menu text on --nav-active (second bar)", "text", D.text, over(t.d["nav-tone"], 0.2, D.bg)],
    ["Dark: --ink-2 dashed line on card", "ui", t.d["ink-2"], D.bg],
    ["Dark: --silver-3 plan border on card", "ui", t.d["silver-3"], D.bg],
    ...[0, 1, 2, 3, 4].map((i) => [`Dark: --stack-${i} segment on card`, "ui", t.d[`stack-${i}`], D.bg]),
    ["Dark: danger text on card", "text", st.dangerDark, D.bg],
    ["Dark: warning text on card", "text", st.warningDark, D.bg],
  ];
  return rows.map(([label, kind, fg, bg]) => ({ label, kind, fg, bg, ratio: Math.round(ratio(fg, bg) * 100) / 100, pass: ratio(fg, bg) >= (kind === "text" ? 4.5 : 3) }));
}

function css(d, t) {
  const l = t.l, k = t.d, st = t.status;
  const a = l.accent, c = l.chart;
  const dark = `--chart: ${k.chart}; --nav-hover: ${rgba(k["nav-tone"], 0.1)}; --nav-active: ${rgba(k["nav-tone"], 0.2)}; --ink-2: ${k["ink-2"]}; --silver-1: ${k["silver-1"]}; --silver-3: ${k["silver-3"]}; --stack-0: ${k["stack-0"]}; --stack-1: ${k["stack-1"]}; --stack-2: ${k["stack-2"]}; --stack-3: ${k["stack-3"]}; --stack-4: ${k["stack-4"]};${st.dangerClose ? ` --danger: ${st.dangerDark}; --danger-on-dark: ${st.dangerDark};` : ""}${st.warningClose ? ` --warning: ${st.warningDark}; --warning-on-dark: ${st.warningDark};` : ""}`;
  return `/* Round 2, direction ${d.letter}, ${d.title}: ${d.intent}
   Replaces the accent (cobalt #0d4fa3 and the light blue around it). The near-night blues, greys, fonts and layout are
   unchanged.${st.dangerClose || st.warningClose ? ` The accent sits too close to ${[st.dangerClose && "danger", st.warningClose && "warning"].filter(Boolean).join(" and ")}, so this kit also moves ${st.dangerClose && st.warningClose ? "both status colours" : "that status colour"} (see ../STATUS.md).` : ""}
   Generated by ../palette.mjs; injected by ../shots.mjs, never loaded by src/. */
:root { --nav-on: ${a}; --chart: ${c}; --chart-fill: ${rgba(c, 0.06)}; --area-1: ${c}; --area-2: ${c}; --focus: 0 0 0 3px ${rgba(a, 0.2)}; --nav-active: ${l["nav-active"]}; --ink-2: ${l["ink-2"]}; --ink-3: ${l["ink-3"]}; --stack-0: ${c}; --stack-1: ${l["stack-1"]}; --stack-2: ${l["stack-2"]}; --stack-3: ${l["stack-3"]}; --stack-4: ${l["stack-4"]};${st.dangerClose ? ` --danger: ${st.danger};` : ""}${st.warningClose ? ` --warning: ${st.warning};` : ""} }
:root[data-theme="dark"] { ${dark} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }
.spark-area { fill: var(--chart-fill); }
.chart-area { fill: var(--chart-fill); }
.signin-hero { background: radial-gradient(70% 46% at 50% 104%, ${rgba(c, 0.2)}, ${rgba(c, 0)} 70%), linear-gradient(180deg, #ffffff 0%, #ffffff 40%, ${l["signin-1"]} 60%, ${l["signin-2"]} 80%, ${l["signin-3"]} 100%); }
.signin-hero::before { background-image: conic-gradient(from 270deg at 1.2px 1.2px, ${rgba(c, 0.42)} 25%, ${rgba(c, 0)} 0); }
`;
}

const out = { reference: { tokens: REF, checks: checks(REF), dist: { lDanger: dist(REF.l.accent, L.danger), lWarning: dist(REF.l.accent, L.warning), dDanger: dist(REF.d.chart, D.danger), dWarning: dist(REF.d.chart, D.warning) } }, directions: [], adjust: ADJUST };
for (const d of DIRECTIONS) {
  const t = build(d);
  writeFileSync(join(HERE, "kits", `${d.letter.toLowerCase()}-${d.name}.css`), css(d, t));
  out.directions.push({ letter: d.letter, name: d.name, title: d.title, intent: d.intent, oklch: { h: d.h, C: d.C }, tokens: t, checks: checks(t) });
}
writeFileSync(join(HERE, "contrast.json"), JSON.stringify(out, null, 2) + "\n");

let md = "# Contrast, round 2\n\nGenerated by `node second-colour/2026-11-27-r2/palette.mjs`. Text 4.5:1, non-text UI 3:1. Dark menu tints are blended at 20 % over the bar behind them. Danger and warning rows use the status colours each direction would ship with (see STATUS.md).\n\n";
const all = [["Today", out.reference.checks], ...out.directions.map((d) => [`${d.letter} ${d.title}`, d.checks])];
md += `| Pairing | Bar | ${all.map(([n]) => n).join(" | ")} |\n|---|---|${all.map(() => "---|").join("")}\n`;
out.reference.checks.forEach((r, i) => { md += `| ${r.label} | ${r.kind === "text" ? "4.5" : "3.0"} | ${all.map(([, c]) => `${c[i].ratio.toFixed(2)}${c[i].pass ? "" : " FAIL"}`).join(" | ")} |\n`; });
const fails = out.directions.flatMap((d) => d.checks.filter((c) => !c.pass).map((c) => `${d.letter}: ${c.label} ${c.ratio}`));
md += `\nDirections failing a bar: ${fails.length ? fails.join("; ") : "none"}.\n`;
writeFileSync(join(HERE, "CONTRAST.md"), md);

const f = (x) => `Δh ${x.dh}°, ΔL ${x.dL.toFixed(2)}, ΔE ${x.dE.toFixed(3)}`;
let sm = `# Accent vs status colours, round 2\n\nOKLCH distances (hue in degrees, lightness 0–1, ΔE = Euclidean OKLab). "Too close" = ΔE < 0.10, or hue within 14° and lightness within 0.12. Status today: danger ${L.danger} (dark ${D.danger}), warning ${L.warning} (dark ${D.warning}). Proposed when too close: danger moves to a deeper, purer crimson at least about 24° of hue below the accent (7:1 on white); warning moves to a yellower ochre about 32° above it (hues 92–104°, kept clear of the green success colour near 150°). The exact values per direction are in the last column. Failed and warning states keep their icon and label in every direction, so colour is never the only signal.\n\n`;
sm += `| Direction | Accent (light) | Chart (light) | Chart (dark) | Accent vs danger | Chart vs danger | Dark chart vs dark danger | Accent vs warning | Chart vs warning | Dark chart vs dark warning | Status in this kit |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
const ro = out.reference;
sm += `| Today (cobalt) | ${REF.l.accent} | ${REF.l.chart} | ${REF.d.chart} | ${f(ro.dist.lDanger)} | same | ${f(ro.dist.dDanger)} | ${f(ro.dist.lWarning)} | same | ${f(ro.dist.dWarning)} | unchanged |\n`;
for (const d of out.directions) {
  const s = d.tokens.dist, st = d.tokens.status;
  const mark = (x) => f(x) + (TOO_CLOSE(x) ? " **too close**" : "");
  const status = [st.dangerClose ? `danger → ${st.danger} / ${st.dangerDark} (after: accent ${f(s.lDangerNew)}; chart ${f(s.lDangerChartNew)}; dark ${f(s.dDangerNew)})` : "danger unchanged", st.warningClose ? `warning → ${st.warning} / ${st.warningDark} (after: accent ${f(s.lWarningNew)}; chart ${f(s.lWarningChartNew)}; dark ${f(s.dWarningNew)})` : "warning unchanged"].join("; ");
  sm += `| ${d.letter} ${d.title} | ${d.tokens.l.accent} | ${d.tokens.l.chart} | ${d.tokens.d.chart} | ${mark(s.lDanger)} | ${mark(s.lDangerChart)} | ${mark(s.dDanger)} | ${mark(s.lWarning)} | ${mark(s.lWarningChart)} | ${mark(s.dWarning)} | ${status} |\n`;
}
writeFileSync(join(HERE, "STATUS.md"), sm);
console.log(md.split("\n").slice(-2).join("\n"));
for (const d of out.directions) console.log(d.letter, d.tokens.l.accent, d.tokens.l.chart, d.tokens.d.chart, "danger", d.tokens.status.dangerClose, "warning", d.tokens.status.warningClose, JSON.stringify(d.tokens.dist));
console.log("adjust", JSON.stringify(ADJUST));
