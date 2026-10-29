import { createHash, createHmac } from "node:crypto";
import { request } from "node:http";

/**
 * The few S3 calls the engine-real suite needs against a LOCAL S3-compatible store (MinIO on 127.0.0.1): make a
 * bucket for one test engine, list and empty it. Signed with AWS Signature V4, from credentials the caller gives (the
 * local MinIO's test credentials). Never used with real AWS: the endpoint must be plain http on a loopback address.
 */
export interface LocalS3 { endpoint: string; region: string; accessKey: string; secretKey: string }

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

export function assertLocal(s3: LocalS3): URL {
  const u = new URL(s3.endpoint);
  if (u.protocol !== "http:" || !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(u.hostname)) throw new Error("the engine-real S3 store must be a local endpoint (http://127.x.x.x:port)");
  return u;
}

export async function s3Call(s3: LocalS3, method: string, path: string, query = "", body: Buffer = Buffer.alloc(0)): Promise<{ status: number; text: string }> {
  const u = assertLocal(s3);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const host = u.host;
  const payloadHash = sha(body);
  const canonicalQuery = query.split("&").filter(Boolean).map((kv) => { const [k, v = ""] = kv.split("="); return [encodeURIComponent(k!), encodeURIComponent(v)]; }).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = [method, path, canonicalQuery, signed.map((h) => `${h}:${headers[h]}\n`).join(""), signed.join(";"), payloadHash].join("\n");
  const scope = `${day}/${s3.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${s3.secretKey}`, day), s3.region), "s3"), "aws4_request");
  const sig = createHmac("sha256", key).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${s3.accessKey}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${sig}`;
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, method, path: canonicalQuery ? `${path}?${canonicalQuery}` : path, headers: { ...headers, "content-length": String(body.length) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

export async function makeBucket(s3: LocalS3, bucket: string): Promise<void> {
  const body = Buffer.from(`<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${s3.region}</LocationConstraint></CreateBucketConfiguration>`);
  const r = await s3Call(s3, "PUT", `/${bucket}`, "", body);
  if (r.status !== 200) throw new Error(`could not make bucket ${bucket}: ${r.status} ${r.text.slice(0, 300)}`);
}

/** Keys under a prefix (every page). */
export async function listKeys(s3: LocalS3, bucket: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  let token = "";
  for (;;) {
    const r = await s3Call(s3, "GET", `/${bucket}`, `list-type=2&prefix=${prefix}${token ? `&continuation-token=${token}` : ""}`);
    if (r.status !== 200) throw new Error(`list ${bucket}: ${r.status}`);
    for (const m of r.text.matchAll(/<Key>([^<]*)<\/Key>/g)) out.push(m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(r.text);
    if (!next) return out;
    token = next[1]!;
  }
}

/** Deletes every object and then the bucket (test clean-up: the bucket belongs to one test engine). */
export async function dropBucket(s3: LocalS3, bucket: string): Promise<void> {
  for (const k of await listKeys(s3, bucket)) await s3Call(s3, "DELETE", `/${bucket}/${k.split("/").map(encodeURIComponent).join("/")}`);
  await s3Call(s3, "DELETE", `/${bucket}`);
}
