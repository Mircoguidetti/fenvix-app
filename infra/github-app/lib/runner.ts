import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Settings } from "./settings.ts";

export const UBUNTU_2404_AMI_PARAMETER = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";

const FILES_DIR = new URL("./runner/files/", import.meta.url);
/** Baked into the runner image (demo and per-job machines): [file, path on the machine, mode]. */
export const RUNNER_FILES: [string, string, string][] = [
  ["install.sh", "/opt/fenvix/install.sh", "0755"],
  ["fenvix-imds-block", "/opt/fenvix/bin/fenvix-imds-block", "0755"],
  ["fenvix-imds-block.service", "/etc/systemd/system/fenvix-imds-block.service", "0644"],
  ["fenvix-agent", "/opt/fenvix/bin/fenvix-agent", "0755"],
  ["fenvix-agent.service", "/etc/systemd/system/fenvix-agent.service", "0644"],
  ["fenvix-slot", "/opt/fenvix/bin/fenvix-slot", "0755"],
  ["fenvix-job-started", "/opt/fenvix/bin/fenvix-job-started", "0755"],
  ["fenvix-replay", "/opt/fenvix/bin/fenvix-replay", "0755"],
];

export const IMAGE_FILES = RUNNER_FILES;

/** Shell lines that write files (gzip + base64, to stay well under the user data and component size limits). */
export function fileLines(files: [string, string, string][], dir: URL = FILES_DIR): string[] {
  const out: string[] = [];
  for (const [file, dest, mode] of files) {
    const b64 = gzipSync(readFileSync(new URL(file, dir)), { level: 9 }).toString("base64");
    out.push(`echo '${b64}' | base64 -d | gunzip >${dest}`, `chmod ${mode} ${dest}`);
  }
  return out;
}

/**
 * One line that writes all the files: a shell script of here-documents, gzipped as one piece (files compress much
 * better together than one by one), base64, piped to bash.
 */
export function bundleLine(files: [string, string, string][], dir: URL = FILES_DIR): string {
  const parts: string[] = [];
  for (const [file, dest, mode] of files) {
    const text = readFileSync(new URL(file, dir), "utf8");
    const end = "FENVIX_FILE_END";
    if (text.includes(end)) throw new Error(`${file} contains ${end}`);
    parts.push(`cat >${dest} <<'${end}'`, text.endsWith("\n") ? text.slice(0, -1) : text, end, `chmod ${mode} ${dest}`);
  }
  return `echo '${gzipSync(parts.join("\n") + "\n", { level: 9 }).toString("base64")}' | base64 -d | gunzip | bash -e`;
}

/** The files a bundle line writes, read back (tests). */
export function unbundle(line: string): Record<string, { text: string; mode: string }> {
  const m = /^echo '([A-Za-z0-9+/=]+)' \| base64 -d \| gunzip \| bash -e$/.exec(line);
  if (!m) throw new Error("not a bundle line");
  const script = gunzipSync(Buffer.from(m[1]!, "base64")).toString("utf8");
  const out: Record<string, { text: string; mode: string }> = {};
  const re = /^cat >(\S+) <<'FENVIX_FILE_END'\n([\s\S]*?)\nFENVIX_FILE_END\nchmod (\d+) \1$/gm;
  for (const x of script.matchAll(re)) out[x[1]!] = { text: x[2]! + "\n", mode: x[3]! };
  return out;
}

export function envLines(path: string, env: Record<string, string>): string[] {
  const lines = Object.entries(env).map(([k, v]) => {
    if (!/^[A-Za-z0-9_./:@+-]*$/.test(v)) throw new Error(`machine setting ${k} has characters the env file does not allow`);
    return `${k}=${v}`;
  });
  return [`cat >${path} <<'FENVIX_ENV'`, ...lines, "FENVIX_ENV", `chmod 0644 ${path}`];
}

/** The settings every runner machine needs, without the per-job ones (no secret, no SSM parameter name). */
export function commonMachineEnv(s: Settings): Record<string, string> {
  return {
    AWS_DEFAULT_REGION: s.region,
    FENVIX_SUMMARIES_URL: `https://${s.domainName}/v1/runner/summaries`,
  };
}

/** Per-job machines: what the worker Lambda writes into each one's user data, besides the job's own values. Demo
 * machines get commonMachineEnv only (no shared cache: nothing crosses demos). */
export function perJobMachineEnv(s: Settings): Record<string, string> {
  return {
    ...commonMachineEnv(s),
    // The worker appends the job's cache organization (gh-<installation id>) and signs a token for it.
    FENVIX_CACHE_URL: `http://${s.cachePrivateIp}:8787`,
  };
}

const DIRS = "install -d -m 0755 /etc/fenvix /opt/fenvix/bin /etc/systemd/system";

/** The GitHub runner the image carries, pinned (MEASURED sha256 of the release asset, docs/REPORT-our-machines.md). */
export const GITHUB_RUNNER = { version: "2.338.2", sha256: "baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40" };

/** What the image build needs: the runner pin and the engine pin (empty engine pin: the build stops, fail closed). */
export function imageEnv(s: Settings): Record<string, string> {
  return {
    FENVIX_RUNNER_VERSION: GITHUB_RUNNER.version, FENVIX_RUNNER_SHA256: GITHUB_RUNNER.sha256,
    FENVIX_ENGINE_VERSION: s.engineVersion, FENVIX_ENGINE_URL: s.engineUrl, FENVIX_ENGINE_SHA256: s.engineSha256,
  };
}

/** The image build (EC2 Image Builder component): the files and install.sh; the settings file is removed after. */
export function imageBuildScript(s: Settings): string {
  return ["set -euo pipefail", DIRS, ...envLines("/etc/fenvix/runner.env", imageEnv(s)), bundleLine(IMAGE_FILES),
    "bash /opt/fenvix/install.sh", "rm -f /etc/fenvix/runner.env", "rm -rf /var/log/fenvix-machine-setup.log"].join("\n") + "\n";
}
