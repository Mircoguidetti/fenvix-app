import { writeFileSync } from "node:fs";
const OUT = "/home/user/fenvix-app/design-colors/2026-11-26/console/";
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t)); // t=0 -> a
const rgba = (h, a) => `rgba(${hex(h).join(", ")}, ${a})`;

function kit({ name, desc, primary, darkBlue, font }) {
  const light = {
    "--black": "#0F172A", "--text": "#1E293B", "--bg": "#FFFFFF", "--page": "#F8FAFC",
    "--surface": "#F1F5F9", "--surface-2": "#E9EFF8", "--border": "#E2E8F0", "--border-strong": "#CBD5E1",
    "--line-soft": "#F1F5F9", "--muted": "#475569", "--muted-2": "#64748B", "--on-text": "#F8FAFC",
    "--on-text-muted": "#94A3B8", "--primary-hover": "#334155",
    "--nav-bg": "#FCFDFE", "--nav-sub": "#FFFFFF", "--nav-text": "#0F172A", "--nav-muted": "#475569",
    "--nav-label": "#64748B", "--nav-border": "#E2E8F0", "--nav-hover": "#F1F5F9",
    "--nav-active": mix(primary, "#FFFFFF", 0.92), "--nav-on": primary, "--nav-box": "#F1F5F9", "--grid": "#F1F5F9",
    "--ink-2": mix(primary, "#FFFFFF", 0.4), "--ink-3": mix(primary, "#FFFFFF", 0.75),
    "--chart": primary, "--chart-fill": rgba(primary, 0.06),
    "--area-1": primary, "--area-2": primary,
    "--shadow-lg": "0 12px 32px rgba(15, 23, 42, 0.12)", "--focus": `0 0 0 3px ${rgba(primary, 0.18)}`,
    "--stack-0": primary, "--stack-1": mix(primary, "#FFFFFF", 0.2), "--stack-2": mix(primary, "#FFFFFF", 0.4),
    "--stack-3": mix(primary, "#FFFFFF", 0.6), "--stack-4": mix(primary, "#FFFFFF", 0.8), "--stack-5": "#E2E8F0",
  };
  if (font) light["--font"] = `"Plus Jakarta Sans", system-ui, sans-serif`;
  const dark = {
    "--bg": "#1E293B", "--page": "#0F172A", "--surface": "#172033", "--surface-2": "#243247",
    "--border": "#334155", "--border-strong": "#475569", "--line-soft": "#273449",
    "--text": "#F1F5F9", "--muted": "#A3B1C6", "--muted-2": "#94A3B8", "--on-text": "#0F172A",
    "--on-text-muted": "#475569", "--primary-hover": "#CBD5E1",
    "--nav-bg": "#0F172A", "--nav-sub": "#1E293B", "--nav-text": "#F1F5F9", "--nav-muted": "#A3B1C6",
    "--nav-label": "#94A3B8", "--nav-hover": rgba(darkBlue, 0.08), "--nav-active": rgba(darkBlue, 0.12),
    "--nav-on": darkBlue, "--nav-box": "#172033", "--nav-border": "#1E293B", "--grid": "#273449",
    "--ink-2": mix(darkBlue, "#1E293B", 0.35), "--ink-3": mix(darkBlue, "#1E293B", 0.7),
    "--chart": darkBlue, "--chart-fill": rgba(darkBlue, 0.08),
    "--area-1": darkBlue, "--area-2": primary,
    "--shadow-lg": "0 12px 32px rgba(2, 6, 23, 0.7)", "--focus": `0 0 0 3px ${rgba(darkBlue, 0.35)}`,
    "--stack-0": mix(darkBlue, "#FFFFFF", 0.75), "--stack-1": mix(darkBlue, "#FFFFFF", 0.45), "--stack-2": darkBlue,
    "--stack-3": mix(darkBlue, "#1E293B", 0.35), "--stack-4": mix(darkBlue, "#1E293B", 0.6), "--stack-5": "#273449",
  };
  const decl = (o) => Object.entries(o).map(([k, v]) => `  ${k}: ${v};`).join("\n");
  const css = `/* ${name}: ${desc}
   Token overrides only, injected over src/styles.css (doubled :root raises specificity above the app's own rules).
   Status colours (--success, --danger, --warning and -on-dark) are not touched. */
:root:root {
${decl(light)}
}
:root:root[data-theme="dark"] {
${decl(dark)}
}
@media (prefers-color-scheme: dark) {
  :root:root:not([data-theme="light"]) {
${decl(dark).replace(/^/gm, "  ")}
  }
}
`;
  writeFileSync(OUT + name + ".css", css);
}
writeFileSync(OUT + "K0.css", "/* K0: today, unchanged (console kit A, cobalt #0d4fa3, Schibsted Grotesk). No overrides. */\n");
kit({ name: "K1", desc: "the F kit: blue #2563EB, slate neutrals, #F8FAFC page; Schibsted Grotesk", primary: "#2563EB", darkBlue: "#60A5FA" });
kit({ name: "K2", desc: "same as K1 on the console (K2 differs from K1 only in the landing hero glow)", primary: "#2563EB", darkBlue: "#60A5FA" });
kit({ name: "K3", desc: "K1 with a deeper blue: primary #1D4ED8 (hover #1E40AF); Schibsted Grotesk", primary: "#1D4ED8", darkBlue: "#60A5FA" });
kit({ name: "K4", desc: "K1 with Plus Jakarta Sans for headings and body (mono unchanged)", primary: "#2563EB", darkBlue: "#60A5FA", font: true });
