// Unit tests for the parts of the Supabase client that need no network:
//   npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterArgs, friendlyError, isUuid, listArgs, mapApiKey, mapDatabase, mapGroup, mapInvoice, mapPage, mapTrend, mapUsageRow, monthStart,
  newKeySecret, sha256Hex, sparkFrom, usageArgs,
} from "../../src/data/queries.ts";
import { usageCsv, usageCsvName } from "../../src/data/files.ts";
import { connectionStringFor } from "../../src/data/connection.ts";

test("an empty filter sends nulls, not empty strings", () => {
  assert.deepEqual(filterArgs({}), { p_search: null, p_state: null, p_keep: null, p_tags: null });
  assert.deepEqual(filterArgs({ search: "   ", tags: [] }), { p_search: null, p_state: null, p_keep: null, p_tags: null });
});

test("filters keep false and trim and lower-case tags", () => {
  const a = filterArgs({ search: " acme ", state: "asleep", keepAwake: false, tags: [" Customer:Acme-Labs ", "!env"] });
  assert.deepEqual(a, { p_search: "acme", p_state: "asleep", p_keep: false, p_tags: ["customer:acme-labs", "!env"] });
});

test("list arguments default to name order, 50 a page, and clamp page size", () => {
  const d = listArgs();
  assert.equal(d.p_sort, "name");
  assert.equal(d.p_dir, "asc");
  assert.equal(d.p_page, 1);
  assert.equal(d.p_page_size, 50);
  assert.equal(listArgs({ page: 0, pageSize: 5000 }).p_page, 1);
  assert.equal(listArgs({ pageSize: 5000 }).p_page_size, 200);
  assert.equal(listArgs({ pageSize: 0 }).p_page_size, 1);
  assert.equal(listArgs({ sort: "requests24h", dir: "desc", page: 3 }).p_sort, "requests24h");
});

test("months become the first day of the month, and bad months are refused", () => {
  assert.equal(monthStart("2026-10"), "2026-10-01");
  assert.throws(() => monthStart("2026-13"), /Choose a month/);
  assert.throws(() => monthStart("October"), /Choose a month/);
  assert.throws(() => monthStart(""), /Choose a month/);
});

test("usage arguments only send a tag key for the per-tag view", () => {
  assert.equal(usageArgs({ month: "2026-10", by: "database", tagKey: "customer" }).p_tag_key, null);
  assert.equal(usageArgs({ month: "2026-10", by: "tag", tagKey: "customer" }).p_tag_key, "customer");
  assert.equal(usageArgs({ month: "2026-10", by: "tag" }).p_tag_key, null);
  assert.equal(usageArgs({ month: "2026-10", by: "database", pageSize: 99999 }).p_page_size, 5000);
});

test("a database row becomes a Database with a mongodb:// connection string", () => {
  const db = mapDatabase(
    { id: "id1", name: "acme-labs-prod-01", state: "awake", storage_mb: "412", requests_24h: 18, last_active_at: "2026-10-26T12:00:00+00:00", created_at: "2026-03-02T08:00:00+00:00", region: "eu-west", tags: ["customer:acme-labs", "env:prod"], keep_awake: true, forked_from: null, restored_to: null },
    connectionStringFor,
  );
  assert.equal(db.storageMb, 412);
  assert.equal(db.keepAwake, true);
  assert.equal(db.forkedFrom, null);
  assert.deepEqual(db.tags, ["customer:acme-labs", "env:prod"]);
  assert.equal(db.host, "acme-labs-prod-01.db.fenvix.dev");
  assert.equal(db.connectionString, "mongodb://app:<password>@acme-labs-prod-01.db.fenvix.dev:27017/acme_labs_prod_01?tls=true&authSource=acme_labs_prod_01&authMechanism=SCRAM-SHA-256");
  assert.ok(!/postgres/i.test(db.connectionString));
});

test("a row with missing parts still maps without throwing", () => {
  const db = mapDatabase({ id: "x", name: "a-b" }, connectionStringFor);
  assert.equal(db.state, "asleep");
  assert.equal(db.storageMb, 0);
  assert.deepEqual(db.tags, []);
  assert.equal(db.restoredTo, null);
});

test("pages keep total, page and size", () => {
  const p = mapPage({ total: 2988, page: 3, pageSize: 50 }, [1, 2]);
  assert.deepEqual(p, { items: [1, 2], total: 2988, page: 3, pageSize: 50 });
});

test("groups keep the empty group as null", () => {
  assert.equal(mapGroup({ value: null, count: 3, awake: 0, keep_awake: 0, storage_mb: 120 }).value, null);
  assert.equal(mapGroup({ value: "acme-labs", count: 154, awake: 9, keep_awake: 2, storage_mb: 150912 }).keepAwake, 2);
});

