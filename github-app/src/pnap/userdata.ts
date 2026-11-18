import { createHash } from "node:crypto";
import type { Region } from "./api.ts";
import { HOST_BUNDLE_SHA256, HOST_BUNDLE_TGZ_BASE64 } from "./host-bundle.generated.ts";
import type { PnapSettings } from "./settings.ts";

/**
 * The cloud-init user data of a new server (a shell script; phoenixNAP passes it base64-encoded in
 * osConfiguration.cloudInit.userData and serves it to the server on a NoCloud floppy for the server's whole life).
 *
 * What it carries: the host bundle (/opt/fenvix-host, checked against its SHA-256), the pinned downloads and their
 * SHA-256s, the App's URL, and for a job host its single-use enrolment secret. Nothing else secret: the enrolment
 * secret is spent by the first enrolment, so a later read of the floppy yields nothing usable.
 */
const SAFE = /^[A-Za-z0-9_.:/@+=-]*$/;

function line(k: string, v: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(k) || !SAFE.test(v)) throw new Error(`user data setting ${k} has characters it may not have`);
  return `export ${k}='${v}'`;
}

export function hostBundleOk(): boolean {
  return createHash("sha256").update(Buffer.from(HOST_BUNDLE_TGZ_BASE64, "base64")).digest("hex") === HOST_BUNDLE_SHA256;
}

export function userData(s: PnapSettings, h: { hostId: string; role: "runner" | "cache"; region: Region; enrolToken: string }, cachePublicKey?: { n: string; e: number }): string {
  if (!/^fxe1\.[a-z0-9-]{3,63}\.[A-Za-z0-9_-]{32,128}$/.test(h.enrolToken) && h.role === "runner") throw new Error("bad enrolment secret");
  const b64 = HOST_BUNDLE_TGZ_BASE64.match(/.{1,76}/g)!.join("\n");
  const head = [
    "#!/bin/bash",
    `# fenvix ${s.env}: ${h.role} host ${h.hostId} in ${h.region} (github-app/src/pnap/userdata.ts)`,
    "set -euo pipefail",
    "umask 077",
    "exec >>/var/log/fenvix-install.log 2>&1",
    // /etc/fenvix: traversable (0711) so that fenvix-cache reaches cache/signing-key.json (0755 / 0644); everything
    // else in it is root-only (enrol 0400, control-url and host.json 0600 or less). R-014 R3.
    "install -d -m 0711 /etc/fenvix",
    "install -d -m 0700 /var/lib/fenvix",
    "install -d -m 0755 /opt/fenvix-host",
    "base64 -d >/var/tmp/fenvix-host.tgz <<'FENVIX_BUNDLE'",
    b64,
    "FENVIX_BUNDLE",
    `echo '${HOST_BUNDLE_SHA256}  /var/tmp/fenvix-host.tgz' | sha256sum -c --quiet -`,
    "tar -xzf /var/tmp/fenvix-host.tgz -C /opt/fenvix-host --no-same-owner",
    // Readable by the service users (fenvix-parse, fenvix-post, fenvix-cache), writable by root only (R-014 R3).
    "chmod -R a+rX,go-w /opt/fenvix-host",
  ];
  if (h.role === "cache") {
    if (!cachePublicKey || !/^[0-9a-f]{256,1024}$/.test(cachePublicKey.n) || !Number.isInteger(cachePublicKey.e)) throw new Error("the cache server needs the cache signing key's public half");
    return [
      ...head,
      "install -d -m 0755 /etc/fenvix/cache",
      `printf '%s' '${JSON.stringify(cachePublicKey)}' >/etc/fenvix/cache/signing-key.json`,
      "chmod 0644 /etc/fenvix/cache/signing-key.json",
      // The region's private network: phoenixNAP gives each location's default private network a /24 or larger; the
      // install script finds this server's address in it.
      line("PRIVATE_CIDR", "10.0.0.0/8"),
      "bash /opt/fenvix-host/cache/install-cache.sh",
      "",
    ].join("\n");
  }
  const p = s.pins;
  return [
    ...head,
    `printf '%s' '${h.enrolToken}' >/etc/fenvix/enrol`,
    `printf '%s' '${s.controlUrl}' >/etc/fenvix/control-url`,
    "chmod 0400 /etc/fenvix/enrol",
    line("FIRECRACKER_VERSION", p.firecrackerVersion),
    line("FIRECRACKER_SHA256", p.firecrackerSha256),
    line("GUEST_KERNEL_URL", p.kernelUrl),
    line("GUEST_KERNEL_SHA256", p.kernelSha256),
    line("GUEST_BASE_URL", p.baseUrl),
    line("GUEST_BASE_SHA256", p.baseSha256),
    line("GUEST_IMAGE_URL", p.guestImageUrl),
    line("GUEST_IMAGE_SHA256", p.guestImageSha256),
    line("FENVIX_ENGINE_CLI_COMMIT", p.engineCommit),
    "bash /opt/fenvix-host/install-host.sh",
    "",
  ].join("\n");
}
