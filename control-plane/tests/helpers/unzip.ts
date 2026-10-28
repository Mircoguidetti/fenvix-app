import assert from "node:assert/strict";

/** Reads the central directory of a zip: [{ name, data }]. Enough of a reader to check what the writer produced. */
export function unzip(z: Buffer): { name: string; data: Buffer; crc: number }[] {
  const eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = z.readUInt16LE(eocd + 10);
  let p = z.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(z.readUInt32LE(p), 0x02014b50);
    const crc = z.readUInt32LE(p + 16), size = z.readUInt32LE(p + 24), nlen = z.readUInt16LE(p + 28), elen = z.readUInt16LE(p + 30), clen = z.readUInt16LE(p + 32), off = z.readUInt32LE(p + 42);
    const name = z.subarray(p + 46, p + 46 + nlen).toString("utf8");
    assert.equal(z.readUInt32LE(off), 0x04034b50);
    const start = off + 30 + z.readUInt16LE(off + 26) + z.readUInt16LE(off + 28);
    out.push({ name, data: z.subarray(start, start + size), crc });
    p += 46 + nlen + elen + clen;
  }
  return out;
}
