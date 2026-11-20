// Our machines (P-047, F-15), the machine side: the slot sandbox (real processes, mounts and packets, as root), the
// metadata block, and the agent's flow against a stand-in API. docs/REPORT-our-machines.md maps them to audit gaps.
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const FILES = fileURLToPath(new URL("../lib/runner/files/", import.meta.url));
const ISOLATION = fileURLToPath(new URL("./sandbox/isolation.sh", import.meta.url));
const IMAGE_INSTALL = fileURLToPath(new URL("./sandbox/image-install.sh", import.meta.url));
const read = (f: string) => readFileSync(join(FILES, f), "utf8");

/** Root, or passwordless sudo (the GitHub-hosted runner of the Tests workflow). Never skipped: no root, no pass. */
function asRoot(args: string[]): { status: number | null; out: string } {
  const root = process.getuid?.() === 0;
  const r = spawnSync(root ? args[0]! : "sudo", root ? args.slice(1) : ["-n", ...args], { encoding: "utf8", timeout: 170_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("our machines: the slot sandbox and the metadata block (real, as root)", () => {
  it("I1-I5 isolation: no residue after a wipe, slots blind to each other, metadata root-only, no secrets, no symlink read by root", { timeout: 180_000 }, () => {
    const r = asRoot(["bash", ISOLATION]);
    const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
    for (const id of ["I1", "I2", "I3", "I4", "I5", "I6"]) assert.ok(lines.some((l) => l.startsWith(`ok ${id}`)), `${id} did not pass:\n${r.out}`);
    assert.deepEqual(lines.filter((l) => l.startsWith("FAIL")), [], r.out);
    assert.equal(r.status, 0, r.out);
  });

  it("N3 family: the metadata block matches every uid but root (not a list of users)", () => {
    const s = read("fenvix-imds-block");
    assert.match(s, /169\.254\.169\.254 -m owner ! --uid-owner 0 -j REJECT/);
    assert.match(s, /fd00:ec2::254 -m owner ! --uid-owner 0 -j REJECT/);
    assert.doesNotMatch(s, /for u in/);
  });

  it("N1 family: root never opens a path inside a slot; it reads through the slot user (fenvix-slot read)", () => {
    const agent = read("fenvix-agent");
    assert.doesNotMatch(agent, /open\([^)]*fenvix-out/, "the agent opens no file of a slot itself");
    assert.match(agent, /\[SLOT, "read", str\(n\), "fenvix-out\/summary\.json"\]/);
    assert.match(read("fenvix-slot"), /as_slot head -c/);
    // The jitconfig is read back as the slot user too.
    assert.match(read("fenvix-slot"), /jit="\$\(as_slot cat -- "\$home\/\.fenvix\/jitconfig"\)"/);
  });

  it("scripts parse (shellcheck in CI)", () => {
    for (const f of ["fenvix-slot", "fenvix-imds-block", "fenvix-job-started"]) assert.equal(spawnSync("bash", ["-n", join(FILES, f)]).status, 0, f);
    if (spawnSync("shellcheck", ["--version"]).status === 0) {
      const r = spawnSync("shellcheck", ["-s", "bash", ...["fenvix-slot", "fenvix-imds-block", "fenvix-job-started", "fenvix-replay", "install.sh"].map((f) => join(FILES, f)), ISOLATION, IMAGE_INSTALL, fileURLToPath(new URL("./sandbox/probe-runner.sh", import.meta.url))], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout);
    }
  });
});

describe("our machines: the image installs the TRUNK engine by its pin, fail closed (G-0186)", () => {
  it("pinned: installed and its version recorded; no pin, another checksum, a bad archive, another runner: the build stops, nothing installed", { timeout: 180_000 }, () => {
    const r = asRoot(["bash", IMAGE_INSTALL]);
    for (const c of ["ok", "nopin", "badsum", "badlayout", "badrunner"]) assert.ok(r.out.split("\n").some((l) => l.startsWith(`ok ${c} `)), `${c}:\n${r.out}`);
    assert.equal(r.status, 0, r.out);
  });

  it("the job log prints the engine version and the run mode (fenvix-job-started)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-started-"));
    writeFileSync(join(dir, "hook"), read("fenvix-job-started").replace("/opt/fenvix/ENGINE", join(dir, "ENGINE")));
    writeFileSync(join(dir, "ENGINE"), "0.4.0-r17.abc1234 sha256=" + "c".repeat(64) + "\n");
    const r = spawnSync("bash", [join(dir, "hook")], { encoding: "utf8", env: { PATH: process.env.PATH!, FENVIX_MODE: "shadow", FENVIX_SKIP: "0", FENVIX_REGION: "eu" } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^fenvix: engine 0\.4\.0-r17\.abc1234 sha256=c{64}$/m);
    assert.match(r.stdout, /mode shadow, skip with proof 0, region eu/);
  });
});

describe("our machines: a replay in its slot (fenvix-replay, as the slot user)", () => {
  const sh = (cmd: string, cwd: string) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  function fixture(engineOut: string) {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-replay-"));
    // The customer's repository at one commit (a local bare repository stands in for github.com).
    sh("git init -q src && cd src && printf 'def test_x():\\n    assert True\\n' > test_x.py && git add . && git -c user.email=a@b -c user.name=a commit -qm one && git clone -q --bare . ../acme/shop.git", dir);
    const sha = sh("git -C src rev-parse HEAD", dir).stdout.trim();
    // The engine: records its arguments, prints a repro result.
    writeFileSync(join(dir, "fenvix"), `#!/usr/bin/env bash\necho "$*" > "${dir}/args"\n${engineOut}\n`);
    chmodSync(join(dir, "fenvix"), 0o755);
    mkdirSync(join(dir, "home", ".fenvix"), { recursive: true });
    writeFileSync(join(dir, "home", ".fenvix", "checkout-token"), "ghs_token");
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ kind: "replay", replayId: 3, repository: "acme/shop", commitSha: sha, testId: "test_x.py::test_x", times: 3, seed: 7, fingerprint: "a".repeat(32) }));
    return { dir, sha };
  }
  const run = (dir: string) => {
    const r = spawnSync("bash", [join(FILES, "fenvix-replay"), join(dir, "spec.json")], {
      encoding: "utf8", timeout: 120_000,
      env: { PATH: process.env.PATH!, HOME: join(dir, "home"), FENVIX_OUT: join(dir, "out"), FENVIX_GIT_BASE: `file://${dir}`, FENVIX_BIN: join(dir, "fenvix"), FENVIX_WHEELS: join(dir, "nowheels"), PIP_NO_INDEX: "1" },
    });
    return { status: r.status, out: JSON.parse(readFileSync(join(dir, "out", "replay.json"), "utf8")) as Record<string, unknown> };
  };

  it("the run's commit checked out; the engine rebuilds the defect under its seed, N times; the token file is gone; reproduced with the stored fingerprint", { timeout: 180_000 }, () => {
    const fp = "a".repeat(32);
    const { dir, sha } = fixture(`echo '{"status": "REPRODUCED", "cause": "test order", "replay": {"runs": 3, "fails": 3, "fingerprints": ["${fp}", "${fp}", "${fp}"], "identical_fingerprint": true}}'`);
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.deepEqual(r.out, { done: 3, fails: 3, identicalFingerprint: true, matchesDefect: true, detail: "REPRODUCED: test order" });
    assert.match(readFileSync(join(dir, "args"), "utf8"), /^repro test_x\.py::test_x --python \S+\/work\/venv\/bin\/python --seed 7 --confirm 3 --json --out /);
    assert.equal(sh("git -C home/work/src rev-parse HEAD", dir).stdout.trim(), sha);
    assert.equal(existsSync(join(dir, "home", ".fenvix", "checkout-token")), false, "the checkout token is deleted once used");
  });

  it("another fingerprint: matchesDefect false; no result from the engine: done 0 with its last line", { timeout: 180_000 }, () => {
    const a = fixture(`echo '{"status": "REPRODUCED", "replay": {"runs": 3, "fails": 3, "fingerprints": ["${"b".repeat(32)}"], "identical_fingerprint": true}}'`);
    assert.equal(run(a.dir).out.matchesDefect, false);
    const b = fixture(`echo "fenvix: repro / explore / replay are not available for vitest in this version" >&2; exit 2`);
    const out = run(b.dir).out;
    assert.equal(out.done, 0);
    assert.match(String(out.detail), /the engine gave no result: fenvix: repro .* not available for vitest/);
  });
});

