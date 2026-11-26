// Status colours and silver: the tokens in src/styles.css, their contrast on every surface they are drawn on, that no
// other hue is used anywhere, and that the states in the inventory (docs/status-colors.md) use the right token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync("src/styles.css", "utf8");
const src = (p: string) => readFileSync(join("src", p), "utf8");

/** Every `--name: value;` in the :root blocks, with var() references resolved. */
function tokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of CSS.matchAll(/:root\s*\{([^}]*)\}/g))
    for (const m of block[1].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  const resolve = (v: string, depth = 0): string => (depth > 5 ? v : v.replace(/var\(--([\w-]+)\)/g, (_, n) => resolve(out[n] ?? "", depth + 1)));
  for (const k of Object.keys(out)) out[k] = resolve(out[k]);
  // A semi-transparent navigation fill is checked as what it looks like: flattened onto the navigation colour.
  for (const k of ["nav-hover", "nav-active"]) {
    const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(out[k] ?? "");
    if (!m) continue;
    const base = [1, 3, 5].map((i) => parseInt(out["nav-bg"].slice(i, i + 2), 16));
    const a = parseFloat(m[4]);
    out[k] = "#" + [1, 2, 3].map((i, j) => Math.round(+m[i] * a + base[j] * (1 - a)).toString(16).padStart(2, "0")).join("");
  }
  return out;
}
const T = tokens();
/** The light tokens (the first :root block) and the dark theme's two blocks. */
const LIGHT_ROOT = /:root\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
const DARK_BLOCKS = [...CSS.matchAll(/:root(?:\[data-theme="dark"\]|:not\(\[data-theme="light"\]\))\s*\{([^}]*)\}/g)].map((m) => m[1]).filter((b) => /--success\s*:/.test(b));

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** Chroma (max - min channel, 0..1): near 0 for black, white and greys. */
const chroma = (hex: string) => Math.max(...rgb(hex)) - Math.min(...rgb(hex));
function hue(hex: string) {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const NEUTRAL = 0.08;
/** The one blue family of the interface: greys with a slight blue tint, the dark colour and its lighter shades. */
const isBlueFamily = (hex: string) => hue(hex) >= 205 && hue(hex) <= 240;

const LIGHT = ["bg", "page", "surface", "surface-2"];
// Dark surfaces in the light theme: toasts are drawn on --text, the brand ink. The navigation is light since the console
// mockup (2026-11-12), so it is checked with the light surfaces' rules, not here.
const DARK = ["black", "text"];
const STATUS = ["success", "danger", "warning"];

test("the status tokens are defined once, as flat hex colours, for the light content and the dark surfaces", () => {
  for (const name of [...STATUS, ...STATUS.map((s) => `${s}-on-dark`)]) {
    assert.match(T[name] ?? "", /^#[0-9a-f]{6}$/i, `--${name} is missing or not a flat colour`);
    assert.equal(LIGHT_ROOT.match(new RegExp(`--${name}\\s*:`, "g"))?.length, 1, `--${name} is defined more than once in the light tokens`);
  }
  // The dark theme redefines the three status colours, and only as the "on dark" ones.
  for (const block of DARK_BLOCKS)
    for (const s of STATUS) assert.equal(new RegExp(`--${s}\\s*:\\s*([^;]+);`).exec(block)?.[1].trim(), T[`${s}-on-dark`], `the dark theme's --${s} is not --${s}-on-dark`);
  assert.equal(DARK_BLOCKS.length, 2, "the dark theme is defined twice: for data-theme=dark and for the device setting");
});

test("status text on the light content reaches 4.5:1 on every light surface", () => {
  for (const s of STATUS)
    for (const bg of LIGHT) {
      const c = contrast(T[s], T[bg]);
      assert.ok(c >= 4.5, `--${s} ${T[s]} on --${bg} ${T[bg]} is ${c.toFixed(2)}:1`);
    }
});

test("status colours on the dark surfaces reach 4.5:1 on every dark surface", () => {
  for (const s of STATUS)
    for (const bg of DARK) {
      const c = contrast(T[`${s}-on-dark`], T[bg]);
      assert.ok(c >= 4.5, `--${s}-on-dark ${T[`${s}-on-dark`]} on --${bg} ${T[bg]} is ${c.toFixed(2)}:1`);
    }
});

test("as shapes (dots, borders, icons) every status colour reaches 3:1, and white on red (a danger button on hover) 4.5:1", () => {
  for (const s of STATUS) for (const bg of LIGHT) assert.ok(contrast(T[s], T[bg]) >= 3, `--${s} on --${bg}`);
  assert.ok(contrast(T["on-text"], T.danger) >= 4.5, "white on --danger");
});

test("the status colours are saturated and are green, red and amber", () => {
  for (const s of [...STATUS, ...STATUS.map((x) => `${x}-on-dark`)]) assert.ok(chroma(T[s]) >= 0.4, `--${s} ${T[s]} is not saturated`);
  for (const s of ["success", "success-on-dark"]) assert.ok(hue(T[s]) >= 90 && hue(T[s]) <= 160, `--${s} is not green (${hue(T[s]).toFixed(0)}°)`);
  for (const s of ["danger", "danger-on-dark"]) assert.ok(hue(T[s]) <= 15 || hue(T[s]) >= 345, `--${s} is not red (${hue(T[s]).toFixed(0)}°)`);
  for (const s of ["warning", "warning-on-dark"]) assert.ok(hue(T[s]) >= 25 && hue(T[s]) <= 50, `--${s} is not amber (${hue(T[s]).toFixed(0)}°)`);
});

test("silver is a cool, soft blue-slate gradient that stays visible on the white content and on the black surfaces", () => {
  const stops = ["silver-1", "silver-2", "silver-3"].map((n) => T[n]);
  for (const s of stops) {
    assert.match(s, /^#[0-9a-f]{6}$/i);
    assert.ok(chroma(s) < 0.4, `${s} is not soft (too saturated for a fill)`);
    const [r, , b] = rgb(s);
    assert.ok(b >= r, `${s} is not cool (blue channel below red)`);
  }
  assert.match(T.silver, /^linear-gradient\(/);
  for (const s of stops) assert.ok(T.silver.includes(s), `--silver does not use ${s}`);
  // Light grey to white to mid grey: the middle stop is the lightest, the last the darkest.
  assert.ok(luminance(T["silver-2"]) > luminance(T["silver-1"]) && luminance(T["silver-1"]) > luminance(T["silver-3"]));
  // Visible: its darkest stop on white, and its lightest stops on black, reach 3:1. Discreet: on white the light
  // stops stay below 2:1, so the line reads as a sheen, not a stripe.
  assert.ok(contrast(T["silver-3"], T.bg) >= 3, "silver is lost on white");
  assert.ok(contrast(T["silver-1"], T.black) >= 3, "silver is lost on the black surfaces");
  assert.ok(contrast(T["silver-1"], T.text) >= 3, "silver is lost on a selected (black) tab");
  assert.ok(contrast(T["silver-1"], T.bg) < 2, "silver is loud on white");
});

/** CSS rules as [selector, body] pairs, comments removed. */
function rules(): [string, string][] {
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
}

test("no hue other than the status colours appears in the stylesheet or in the components", () => {
  const allowed = new Set([...STATUS, ...STATUS.map((s) => `${s}-on-dark`)].map((s) => T[s].toLowerCase()));
  const hexes = (text: string) => [...text.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)].map((m) => m[0].toLowerCase()).map((h) => (h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join("")}` : h));
  for (const h of hexes(CSS)) assert.ok(chroma(h) < NEUTRAL || allowed.has(h) || isBlueFamily(h), `styles.css uses ${h}, which is neither a grey, the blue family nor a status colour`);
  for (const m of CSS.matchAll(/rgba?\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(",").map((x) => parseFloat(x) / 255);
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < NEUTRAL || isBlueFamily("#" + [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")), `styles.css uses ${m[0]}`);
  }
  // The Google "G" on the sign-in button is Google's own mark, in its own colours; it is the one exception.
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  for (const file of walk("src").filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith("marks.tsx") && !f.endsWith("styles.css")))
    for (const h of hexes(readFileSync(file, "utf8"))) assert.ok(chroma(h) < NEUTRAL || allowed.has(h) || isBlueFamily(h), `${file} uses ${h}`);
  // A status colour is only ever read through its token, never written out.
  for (const file of walk("src").filter((f) => f.endsWith(".tsx")))
    for (const h of hexes(readFileSync(file, "utf8"))) assert.ok(!allowed.has(h), `${file} writes out a status colour (${h}); use the token`);
});

test("silver is used only for accent lines, the current plan's border and the fill under chart lines, never for text", () => {
  const ALLOWED = [/::after/, /^\.plan-current$/, /^\.silver-stop-\d$/];
  for (const [sel, body] of rules()) {
    if (!/var\(--silver/.test(body) || sel.startsWith(":root")) continue;
    for (const s of sel.split(",").map((x) => x.trim())) assert.ok(ALLOWED.some((a) => a.test(s)), `silver used on ${s}`);
    assert.ok(!/(^|;|\s)color\s*:[^;]*--silver/.test(body), `silver used as a text colour on ${sel}`);
    if (/::after/.test(sel)) assert.match(body, /content:\s*""/, `${sel}: a silver line must have no text`);
  }
});

/** The token each state in the inventory must use, by selector. */
const MAP: [string, string][] = [
  [".state-awake .dot", "success"],
  [".state-ok .dot", "success"],
  [".callout-success .callout-row svg", "success"],
  [".copy-done svg", "success"],
  [".state-warn .dot", "warning"],
  [".tag-warning", "warning"],
  [".waking svg", "warning"],
  [".once-warning svg", "warning"],
  [".callout-warning .callout-row svg", "warning"],
  [".message-warning svg", "warning"],
  [".error", "danger"],
  [".message-error", "danger"],
  [".blocked-until", "danger"],
  [".btn-danger", "danger"],
  [".dialog-danger .dialog-actions .btn-primary", "danger"],
  ['input[aria-invalid="true"]', "danger"],
  [".state-danger .dot", "danger"],
  [".fail-count", "danger"],
  [".step[data-done] .step-n", "success"],
  [".diff-del", "danger-on-dark"],
  [".diff-add", "success-on-dark"],
  [".toast-success .toast-icon", "success-on-dark"],
  [".toast-error .toast-icon", "danger-on-dark"],
];

test("each state in the inventory uses its token", () => {
  const all = rules();
  for (const [selector, token] of MAP) {
    const found = all.filter(([sel]) => sel.split(",").map((s) => s.trim()).includes(selector));
    assert.ok(found.length, `no rule for ${selector}`);
    assert.ok(found.some(([, body]) => new RegExp(`var\\(--${token}\\)`).test(body)), `${selector} does not use --${token}`);
    for (const other of [...STATUS, ...STATUS.map((s) => `${s}-on-dark`)].filter((t) => t !== token))
      assert.ok(!found.some(([, body]) => new RegExp(`var\\(--${other}\\)`).test(body)), `${selector} also uses --${other}`);
  }
});

test("notices have no border and no coloured edge: a grey fill, and the colour only on the icon", () => {
  const NOTICES = [".callout", ".callout-success", ".callout-warning", ".once-warning", ".waking", ".secret", ".readonly-note"];
  for (const [sel, body] of rules()) {
    for (const s of sel.split(",").map((x) => x.trim())) {
      if (!NOTICES.includes(s)) continue;
      assert.ok(!/border(-color|-left|-top|-right|-bottom|-width)?\s*:(?!\s*(0|none)\s*(;|$))/.test(body), `${s} draws a border`);
      assert.ok(!/box-shadow/.test(body), `${s} draws an edge with box-shadow`);
    }
  }
  assert.match(src("pages/Connect.tsx"), /callout callout-success[\s\S]*?<CircleCheck/);
  assert.match(src("pages/Connect.tsx"), /callout callout-warning[\s\S]*?<TriangleAlert/);
  assert.match(src("pages/SignIn.tsx"), /callout callout-success[\s\S]*?<CircleCheck/);
});

test("every coloured state also says it in words or with an icon", () => {
  // Errors: the stylesheet writes "Error: " before the message.
  assert.match(CSS, /\.error::before\s*\{[^}]*content:\s*"Error: "/);
  // Pills: a dot and a word.
  const badge = src("components/StateBadge.tsx");
  for (const word of ["Passed", "Failed", "Running", "Cancelled", "Active", "Suspended", "Uninstalled"]) assert.ok(badge.includes(`"${word}"`), `no word "${word}" in the state pills`);
  // Every onboarding state of a repository has its words; the trial's gate and the audit's wrong skips too.
  for (const state of ["pending", "pr_open", "merged", "closed", "no_workflow", "no_test_job", "already_fenvix", "unsupported", "failed", "side_by_side_pr_open", "side_by_side"]) assert.match(badge, new RegExp(`\\b${state}: "[A-Z][^"]+"`), `no words for the onboarding state ${state}`);
  assert.match(src("components/Trial.tsx"), /tone="ok">\{`\$\{gatePercent\(trial\)\} gate met`\}/);
  assert.match(src("components/Trial.tsx"), /tone="warn">\{`Below the \$\{gatePercent\(trial\)\} gate`\}/);
  assert.match(src("pages/ProjectSections.tsx"), /wrongSkips === 0 \? <StatusPill tone="ok">\{`Expected/);
  // Toasts and messages: an icon with each tone.
  const toast = src("components/Toast.tsx");
  assert.match(toast, /tone === "success" && <CircleCheck/);
  assert.match(toast, /tone === "error" && <CircleAlert/);
  const message = src("components/PageHeader.tsx");
  assert.match(message, /message-error[\s\S]*?<CircleAlert/);
  assert.match(message, /message-warning[\s\S]*?<TriangleAlert/);
  // Outcomes, replays and defect states: always a word.
  const ci = src("components/ci.tsx");
  for (const word of ["Passed", "Skipped with proof", "Failed: flaky defect", "Replays ", "fingerprints differ"]) assert.ok(ci.includes(word), `no words "${word}" for an outcome`);
  const defects = src("pages/Defects.tsx");
  assert.match(defects, /tone="danger" icon=\{STATE_ICONS\.alert\}>\s*Open/);
  assert.match(defects, /tone="ok">Fixed</);
  // The setup diff says - and + as well as red and green; a done step shows a tick.
  assert.match(src("pages/Connect.tsx"), /className="diff-del">- \{/);
  assert.match(src("pages/Connect.tsx"), /className="diff-add">\+ \{/);
  assert.match(src("pages/Connect.tsx"), /done \? <Check/);
});

test("the states in the inventory are wired to the right classes in the components", () => {
  const badge = src("components/StateBadge.tsx");
  assert.match(badge, /tone === "danger" \? "state state-danger"/);
  assert.match(badge, /status === "passed" \? "ok" : status === "failed" \? "danger" : status === "running" \|\| status === "not_proven" \? "warn" : "neutral"/);
  assert.match(badge, /tone=\{status === "active" \? "ok" : status === "suspended" \? "warn" : "neutral"\}/);
  // Rule 3 (spec 20261126-side-by-side-runs): side_by_side is green like merged, side_by_side_pr_open amber like pr_open.
  assert.match(badge, /state === "merged" \|\| state === "already_fenvix" \|\| state === "side_by_side" \? "ok" : state === "pr_open" \|\| state === "side_by_side_pr_open" \? "warn" : state === "failed" \? "danger" : "neutral"/);
  assert.match(src("pages/Project.tsx"), /<RunStatusPill status=\{r\.status\} count=\{r\.tests\.notProven\} \/>/);
  assert.match(src("pages/Project.tsx"), /className="fail-count"/);
  assert.match(src("components/ci.tsx"), /outcome === "failed"\) return <StatusPill tone="danger">/);
  assert.match(src("components/ci.tsx"), /<StatusPill tone=\{ok \? "ok" : "warn"\} icon=\{ok \? STATE_ICONS\.seal : undefined\}>/);
  // Every state has an icon as well as a word (founder, 2026-11-17): ✓ ok, ✕ failed, a clock in progress, a dash
  // otherwise; skipped with proof carries a seal.
  const pill = src("components/StateBadge.tsx");
  assert.match(pill, /const TONE_ICON: Record<Tone, LucideIcon> = \{ ok: Check, danger: X, warn: Clock, neutral: Minus \}/);
  assert.match(pill, /<Icon className="state-icon"/);
  assert.match(src("components/ci.tsx"), /<StatusPill tone="neutral" icon=\{STATE_ICONS\.seal\}>\s*Skipped with proof/);
  assert.match(src("pages/Connect.tsx"), /callout callout-success/);
  assert.match(src("pages/SignIn.tsx"), /callout callout-success/);
});

test("every action that cannot be undone has a dialog with a red confirm button and no border; the buttons that open them are red, except Restore", () => {
  const files = ["pages/Members.tsx", "components/AccountMenu.tsx", "pages/Connect.tsx", "pages/Run.tsx", "pages/Settings.tsx"];
  let dialogs = 0;
  for (const f of files) {
    const text = src(f);
    for (const m of text.matchAll(/<ConfirmDialog([\s\S]*?)>/g)) {
      const label = /confirmLabel=(?:"([^"]+)"|\{`([^`]+)`\})/.exec(m[1]);
      const name = label?.[1] ?? label?.[2] ?? "";
      const destructive = /^(Erase|Delete|Remove|Revoke|Clear|Leave|Restore)\b/.test(name);
      if (destructive) dialogs++;
      assert.equal(/\bdanger\b/.test(m[1]), destructive, `${f}: dialog "${name}" ${destructive ? "is not" : "should not be"} marked danger`);
    }
  }
  assert.ok(dialogs >= 3, `only ${dialogs} destructive dialogs found`);
  // The confirm button is the one primary button of the dialog; inside .dialog-danger it is filled red with white text.
  assert.match(src("components/ConfirmDialog.tsx"), /className=\{`dialog\$\{danger \? " dialog-danger" : ""\}/);
  assert.match(src("components/ConfirmDialog.tsx"), /className="btn btn-primary" disabled=\{busy \|\| confirmDisabled\}/);
  const red = rules().find(([sel]) => sel === ".dialog-danger .dialog-actions .btn-primary")?.[1] ?? "";
  assert.match(red, /background:\s*var\(--danger\)/, "the confirm button of a destructive dialog is not filled red");
  assert.match(red, /border-color:\s*var\(--danger\)/);
  assert.match(red, /(^|[;\s])color:\s*var\(--on-text\)/, "the confirm button of a destructive dialog has no white text");
  assert.ok(contrast(T["on-text"], T.danger) >= 4.5, "white on red is below 4.5:1");
  const triggers: [string, RegExp][] = [
    ["pages/Members.tsx", /className="btn btn-sm btn-danger" onClick=\{\(\) => setRemoving\(m\)\}/],
    ["pages/Members.tsx", /className="btn btn-sm btn-danger" onClick=\{\(\) => setRevoking\(i\)\}/],
  ];
  for (const [f, re] of triggers) assert.match(src(f), re, `${f}: the destructive button is not red`);
});

test("every toast says whether it is a success or an error, except the plain notes", () => {
  const NOTES = ["Payment details are managed by your card provider", "We will be in touch about the"];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  let n = 0;
  for (const file of walk("src").filter((f) => f.endsWith(".tsx") && !f.endsWith("Toast.tsx"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\btoast\((.*)\)/g)) {
      n++;
      const call = m[1];
      if (NOTES.some((x) => call.includes(x))) continue;
      assert.match(call, /, "(success|error)"\)?/, `${file}: toast without a tone: toast(${call})`);
      // A toast built from a caught error, or saying something failed, is an error.
      if (/\be\.message\b|message\(e\)|failed|Could not/.test(call)) assert.match(call, /"error"/, `${file}: a failure shown as a success: toast(${call})`);
      else assert.match(call, /"success"/, `${file}: toast(${call})`);
    }
  }
  assert.ok(n >= 15, `only ${n} toasts found`);
});

test("dialogs have no border and no coloured line, destructive or not", () => {
  const dialog = rules().find(([sel]) => sel === ".dialog")?.[1] ?? "";
  assert.match(dialog, /border:\s*0\s*;/, "the dialog has a border");
  for (const [sel, body] of rules())
    if (/\.dialog(-danger|-wide)?\b(?![-\w])/.test(sel) && !/ /.test(sel.replace(/,\s*/g, ",")))
      assert.ok(!/border(-top|-bottom|-left|-right)?:\s*(?!0)[^;]*(solid|var\()|inset/.test(body), `${sel} draws a border or a line`);
});

test("the light frame (top bar, rails, selected item) keeps its text at 4.5:1 or more", () => {
  const pairs: [string, string][] = [["nav-text", "nav-bg"], ["nav-muted", "nav-bg"], ["nav-label", "nav-bg"], ["nav-on", "nav-active"], ["muted", "nav-sub"], ["muted", "nav-box"], ["nav-text", "nav-hover"]];
  for (const [fg, bg] of pairs) {
    const c = contrast(T[fg], T[bg]);
    assert.ok(c >= 4.5, `--${fg} ${T[fg]} on --${bg} ${T[bg]} is ${c.toFixed(2)}:1`);
  }
});
