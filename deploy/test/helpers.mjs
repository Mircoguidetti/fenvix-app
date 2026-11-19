// Fakes for the tests: an SSM Parameter Store in memory, and a capture of everything printed.
export class MemorySsm {
  constructor(initial = {}) { this.params = new Map(Object.entries(initial).map(([k, v]) => [k, { Value: v, Type: "SecureString", Version: 1 }])); this.calls = []; }
  async send(cmd) {
    const name = cmd.constructor.name, i = cmd.input;
    this.calls.push({ name, input: i });
    if (name === "DescribeParametersCommand") {
      const want = i.ParameterFilters[0].Values[0];
      return { Parameters: this.params.has(want) ? [{ Name: want }] : [] };
    }
    if (name === "GetParameterCommand") {
      const p = this.params.get(i.Name);
      if (!p) { const e = new Error("not found"); e.name = "ParameterNotFound"; throw e; }
      if (p.Type === "SecureString" && !i.WithDecryption) return { Parameter: { Name: i.Name, Value: "<encrypted>" } };
      return { Parameter: { Name: i.Name, Value: p.Value } };
    }
    if (name === "PutParameterCommand") {
      const p = this.params.get(i.Name);
      if (p && !i.Overwrite) { const e = new Error("exists"); e.name = "ParameterAlreadyExists"; throw e; }
      this.params.set(i.Name, { Value: i.Value, Type: i.Type, Version: (p?.Version ?? 0) + 1 });
      return { Version: (p?.Version ?? 0) + 1 };
    }
    throw new Error(`unexpected ${name}`);
  }
}

/** Runs fn with stdout and stderr captured; returns [result, text]. */
export async function captured(fn) {
  const out = [], ow = process.stdout.write.bind(process.stdout), ew = process.stderr.write.bind(process.stderr);
  const grab = (c) => { out.push(String(c)); return true; };
  process.stdout.write = grab; process.stderr.write = grab;
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => grab(a.join(" ") + "\n"); console.error = console.log;
  try { const r = await fn(); return [r, out.join("")]; } finally {
    process.stdout.write = ow; process.stderr.write = ew; console.log = origLog; console.error = origErr;
  }
}
