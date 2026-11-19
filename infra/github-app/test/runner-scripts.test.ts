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
    const sh = ["install.sh", "fenvix-imds-block", "fenvix-register", "fenvix-summary-credential", "fenvix-job-completed", "fenvix-job-started", "fenvix-jit-prepare", "fenvix-job-done", "fenvix-idle-watchdog",
      "fenvix-warmup", "fenvix-warmup-prepare", "fenvix-warmup-done"];
    for (const f of sh) execFileSync("bash", ["-n", join(FILES, f)]);
    if (spawnSync("shellcheck", ["--version"]).status === 0) execFileSync("shellcheck", ["-s", "bash", ...sh.map((f) => join(FILES, f))]);
    execFileSync("python3", ["-I", "-c", `import ast,sys; ast.parse(open(sys.argv[1]).read())`, join(FILES, "fenvix-summary-poster")]);
    execFileSync("python3", ["-I", "-c", `import ast,sys; ast.parse(open(sys.argv[1]).read())`, join(FILES, "fenvix-warmup-report")]);
  });

  it("job-completed hook → spool → poster: the App gets the job's ids, this machine's runner name, its credential", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-runner-"));
    const spool = join(dir, "spool"); mkdirSync(spool);
    const temp = join(dir, "runner-temp"); mkdirSync(join(temp, "fenvix"), { recursive: true });
    writeFileSync(join(temp, "fenvix", "summary.json"), readFileSync(SUMMARY));
    const token = join(dir, "token"); writeFileSync(token, "fxr1.eyJuIjoiZmVudml4LWVjMi0xIn0.c2lnbmF0dXJl\n");
    // A job that claims another runner name: the poster sends its own.
    const out = hook(spool, { RUNNER_TEMP: temp, GITHUB_REPOSITORY_ID: "70001", GITHUB_RUN_ID: "9001", GITHUB_RUN_ATTEMPT: "2", RUNNER_NAME: "someone-else" });
    assert.match(out, /summary queued for run 9001 attempt 2/);
    assert.equal(readdirSync(spool).filter((f) => !f.startsWith(".")).length, 1);

    const a = await app([202]);
    try {
      assert.match(await poster(spool, a.url, token), /sent \(202\)/);
      assert.equal(a.got.length, 1);
      assert.equal(a.got[0]!.auth, "Bearer fxr1.eyJuIjoiZmVudml4LWVjMi0xIn0.c2lnbmF0dXJl");
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

  it("scripts are valid bash (shellcheck: optional locally, required in CI); run-job.sh prints a valid sandbox configuration", () => {
    const sh = ["host-setup.sh", "build-guest.sh", "run-job.sh", "guest-kernel-docker-check.sh", "guest/fenvix-guest-job"];
    for (const f of sh) execFileSync("bash", ["-n", join(SPIKE, f)]);
    const haveShellcheck = spawnSync("shellcheck", ["--version"]).status === 0;
    // Locally shellcheck is optional; in CI a missing binary must fail, never skip silently.
    if (process.env.GITHUB_ACTIONS === "true") assert.ok(haveShellcheck, "shellcheck must be installed in CI (GITHUB_ACTIONS=true)");
    if (haveShellcheck) execFileSync("shellcheck", ["-x", ...sh.map((f) => join(SPIKE, f))], { stdio: ["ignore", "pipe", "pipe"] });
    const cfg = JSON.parse(execFileSync("bash", [join(SPIKE, "run-job.sh"), "--print-config"], { env: { PATH: process.env.PATH!, SLOT: "7" }, encoding: "utf8" }));
    assert.deepEqual(cfg.enclave, { direct_mode: true, cpu_overcommit: true, debug_mode: false });
    assert.deepEqual(cfg["machine-config"], { vcpu_count: 2, mem_size_mib: 2048 });
    assert.equal(cfg["network-interfaces"][0].guest_mac, "06:00:AC:10:07:02");
    assert.equal(cfg["network-interfaces"][0].host_dev_name, "fctap7");
    // The input disk is read-only for the guest; results come back on a raw disk the host parses in userspace (R-012 F9).
    assert.deepEqual(cfg.drives.map((d: { drive_id: string; is_root_device: boolean; is_read_only: boolean }) => [d.drive_id, d.is_root_device, d.is_read_only]),
      [["rootfs", true, false], ["input", false, true], ["result", false, false]]);
    assert.ok(cfg["network-interfaces"][0].rx_rate_limiter && cfg["network-interfaces"][0].tx_rate_limiter, "per-sandbox bandwidth limits (R-012 F10)");
    const bad = spawnSync("bash", [join(SPIKE, "run-job.sh"), "--print-config"], { env: { PATH: process.env.PATH!, SLOT: "0" } });
    assert.equal(bad.status, 2);
  });

  it("the result reader: only a well-formed record, size-capped; never the guest's ids or runner name (R-012 F9)", () => {
    const read = (bytes: Buffer) => JSON.parse(execFileSync("python3", ["-I", join(SPIKE, "read-result.py")], { input: bytes, encoding: "utf8" }));
    const rec = (o: unknown) => { const b = Buffer.from(JSON.stringify(o)); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([Buffer.from("FXRES001"), n, b, Buffer.alloc(1024)]); };
    const summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
    assert.deepEqual(read(rec({ summary, t_guest_up: 1.5, t_job_done: 9, repositoryId: 666, runnerName: "fenvix-j666" })), { summary, t_guest_up: 1.5, t_job_done: 9 });
    assert.deepEqual(read(Buffer.alloc(4096)), { summary: null, error: "no result record" });
    const huge = Buffer.concat([Buffer.from("FXRES001"), Buffer.from([0x7f, 0xff, 0xff, 0xff])]);
    assert.match(read(huge).error, /refused/);
    assert.equal(read(rec([1, 2])).summary, null);
    const runJob = readFileSync(join(SPIKE, "run-job.sh"), "utf8");
    assert.match(runJob, /trap cleanup EXIT/, "no disk of a job stays on the host when a step fails");
    assert.match(runJob, /jailer --id/, "Firecracker under the jailer, not as root (R-012 F17)");
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

describe("warm-up machine scripts", () => {
  /** One run of fenvix-warmup-report against a stand-in for POST /v1/runner/warmups. */
  async function report(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile("python3", ["-I", join(FILES, "fenvix-warmup-report"), ...args], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8", timeout: 60_000 },
        (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }));
    });
  }

  it("an image without the runner's warm-up executor: the outcome is unsupported (the machine still reports it)", () => {
    const home = mkdtempSync(join(tmpdir(), "fenvix-warm-"));
    execFileSync("bash", [join(FILES, "fenvix-warmup")], { env: { PATH: process.env.PATH!, HOME: home } });
    const o = JSON.parse(readFileSync(join(home, ".fenvix", "warmup-out", "outcome.json"), "utf8"));
    assert.equal(o.outcome, "unsupported");
    assert.match(o.detail, /no warm-up executor/);
  });

  it("an executor that exits without an outcome: failed, with its exit code", () => {
    const home = mkdtempSync(join(tmpdir(), "fenvix-warm-"));
    mkdirSync(join(home, "engine-cli", "runner"), { recursive: true });
    writeFileSync(join(home, "engine-cli", "runner", "warmup.sh"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    execFileSync("bash", [join(FILES, "fenvix-warmup")], { env: { PATH: process.env.PATH!, HOME: home } });
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".fenvix", "warmup-out", "outcome.json"), "utf8")), { outcome: "failed", detail: "the warm-up executor exited with 3" });
  });

  it("the executor gets the description and the output directory; its outcome is kept", () => {
    const home = mkdtempSync(join(tmpdir(), "fenvix-warm-"));
    mkdirSync(join(home, "engine-cli", "runner"), { recursive: true });
    writeFileSync(join(home, "engine-cli", "runner", "warmup.sh"), '#!/bin/sh\nprintf \'{"outcome":"succeeded","detail":"%s"}\' "$(basename "$1")" >"$2/outcome.json"\n', { mode: 0o755 });
    execFileSync("bash", [join(FILES, "fenvix-warmup")], { env: { PATH: process.env.PATH!, HOME: home } });
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".fenvix", "warmup-out", "outcome.json"), "utf8")), { outcome: "succeeded", detail: "warmup.json" });
  });

  it("the report: this machine's credential and names, the outcome and the summary; retried on 5xx, given up on 4xx", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-warm-"));
    const token = join(dir, "token"); writeFileSync(token, "fxr1.eyJuIjoiZmVudml4LXc3In0.c2lnbmF0dXJl\n");
    const outcome = join(dir, "outcome.json"); writeFileSync(outcome, JSON.stringify({ outcome: "succeeded", detail: "warm" }));
    const summary = join(dir, "summary.json"); writeFileSync(summary, readFileSync(SUMMARY));
    const srv = await app([503, 202]);
    const env = { FENVIX_WARMUPS_URL: srv.url.replace("summaries", "warmups"), FENVIX_WARMUP_ID: "7", FENVIX_RUNNER_NAME: "fenvix-w7", FENVIX_TOKEN_FILE: token };
    try {
      const r = await report(["finished", outcome, summary], env);
      assert.equal(r.code, 0, r.out);
      assert.equal(srv.got.length, 2, "tried again after the 503");
      const b = srv.got[1]!.body;
      assert.equal(srv.got[1]!.auth, "Bearer fxr1.eyJuIjoiZmVudml4LXc3In0.c2lnbmF0dXJl");
      assert.deepEqual({ ...b, summary: undefined }, { warmupId: 7, runnerName: "fenvix-w7", event: "finished", outcome: "succeeded", detail: "warm", summary: undefined });
      assert.deepEqual(b.summary, JSON.parse(readFileSync(SUMMARY, "utf8")));
      const started = await report(["started"], env);
      assert.equal(started.code, 0);
      assert.deepEqual(srv.got[2]!.body, { warmupId: 7, runnerName: "fenvix-w7", event: "started" });
    } finally { await srv.close(); }
    const refused = await app([403]);
    try {
      const r = await report(["started"], { FENVIX_WARMUPS_URL: refused.url, FENVIX_WARMUP_ID: "7", FENVIX_RUNNER_NAME: "fenvix-w7", FENVIX_TOKEN_FILE: token });
      assert.equal(r.code, 1);
      assert.equal(refused.got.length, 1, "a 4xx is not retried");
      assert.match(r.out, /refused 403/);
    } finally { await refused.close(); }
  });

  it("an outcome the machine does not know is reported as failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-warm-"));
    const token = join(dir, "token"); writeFileSync(token, "fxr1.a.b\n");
    const outcome = join(dir, "outcome.json"); writeFileSync(outcome, JSON.stringify({ outcome: "great" }));
    const srv = await app([202]);
    try {
      const r = await report(["finished", outcome], { FENVIX_WARMUPS_URL: srv.url, FENVIX_WARMUP_ID: "8", FENVIX_RUNNER_NAME: "fenvix-w8", FENVIX_TOKEN_FILE: token });
      assert.equal(r.code, 0);
      assert.deepEqual(srv.got[0]!.body, { warmupId: 8, runnerName: "fenvix-w8", event: "finished", outcome: "failed" });
    } finally { await srv.close(); }
  });
});
