import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { contractSteps, readMigrations } from "../lib/migrate.mjs";

const dirWith = (files) => { const d = mkdtempSync(join(tmpdir(), "mig-")); for (const [n, s] of Object.entries(files)) writeFileSync(join(d, n), s); return d; };

describe("migrations only add (G-1705): the previous code always runs on the new schema", () => {
  it("the repository's migrations pass", () => assert.ok(readMigrations().length >= 17));

  it("finds what takes something away, not what adds or replaces a function, a policy or an index", () => {
    assert.deepEqual(contractSteps(`create table if not exists public.t (id int);
      alter table public.t add column if not exists a text default 'x';
      drop policy if exists p on public.t; drop trigger if exists x on public.t; drop index if exists i; drop function if exists f();
      create or replace function f() returns void language plpgsql as $$ begin delete from public.t; drop table public.t; end $$;
      -- drop table public.t;
      update public.t set a = 'y' where a is null;`), []);
    const bad = contractSteps("drop table public.t; alter table public.t drop column a; alter table public.t rename column a to b; alter table public.t alter column a type int; alter table public.t alter column a set not null; truncate public.t; delete from public.t where true; drop type public.k;");
    assert.equal(bad.length, 8, bad.join("\n"));
  });

  it("a migration after 0018 that drops is refused unless marked as a founder-approved contract step", () => {
    assert.throws(() => readMigrations(dirWith({ "0019_x.sql": "alter table public.t drop column a;" })), /only add/);
    assert.equal(readMigrations(dirWith({ "0019_x.sql": "-- fenvix: contract step approved by the founder on 2026-12-01\nalter table public.t drop column a;" })).length, 1);
    assert.equal(readMigrations(dirWith({ "0014_x.sql": "drop table public.old;" })).length, 1, "history is not re-judged");
  });
});