test("usage rows, keys and invoices map their fields", () => {
  assert.equal(mapUsageRow({ id: "customer:acme", name: "customer:acme", tags: [], databases: "154", storage_gb: "147.37", requests: "34100210" }).storageGb, 147.37);
  const key = mapApiKey({ id: "k", name: "ci", hint: "a91f", createdAt: "2026-07-28T12:00:00Z", lastUsedAt: null, revokedAt: null });
  assert.equal(key.revokedAt, null);
  assert.equal(key.hint, "a91f");
  const inv = mapInvoice({ id: "i", number: "FNX-2026-09", month: "2026-09", issuedAt: "2026-10-01T00:00:00Z", amount: "937.17", currency: "USD", status: "paid" });
  assert.equal(inv.amount, 937.17);
  assert.equal(mapInvoice({ status: "open" }).status, "open");
});

test("the usage trend turns dates into timestamps and keeps every series the same length", () => {
  const t = mapTrend({ days: ["2026-10-01", "2026-10-02"], series: [{ label: "acme-labs", values: [1, 2] }, { label: "Other", values: ["3", "4"] }] });
  assert.deepEqual(t.days, ["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"]);
  assert.deepEqual(t.series[1].values, [3, 4]);
  assert.deepEqual(mapTrend({}), { days: [], series: [] });
});

test("sparklines are thinned to at most 12 points and never invent data", () => {
  assert.deepEqual(sparkFrom([1, 2, 3]), [1, 2, 3]);
  const s = sparkFrom(Array.from({ length: 30 }, (_, i) => i));
  assert.equal(s.length, 12);
  assert.equal(s[0], 0);
  assert.ok(s.every((v) => v >= 0 && v <= 29));
  assert.deepEqual(sparkFrom([]), []);
});

test("uuid check", () => {
  assert.ok(isUuid("0008233c-d951-4752-8153-6a11cc364546"));
  assert.ok(!isUuid("new"));
  assert.ok(!isUuid("db_0001"));
});

test("an API key is 32 random bytes in hex, and only its hash is stored", async () => {
  const secret = newKeySecret(new Uint8Array(32).fill(171));
  assert.match(secret, /^fnx_[0-9a-f]{64}$/);
  const hash = await sha256Hex(secret);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes(secret.slice(4)));
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notEqual(newKeySecret(new Uint8Array(32).fill(1)), newKeySecret(new Uint8Array(32).fill(2)));
});

test("errors are turned into sentences, and a database message that is already one is kept", () => {
  assert.match(friendlyError({ message: "TypeError: Failed to fetch" }), /Could not reach the server/);
  assert.match(friendlyError({ message: "JWT expired" }), /session has ended/);
  assert.match(friendlyError({ message: "x", status: 401 }), /session has ended/);
  assert.match(friendlyError({ code: "42501", message: "permission denied for table databases" }), /do not have access/);
  assert.match(friendlyError({ message: 'new row violates row-level security policy for table "databases"' }), /do not have access/);
  assert.equal(friendlyError({ code: "23505", message: "A database named acme-prod-01 already exists." }), "A database named acme-prod-01 already exists.");
  assert.match(friendlyError({ code: "23505", message: 'duplicate key value violates unique constraint "databases_workspace_name"' }), /already taken/);
  assert.match(friendlyError({ code: "57014", message: "canceling statement due to statement timeout" }), /narrower filter/);
  assert.equal(friendlyError({ message: "Choose a time in the past." }), "Choose a time in the past.");
  assert.match(friendlyError(null), /Something went wrong/);
});

test("the usage csv has a header, quotes what needs quoting and ends with a newline", () => {
  const rows = [
    { id: "1", name: "acme-labs-prod-01", tags: ["customer:acme-labs", "env:prod"], databases: 1, storageGb: 1.5, requests: 100 },
    { id: "2", name: 'odd,"name"', tags: [], databases: 1, storageGb: 0, requests: 0 },
  ];
  assert.equal(usageCsv(rows, "database"), 'database,tags,storage_gb_avg,requests\nacme-labs-prod-01,customer:acme-labs env:prod,1.5,100\n"odd,""name""",,0,0\n');
  assert.equal(usageCsv([{ id: "customer:a", name: "customer:a", tags: [], databases: 4, storageGb: 2, requests: 9 }], "tag"), "tag,databases,storage_gb_avg,requests\ncustomer:a,4,2,9\n");
  assert.equal(usageCsvName("2026-10", "database"), "fenvix-usage-2026-10-databases.csv");
  assert.equal(usageCsvName("2026-10", "tag", "customer"), "fenvix-usage-2026-10-by-customer.csv");
  assert.equal(usageCsvName("2026-10", "tag"), "fenvix-usage-2026-10-tags.csv");
});
