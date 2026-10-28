// Unit tests for the workspace avatar in the sidebar: npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { AVATAR_BG, AVATAR_FG, contrastRatio, workspaceInitial } from "../../src/lib/avatar.ts";

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

test("the avatar is black with a white initial, whatever the name", () => {
  assert.equal(AVATAR_BG, "#000000");
  assert.equal(AVATAR_FG, "#ffffff");
  assert.ok(contrastRatio(AVATAR_FG, AVATAR_BG) >= 4.5);
});
