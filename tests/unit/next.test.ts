// The return path after sign-in (src/lib/next.ts): only a path of this same site is kept; anything that could send
// the browser to another host goes to "/".
import test from "node:test";
import assert from "node:assert/strict";
import { safeNext, welcomeUrl } from "../../src/lib/next.ts";

const ORIGIN = "https://console.fenvix.dev";

test("a same-site path, with its query and hash, is kept", () => {
  assert.equal(safeNext("/projects/x", ORIGIN), "/projects/x");
  assert.equal(safeNext("/usage?month=2026-11", ORIGIN), "/usage?month=2026-11");
  assert.equal(safeNext("/projects/x/runs/r1#tests", ORIGIN), "/projects/x/runs/r1#tests");
  assert.equal(safeNext("/", ORIGIN), "/");
});

test("other hosts, schemes and look-alikes go to /", () => {
  for (const bad of ["//x", "//evil.com/projects", "/\\x", "/\\evil.com", "https://x", "https://evil.com/projects", "http://console.fenvix.dev/projects", "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "x", "projects/x", "", " /projects", "/\t/evil.com", "/\n/evil.com", "/..//evil.com", "/.//evil.com", "/a/..//evil.com", "/%2e%2e//evil.com"]) {
    assert.equal(safeNext(bad, ORIGIN), "/", `${JSON.stringify(bad)} was kept`);
  }
  assert.equal(safeNext(null, ORIGIN), "/");
  assert.equal(safeNext(undefined, ORIGIN), "/");
});

test("the welcome URL carries the path asked for", () => {
  assert.equal(welcomeUrl("/projects/x"), "/welcome?next=%2Fprojects%2Fx");
  assert.equal(welcomeUrl("/usage?month=2026-11"), "/welcome?next=%2Fusage%3Fmonth%3D2026-11");
  assert.equal(welcomeUrl("/"), "/welcome");
});
