// The keyboard rules of the dashboard's select (src/components/Select.tsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelOf, moveIndex, typeahead } from "../../src/lib/listbox.ts";

const OPTIONS = [
  { value: "", label: "No grouping" },
  { value: "customer", label: "customer" },
  { value: "env", label: "env" },
  { value: "region", label: "region" },
  { value: "release", label: "release" },
];

test("arrows move one step and stop at the ends; Home and End jump; other keys do not move", () => {
  assert.equal(moveIndex("ArrowDown", 0, 5), 1);
  assert.equal(moveIndex("ArrowDown", 4, 5), 4);
  assert.equal(moveIndex("ArrowUp", 0, 5), 0);
  assert.equal(moveIndex("ArrowUp", 3, 5), 2);
  assert.equal(moveIndex("Home", 3, 5), 0);
  assert.equal(moveIndex("End", 1, 5), 4);
  assert.equal(moveIndex("PageDown", 1, 5), 4);
  assert.equal(moveIndex("PageUp", 3, 5), 0);
  assert.equal(moveIndex("Enter", 2, 5), null);
  assert.equal(moveIndex("a", 2, 5), null);
});

test("with nothing highlighted, down starts at the first option and up at the last; an empty list never moves", () => {
  assert.equal(moveIndex("ArrowDown", -1, 5), 0);
  assert.equal(moveIndex("ArrowUp", -1, 5), 4);
  assert.equal(moveIndex("ArrowDown", 0, 0), null);
});

test("typing jumps to the next option that starts with the letters, wrapping, case-insensitive", () => {
  assert.equal(typeahead(OPTIONS, "e", 0), 2);
  assert.equal(typeahead(OPTIONS, "E", 0), 2);
  assert.equal(typeahead(OPTIONS, "c", 3), 1); // wraps past the end
  assert.equal(typeahead(OPTIONS, "x", 0), -1);
  assert.equal(typeahead(OPTIONS, "", 0), -1);
});

test("the same letter again cycles through the options with it; more letters narrow the search", () => {
  assert.equal(typeahead(OPTIONS, "r", 0), 3);
  assert.equal(typeahead(OPTIONS, "r", 3), 4);
  assert.equal(typeahead(OPTIONS, "rr", 3), 4);
  assert.equal(typeahead(OPTIONS, "r", 4), 3);
  assert.equal(typeahead(OPTIONS, "rel", 3), 4);
  assert.equal(typeahead(OPTIONS, "reg", 3), 3); // the current option still matches: stay
});

test("the closed select shows the label of its value, or nothing for an unknown value", () => {
  assert.equal(labelOf(OPTIONS, ""), "No grouping");
  assert.equal(labelOf(OPTIONS, "env"), "env");
  assert.equal(labelOf(OPTIONS, "nope"), "");
});