describe("our machines: fenvix-agent against a stand-in API", () => {
  it("hello with the boot secret; a lease into a slot; the job's summary sent with the JOB's credential; finished; retire", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-agent-"));
    const calls: { path: string; auth: string; body: Record<string, unknown> }[] = [];
    let polls = 0;
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c.toString(); });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        calls.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body });
        const send = (s: number, b: object) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
        if (req.url === "/v1/runner/machine/hello") return body.bootSecret === "b".repeat(64) ? send(200, { token: "fxm1.session", mode: "work", pollSeconds: 2 }) : send(401, {});
        if (req.url === "/v1/runner/machine/poll") {
          polls++;
          if (polls === 1) return send(200, { leases: [{ leaseId: 7, slot: 1, kind: "job", work: { kind: "job", jitConfig: "abc=", summaryToken: "fxr1.job-credential", env: { FENVIX_RUN_ID: "555" } } }], stop: [], retire: false });
          const finished = calls.some((c) => c.path === "/v1/runner/machine/events" && c.body.type === "finished");
          return send(200, { leases: [], stop: [], retire: finished });
        }
        if (req.url === "/v1/runner/machine/events") return send(202, { ok: true });
        if (req.url === "/v1/runner/summaries") return send(202, { ok: true });
        send(404, {});
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    // A stand-in slot tool: records what the agent asks, and plays a job that wrote a summary.
    const slot = join(dir, "fenvix-slot");
    writeFileSync(slot, `#!/usr/bin/env bash\necho "$*" >>"${dir}/slot.log"\ncase "$1" in run) sleep 0.5 ;; read) echo '{"testsRun": 3}' ;; esac\n`);
    chmodSync(slot, 0o755);
    writeFileSync(join(dir, "ENGINE"), "0.1.0-r42.abcdef1 sha256=" + "f".repeat(64));
    const userData = [`FENVIX_MACHINE_ID=12`, `FENVIX_BOOT_SECRET=${"b".repeat(64)}`, `FENVIX_API_URL=http://127.0.0.1:${port}`, `FENVIX_SUMMARIES_URL=http://127.0.0.1:${port}/v1/runner/summaries`, "FENVIX_POLL_SECONDS=0.2"].join("\n");
    const p = spawn("python3", ["-I", join(FILES, "fenvix-agent")], {
      env: { PATH: process.env.PATH!, FENVIX_USER_DATA_TEXT: userData, FENVIX_SLOT_BIN: slot, FENVIX_AGENT_STATE: join(dir, "state"), FENVIX_ENGINE_FILE: join(dir, "ENGINE"), FENVIX_ALLOW_HTTP: "1", FENVIX_NO_POWEROFF: "1", FENVIX_IMDS: "http://127.0.0.1:9" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    p.stdout.on("data", (b: Buffer) => { log += b.toString(); });
    p.stderr.on("data", (b: Buffer) => { log += b.toString(); });
    const code = await new Promise<number | null>((r) => p.on("exit", r));
    server.close();
    assert.equal(code, 0, log);
    const hello = calls.find((c) => c.path === "/v1/runner/machine/hello")!;
    assert.deepEqual(hello.body, { machineId: 12, bootSecret: "b".repeat(64), engineVersion: "0.1.0-r42.abcdef1 sha256=" + "f".repeat(64) });
    assert.ok(calls.filter((c) => c.path === "/v1/runner/machine/poll").every((c) => c.auth === "Bearer fxm1.session"), "polls use the session credential");
    const sum = calls.find((c) => c.path === "/v1/runner/summaries")!;
    assert.equal(sum.auth, "Bearer fxr1.job-credential", "the summary goes with the job's own credential, not the machine's");
    assert.deepEqual(sum.body, { runId: 555, summary: { testsRun: 3 } });
    const slotLog = readFileSync(join(dir, "slot.log"), "utf8").trim().split("\n").map((l) => l.split(" ").slice(0, 2).join(" "));
    assert.deepEqual(slotLog, ["prepare 1", "run 1", "read 1", "wipe 1"], "prepare, run, summary read as the slot user, wipe");
    const fin = calls.find((c) => c.path === "/v1/runner/machine/events")!;
    assert.deepEqual({ type: fin.body.type, leaseId: fin.body.leaseId }, { type: "finished", leaseId: 7 });
    // The lease's work file (it holds the job's credentials) is gone once the slot is prepared.
    assert.equal(existsSync(join(dir, "state", "lease-7.json")), false);
  });
});

