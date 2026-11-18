import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const FILES = fileURLToPath(new URL("../lib/runner/files/", import.meta.url));
const SUMMARY = fileURLToPath(new URL("../../../github-app/tests/fixtures/runner/job3-warm-pass.summary.json", import.meta.url));

/** A stand-in for POST /v1/runner/summaries: records requests, answers with the next status in `answers`. */
async function app(answers: number[]) {
  const got: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  const srv = createServer((req: IncomingMessage, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      got.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      res.writeHead(answers.shift() ?? 202, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { got, url: `http://127.0.0.1:${port}/v1/runner/summaries`, close: () => new Promise((r) => srv.close(r)) };
}

function hook(spool: string, env: Record<string, string>) {
  return execFileSync("bash", [join(FILES, "fenvix-job-completed")], { env: { PATH: process.env.PATH!, FENVIX_SPOOL: spool, ...env }, encoding: "utf8" });
}

/** One pass of the poster (async: the stand-in App runs in this process and must keep answering). */
async function poster(spool: string, url: string, tokenFile: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile("python3", ["-I", join(FILES, "fenvix-summary-poster")], {
      env: { PATH: process.env.PATH!, FENVIX_SUMMARIES_URL: url, FENVIX_RUNNER_NAME: "fenvix-ec2-1", FENVIX_TOKEN_FILE: tokenFile, FENVIX_SPOOL: spool, FENVIX_POSTER_ONCE: "1" },
      encoding: "utf8", timeout: 60_000,
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
}

describe("runner machine scripts", () => {
  it("are valid bash (and pass shellcheck when it is installed)", () => {
    const sh = ["install.sh", "fenvix-imds-block", "fenvix-register", "fenvix-fetch-runner-token", "fenvix-job-completed", "fenvix-job-started", "fenvix-jit-prepare", "fenvix-job-done", "fenvix-idle-watchdog"];
    for (const f of sh) execFileSync("bash", ["-n", join(FILES, f)]);
    if (spawnSync("shellcheck", ["--version"]).status === 0) execFileSync("shellcheck", ["-s", "bash", ...sh.map((f) => join(FILES, f))]);
    execFileSync("python3", ["-I", "-c", `import ast,sys; ast.parse(open(sys.argv[1]).read())`, join(FILES, "fenvix-summary-poster")]);
  });

  it("job-completed hook → spool → poster: the App gets the job's ids, this machine's runner name, the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-runner-"));
    const spool = join(dir, "spool"); mkdirSync(spool);
    const temp = join(dir, "runner-temp"); mkdirSync(join(temp, "fenvix"), { recursive: true });
    writeFileSync(join(temp, "fenvix", "summary.json"), readFileSync(SUMMARY));
    const token = join(dir, "token"); writeFileSync(token, "runner-token-0123456789abcdef0123456789\n");
    // A job that claims another runner name: the poster sends its own.
    const out = hook(spool, { RUNNER_TEMP: temp, GITHUB_REPOSITORY_ID: "70001", GITHUB_RUN_ID: "9001", GITHUB_RUN_ATTEMPT: "2", RUNNER_NAME: "someone-else" });
    assert.match(out, /summary queued for run 9001 attempt 2/);
    assert.equal(readdirSync(spool).filter((f) => !f.startsWith(".")).length, 1);

    const a = await app([202]);
    try {
      assert.match(await poster(spool, a.url, token), /sent \(202\)/);
      assert.equal(a.got.length, 1);
      assert.equal(a.got[0]!.auth, "Bearer runner-token-0123456789abcdef0123456789");
      const b = a.got[0]!.body;
      assert.deepEqual({ ...b, summary: undefined }, { repositoryId: 70001, runId: 9001, runAttempt: 2, runnerName: "fenvix-ec2-1", summary: undefined });
      assert.deepEqual(b.summary, JSON.parse(readFileSync(SUMMARY, "utf8")));
      assert.deepEqual(readdirSync(spool), [], "sent: removed");
    } finally { await a.close(); }
  });

  it("no summary: the hook says so and never fails the job; missing ids: nothing queued", () => {
    const spool = mkdtempSync(join(tmpdir(), "fenvix-spool-"));
    assert.match(hook(spool, { RUNNER_TEMP: "/nonexistent" }), /no summary\.json/);
    const temp = mkdtempSync(join(tmpdir(), "fenvix-temp-")); mkdirSync(join(temp, "fenvix"));
    writeFileSync(join(temp, "fenvix", "summary.json"), readFileSync(SUMMARY));
    assert.match(hook(spool, { RUNNER_TEMP: temp }), /job ids missing/);
    writeFileSync(join(temp, "fenvix", "summary.json"), "not json");
    hook(spool, { RUNNER_TEMP: temp, GITHUB_REPOSITORY_ID: "1", GITHUB_RUN_ID: "2", GITHUB_RUN_ATTEMPT: "1" });
    assert.deepEqual(readdirSync(spool).filter((f) => !f.startsWith(".")), []);
  });

  it("the App down (5xx): kept for the next pass; refused (4xx): moved to rejected/; stale temp files cleaned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-runner-"));
    const spool = join(dir, "spool"); mkdirSync(spool);
    const token = join(dir, "token"); writeFileSync(token, "t".repeat(40));
    writeFileSync(join(spool, "1-1-1-a.json"), JSON.stringify({ repositoryId: 1, runId: 1, runAttempt: 1, summary: { tests: 1 } }));
    writeFileSync(join(spool, ".half.tmp"), "{");
    utimesSync(join(spool, ".half.tmp"), new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    const a = await app([503, 422]);
    try {
      assert.match(await poster(spool, a.url, token), /not sent \(503\).*will retry/);
      assert.ok(existsSync(join(spool, "1-1-1-a.json")));
      assert.ok(!existsSync(join(spool, ".half.tmp")));
      assert.match(await poster(spool, a.url, token), /refused \(422\)/);
      assert.ok(existsSync(join(spool, "rejected", "1-1-1-a.json")));
      assert.match(await poster("/nonexistent-spool-dir", a.url, token), /pass failed/);
    } finally { await a.close(); }
  });
});

