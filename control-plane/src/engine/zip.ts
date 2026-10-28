import { crc32 } from "node:zlib";

/**
 * A streaming ZIP writer: entries are stored without compression (BSON from a database does not shrink enough to
 * be worth the CPU on the control plane), sizes and CRC follow each entry in a data descriptor, and the central
 * directory comes last. No ZIP64: an entry of 4 GiB or more, or 65,535 entries, fail the stream instead of
 * producing a file that unzips wrongly.
 */
export interface ZipEntry { name: string; data: AsyncIterable<Uint8Array> }

const U32_MAX = 0xffffffff;
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01: the files have no meaningful modification time

const le16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

export async function* zipStream(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  const out = (b: Buffer): Buffer => { offset += b.length; return b; };

  for await (const entry of entries) {
    if (++count > 0xffff) throw new Error("zip: too many entries");
    const name = Buffer.from(entry.name, "utf8");
    const headerOffset = offset;
    // version 20, flags: bit 3 (sizes follow) and bit 11 (UTF-8 names), method 0 (stored)
    yield out(Buffer.concat([le32(0x04034b50), le16(20), le16(0x0808), le16(0), le16(DOS_TIME), le16(DOS_DATE), le32(0), le32(0), le32(0), le16(name.length), le16(0), name]));
    let crc = 0;
    let size = 0;
    for await (const chunk of entry.data) {
      const b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (b.length === 0) continue; // crc32 of an empty buffer returns 0, not the running value
      size += b.length;
      if (size > U32_MAX) throw new Error(`zip: ${entry.name} is 4 GiB or more, which this archive format cannot hold`);
      crc = crc32(b, crc);
      yield out(b);
    }
    yield out(Buffer.concat([le32(0x08074b50), le32(crc), le32(size), le32(size)]));
    central.push(Buffer.concat([
      le32(0x02014b50), le16(20), le16(20), le16(0x0808), le16(0), le16(DOS_TIME), le16(DOS_DATE), le32(crc), le32(size), le32(size),
      le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(headerOffset), name,
    ]));
  }
  const start = offset;
  let dirSize = 0;
  for (const c of central) { dirSize += c.length; yield out(c); }
  yield out(Buffer.concat([le32(0x06054b50), le16(0), le16(0), le16(count), le16(count), le32(dirSize), le32(start), le16(0)]));
}
