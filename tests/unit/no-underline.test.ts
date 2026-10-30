// The dashboard has no underlined text: links, menu items, tabs and buttons show their state with weight, colour or a
// background. And it has one black, the landing page's, as a token: no other near-black is written out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const SOURCES = files("src").filter((f) => /\.(tsx?|css)$/.test(f));

test("links have no underline by default", () => {
  assert.match(CSS, /(^|\})\s*a\s*\{[^}]*text-decoration:\s*none/, "the a rule must set text-decoration: none");
});

test("no rule draws an underline or a line under the selected tab or menu item", () => {
  for (const m of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [sel, body] = [m[1].trim(), m[2]];
    for (const d of body.matchAll(/text-decoration(?:-line)?\s*:\s*([^;]+)/g)) assert.equal(d[1].trim(), "none", `${sel} sets text-decoration: ${d[1].trim()}`);
    assert.ok(!/text-underline/.test(body), `${sel} styles an underline`);
    if (/::after|::before/.test(sel) && /(active|aria-pressed|aria-current|aria-selected)/.test(sel)) assert.fail(`${sel} draws a line on a selected item`);
  }
});

test("no source writes an underline inline or with <u>", () => {
  for (const f of SOURCES.filter((f) => f.endsWith(".tsx"))) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/textDecoration\s*:\s*["'`](?!none)/.test(text), `${f} sets textDecoration inline`);
    assert.ok(!/<u[\s>]/.test(text), `${f} uses <u>`);
  }
});

test("the landing page's black is one token, and no other near-black is written out", () => {
  assert.match(CSS, /--black:\s*#0b1220;/);
  for (const t of ["text", "nav-bg", "stack-0"]) assert.match(CSS, new RegExp(`--${t}:\\s*var\\(--black\\);`), `--${t} is not the black token`);
  // Pure black (#000000) and anything darker than #101010 is out: the one dark colour is the token, #0b1220, and it is
  // written only where the token is defined (and in the favicon).
  const nearBlack = (r: number, g: number, b: number) => Math.max(r, g, b) <= 0x10;
  for (const f of [...SOURCES, "index.html", "public/favicon.svg"]) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/#([0-9a-f]{6})\b/gi)) {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
      assert.ok(!nearBlack(r, g, b), `${f} writes out the near-black #${m[1]}; use var(--black)`);
    }
    for (const m of text.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) assert.ok(!nearBlack(+m[1], +m[2], +m[3]), `${f} writes out a near-black ${m[0]}`);
  }
});

test("there is no native select or datalist: every dropdown is components/Select.tsx", () => {
  for (const f of SOURCES.filter((f) => f.endsWith(".tsx"))) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/<select[\s>]/.test(text), `${f} uses a native <select>`);
    assert.ok(!/<datalist[\s>]/.test(text), `${f} uses a <datalist>`);
  }
});
