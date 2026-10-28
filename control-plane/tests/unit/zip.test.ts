import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zipStream, type ZipEntry } from "../../src/engine/zip.ts";

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> { for (const p of parts) yield Buffer.from(p); }
async function build(entries: ZipEntry[]): Promise<Buffer> {
  async function* it() { yield* entries; }
  const out: Buffer[] = [];
  for await (const c of zipStream(it())) out.push(c);
  return Buffer.concat(out);
}

test("a zip with empty chunks, an empty file and a non-ASCII name is read correctly by Python's zipfile", async (t) => {
  const py = spawnSync("python3", ["-I", "-c", "import zipfile"]);
  if (py.status !== 0) return t.skip("python3 is not available");
  const z = await build([
    { name: "db_x/a.bson", data: chunks("hel", "", "lo ", "world") },
    { name: "db_x/ü.json", data: chunks("{}", "") },
    { name: "empty", data: chunks() },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  const file = join(dir, "t.zip");
  writeFileSync(file, z);
  const r = spawnSync("python3", ["-I", "-c", "import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({i.filename: z.read(i).decode() for i in z.infolist()}))", file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { "db_x/a.bson": "hello world", "db_x/ü.json": "{}", empty: "" });
});

test("an archive with no entries is a valid empty zip", async () => {
  const z = await build([]);
  assert.equal(z.length, 22);
  assert.equal(z.readUInt32LE(0), 0x06054b50);
});