describe("our machines: fenvix-agent runs a replay lease", () => {
  it("replay: prepared and run in a slot, its outcome read as the slot user and sent with the machine's session; no job summary", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-agent-replay-"));
    const calls: { path: string; auth: string; body: Record<string, unknown> }[] = [];
    let polls = 0;
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c.toString(); });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        calls.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body });
        const send = (st: number, b: object) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
        if (req.url === "/v1/runner/machine/hello") return send(200, { token: "fxm1.session", mode: "work", pollSeconds: 2 });
        if (req.url === "/v1/runner/machine/poll") {
          polls++;
          if (polls === 1) return send(200, { leases: [{ leaseId: 9, slot: 2, kind: "replay", work: { kind: "replay", replayId: 4, repository: "acme/shop", commitSha: "c".repeat(40), checkoutToken: "ghs_x", testId: "t", times: 10, seed: 3, fingerprint: "f".repeat(32) } }], stop: [], retire: false });
          return send(200, { leases: [], stop: [], retire: calls.some((c) => c.path === "/v1/runner/machine/events") });
        }
        send(202, { ok: true });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const slot = join(dir, "fenvix-slot");
    writeFileSync(slot, `#!/usr/bin/env bash\necho "$*" >>"${dir}/slot.log"\ncase "$1:$3" in run:*) sleep 0.3 ;; read:fenvix-out/replay.json) echo '{"done": 10, "fails": 10, "identicalFingerprint": true, "matchesDefect": true, "detail": "REPRODUCED"}' ;; esac\n`);
    chmodSync(slot, 0o755);
    const userData = [`FENVIX_MACHINE_ID=5`, `FENVIX_BOOT_SECRET=${"b".repeat(64)}`, `FENVIX_API_URL=http://127.0.0.1:${port}`, "FENVIX_POLL_SECONDS=0.2"].join("\n");
    const p = spawn("python3", ["-I", join(FILES, "fenvix-agent")], { env: { PATH: process.env.PATH!, FENVIX_USER_DATA_TEXT: userData, FENVIX_SLOT_BIN: slot, FENVIX_AGENT_STATE: join(dir, "state"), FENVIX_ENGINE_FILE: join(dir, "none"), FENVIX_ALLOW_HTTP: "1", FENVIX_NO_POWEROFF: "1", FENVIX_IMDS: "http://127.0.0.1:9" }, stdio: "ignore" });
    const code = await new Promise<number | null>((r) => p.on("exit", r));
    server.close();
    assert.equal(code, 0);
    const rep = calls.find((c) => c.path === "/v1/runner/replays")!;
    assert.equal(rep.auth, "Bearer fxm1.session");
    assert.deepEqual(rep.body, { leaseId: 9, done: 10, fails: 10, identicalFingerprint: true, matchesDefect: true, detail: "REPRODUCED" });
    assert.ok(!calls.some((c) => c.path === "/v1/runner/summaries"), "a replay is not a run: no summary");
    const order = readFileSync(join(dir, "slot.log"), "utf8").trim().split("\n").map((l) => l.split(" ").slice(0, 2).join(" "));
    assert.deepEqual(order, ["prepare 2", "run 2", "read 2", "wipe 2"]);
  });
});
