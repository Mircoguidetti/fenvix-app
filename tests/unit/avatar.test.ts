// Unit tests for the workspace avatar in the sidebar: npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { AVATAR_COLORS, contrastRatio, workspaceColor, workspaceInitial } from "../../src/lib/avatar.ts";

test("the initial is the first letter, upper-cased", () => {
  assert.equal(workspaceInitial("My workspace"), "M");
  assert.equal(workspaceInitial("northwind cloud"), "N");
  assert.equal(workspaceInitial("  acme  "), "A");
});

test("an emoji stays whole", () => {
  assert.equal(workspaceInitial("🚀 Launch team"), "🚀");
  assert.equal(workspaceInitial("👩🏽‍💻 Dev"), "👩🏽‍💻");
  assert.equal(workspaceInitial("🇮🇹 Roma"), "🇮🇹");
});

test("an accented letter stays whole and is upper-cased", () => {
  assert.equal(workspaceInitial("élan"), "É");
  assert.equal(workspaceInitial("élan"), "É"); // e + combining accent
  assert.equal(workspaceInitial("ørsted"), "Ø");
});

test("an empty name gives W", () => {
  assert.equal(workspaceInitial(""), "W");
  assert.equal(workspaceInitial("   "), "W");
});

test("the same name always gets the same colour", () => {
  for (const name of ["My workspace", "Northwind Cloud", "🚀 Launch team", "élan", ""]) {
    assert.equal(workspaceColor(name), workspaceColor(name));
    assert.equal(workspaceColor(name), workspaceColor(`  ${name} `));
    assert.ok(AVATAR_COLORS.includes(workspaceColor(name) as (typeof AVATAR_COLORS)[number]));
  }
});

test("different names spread over the palette", () => {
  const used = new Set(Array.from({ length: 60 }, (_, i) => workspaceColor(`Workspace ${i}`)));
  assert.ok(used.size >= AVATAR_COLORS.length - 1, `only ${used.size} colours used`);
});

test("white text on every avatar colour passes WCAG AA (4.5:1)", () => {
  for (const c of AVATAR_COLORS) assert.ok(contrastRatio("#ffffff", c) >= 4.5, `${c}: ${contrastRatio("#ffffff", c).toFixed(2)}`);
});
