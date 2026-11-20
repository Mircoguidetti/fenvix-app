import type { MachineDriver } from "../../src/machines/driver.ts";
import type { Region } from "../../src/runners/launcher.ts";

/** EC2 in memory, for the machine pool: what was launched, started, stopped, terminated, and with which user data. */
export class FakeDriver implements MachineDriver {
  instances = new Map<string, { region: Region; instanceType: string; market: string; state: "running" | "stopped" | "terminated"; userData: string; machineId: number; tokens: string[] }>();
  calls: string[] = [];
  failNextLaunch: Error | null = null;
  private n = 0;

  async launch(o: Parameters<MachineDriver["launch"]>[0]): Promise<string> {
    if (this.failNextLaunch) { const e = this.failNextLaunch; this.failNextLaunch = null; throw e; }
    const already = [...this.instances.entries()].find(([, i]) => i.tokens.includes(o.clientToken));
    if (already) return already[0];
    const id = `i-${(0x10000000 + ++this.n).toString(16)}`;
    this.instances.set(id, { region: o.region, instanceType: o.instanceType, market: o.market, state: "running", userData: o.userData, machineId: Number(o.tags["fenvix:machine"]), tokens: [o.clientToken] });
    this.calls.push(`launch ${id} ${o.instanceType} ${o.market}`);
    return id;
  }
  async start(o: { region: Region; instanceId: string; userData: string }): Promise<void> {
    const i = this.instances.get(o.instanceId)!;
    if (i.state !== "stopped") throw new Error(`IncorrectInstanceState: ${o.instanceId} is ${i.state}`);
    i.userData = o.userData; i.state = "running";
    this.calls.push(`start ${o.instanceId}`);
  }
  async stop(o: { region: Region; instanceId: string }): Promise<void> {
    this.instances.get(o.instanceId)!.state = "stopped";
    this.calls.push(`stop ${o.instanceId}`);
  }
  async terminate(o: { region: Region; instanceIds: string[] }): Promise<void> {
    for (const id of o.instanceIds) { const i = this.instances.get(id); if (i) i.state = "terminated"; this.calls.push(`terminate ${id}`); }
  }
  async list(region: Region) {
    return [...this.instances.entries()].filter(([, i]) => i.region === region && i.state !== "terminated").map(([instanceId, i]) => ({ instanceId, state: i.state, machineId: i.machineId }));
  }
  /** The settings a machine boots with (its user data). */
  settingsOf(instanceId: string): Record<string, string> {
    return Object.fromEntries(this.instances.get(instanceId)!.userData.split("\n").filter((l) => /^[A-Z]/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  }
}