describe("customer-mode spike (infra/customer-mode/spike)", () => {
  const SPIKE = fileURLToPath(new URL("../../customer-mode/spike/", import.meta.url));

  it("scripts are valid bash (shellcheck when installed); run-job.sh prints a valid sandbox configuration", () => {
    const sh = ["host-setup.sh", "build-guest.sh", "run-job.sh", "guest-kernel-docker-check.sh", "guest/fenvix-guest-job"];
    for (const f of sh) execFileSync("bash", ["-n", join(SPIKE, f)]);
    if (spawnSync("shellcheck", ["--version"]).status === 0) execFileSync("shellcheck", ["-x", ...sh.map((f) => join(SPIKE, f))]);
    const cfg = JSON.parse(execFileSync("bash", [join(SPIKE, "run-job.sh"), "--print-config"], { env: { PATH: process.env.PATH!, SLOT: "7" }, encoding: "utf8" }));
    assert.deepEqual(cfg.enclave, { direct_mode: true, cpu_overcommit: true, debug_mode: false });
    assert.deepEqual(cfg["machine-config"], { vcpu_count: 2, mem_size_mib: 2048 });
    assert.equal(cfg["network-interfaces"][0].guest_mac, "06:00:AC:10:07:02");
    assert.equal(cfg["network-interfaces"][0].host_dev_name, "fctap7");
    assert.deepEqual(cfg.drives.map((d: { drive_id: string; is_root_device: boolean }) => [d.drive_id, d.is_root_device]), [["rootfs", true], ["job", false]]);
    const bad = spawnSync("bash", [join(SPIKE, "run-job.sh"), "--print-config"], { env: { PATH: process.env.PATH!, SLOT: "0" } });
    assert.equal(bad.status, 2);
  });

  it("the Docker kernel check: passes a config with the required options, names a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-kcfg-"));
    const opts = ["NAMESPACES", "UTS_NS", "IPC_NS", "PID_NS", "NET_NS", "USER_NS", "CGROUPS", "MEMCG", "CGROUP_PIDS", "CGROUP_CPUACCT", "CGROUP_SCHED",
      "CPUSETS", "CGROUP_DEVICE", "CGROUP_FREEZER", "CGROUP_BPF", "KEYS", "SECCOMP", "SECCOMP_FILTER", "POSIX_MQUEUE", "OVERLAY_FS", "EXT4_FS", "VETH", "BRIDGE",
      "BRIDGE_NETFILTER", "NETFILTER", "NETFILTER_ADVANCED", "NF_NAT", "NF_CONNTRACK", "IP_NF_IPTABLES", "IP_NF_FILTER", "IP_NF_NAT", "IP_NF_TARGET_MASQUERADE",
      "NETFILTER_XT_MATCH_ADDRTYPE", "NETFILTER_XT_MATCH_CONNTRACK", "NETFILTER_XT_TARGET_MASQUERADE"];
    writeFileSync(join(dir, "good"), opts.map((o) => `CONFIG_${o}=y`).join("\n") + "\n");
    const good = spawnSync("bash", [join(SPIKE, "guest-kernel-docker-check.sh"), join(dir, "good")], { encoding: "utf8" });
    assert.equal(good.status, 0, good.stdout);
    assert.match(good.stdout, /missing required: 0/);
    writeFileSync(join(dir, "bad"), opts.filter((o) => o !== "OVERLAY_FS").map((o) => `CONFIG_${o}=y`).join("\n") + "\n# CONFIG_OVERLAY_FS is not set\n");
    const bad = spawnSync("bash", [join(SPIKE, "guest-kernel-docker-check.sh"), join(dir, "bad")], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /MISSING  CONFIG_OVERLAY_FS/);
  });
});
