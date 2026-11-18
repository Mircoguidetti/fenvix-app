import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Settings } from "./settings.ts";

export const UBUNTU_2404_AMI_PARAMETER = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";

const FILES_DIR = new URL("./runner/files/", import.meta.url);
/** Baked into the runner image (demo and per-job machines): [file, path on the machine, mode]. */
export const RUNNER_FILES: [string, string, string][] = [
  ["install.sh", "/opt/fenvix/install.sh", "0755"],
  ["fenvix-imds-block", "/opt/fenvix/bin/fenvix-imds-block", "0755"],
  ["fenvix-register", "/opt/fenvix/bin/fenvix-register", "0755"],
  ["fenvix-summary-credential", "/opt/fenvix/bin/fenvix-summary-credential", "0755"],
  ["fenvix-job-completed", "/opt/fenvix/bin/fenvix-job-completed", "0755"],
  ["fenvix-job-started", "/opt/fenvix/bin/fenvix-job-started", "0755"],
  ["fenvix-summary-poster", "/opt/fenvix/bin/fenvix-summary-poster", "0755"],
  ["fenvix-jit-prepare", "/opt/fenvix/bin/fenvix-jit-prepare", "0755"],
  ["fenvix-job-done", "/opt/fenvix/bin/fenvix-job-done", "0755"],
  ["fenvix-idle-watchdog", "/opt/fenvix/bin/fenvix-idle-watchdog", "0755"],
  ["fenvix-imds-block.service", "/etc/systemd/system/fenvix-imds-block.service", "0644"],
  ["fenvix-runner.service", "/etc/systemd/system/fenvix-runner.service", "0644"],
  ["fenvix-summary-poster.service", "/etc/systemd/system/fenvix-summary-poster.service", "0644"],
  ["fenvix-runner-jit.service", "/etc/systemd/system/fenvix-runner-jit.service", "0644"],
  ["fenvix-job.target", "/etc/systemd/system/fenvix-job.target", "0644"],
  ["fenvix-idle-watchdog.service", "/etc/systemd/system/fenvix-idle-watchdog.service", "0644"],
  ["fenvix-idle-watchdog.timer", "/etc/systemd/system/fenvix-idle-watchdog.timer", "0644"],
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
    if (!/^[A-Za-z0-9_./:@-]*$/.test(v)) throw new Error(`machine setting ${k} has characters the env file does not allow`);
    return `${k}=${v}`;
  });
  return [`cat >${path} <<'FENVIX_ENV'`, ...lines, "FENVIX_ENV", `chmod 0644 ${path}`];
}

/** The settings every runner machine needs, without the per-job ones (no secret, no SSM parameter name). */
export function commonMachineEnv(s: Settings): Record<string, string> {
  return {
    AWS_DEFAULT_REGION: s.region,
    FENVIX_ENGINE_CLI_COMMIT: s.engineCliCommit,
    FENVIX_SUMMARIES_URL: `https://${s.domainName}/v1/runner/summaries`,
  };
}

/** Per-job machines: what the worker Lambda writes into each one's user data, besides the job's own values. Demo
 * machines get commonMachineEnv only (no shared cache: nothing crosses demos). */
export function perJobMachineEnv(s: Settings): Record<string, string> {
  return {
    ...commonMachineEnv(s),
    FENVIX_IDLE_MINUTES: String(s.runnerIdleMinutes),
    // The worker appends the job's cache organization (gh-<installation id>) and signs a token for it.
    FENVIX_CACHE_URL: `http://${s.cachePrivateIp}:8787`,
  };
}

const DIRS = "install -d -m 0755 /etc/fenvix /opt/fenvix/bin /etc/systemd/system";

/** The image build (EC2 Image Builder component): the files and install.sh; the settings file is removed after. */
export function imageBuildScript(s: Settings): string {
  return ["set -euo pipefail", DIRS, ...envLines("/etc/fenvix/runner.env", commonMachineEnv(s)), bundleLine(IMAGE_FILES),
    "bash /opt/fenvix/install.sh", "rm -f /etc/fenvix/runner.env", "rm -rf /var/log/fenvix-runner-setup.log"].join("\n") + "\n";
}
