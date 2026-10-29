import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useOrg } from "../session/OrgProvider";
import { AlertTriangle, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { network } from "../data/network-client";
import type { IpAllowlist, NetworkBlock } from "../data/network";
import type { Database } from "../data";
import { addEntries, MAX_ENTRIES, parseImport, parseNetwork } from "../lib/ip-allowlist";
import { formatDateTime } from "../lib/format";
import { Card, Message } from "./PageHeader";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";

/**
 * The Network tab of a database: its IP allowlist and the addresses blocked after failed sign-ins.
 *
 * Changes are made on a draft in the page and sent together with "Save list", after a confirmation: the page cannot know
 * the address the customer's applications connect from, so it cannot tell whether the list leaves them out. Every value
 * is rendered as React text. A member sees the list read only and not the blocked addresses.
 */
type Dialog = "save" | "clear" | "import" | null;

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DatabaseNetwork({ db }: { db: Database }) {
  const { canManage } = useOrg();
  const toast = useToast();
  const [data, setData] = useState<IpAllowlist | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [addValue, setAddValue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocks, setBlocks] = useState<NetworkBlock[] | null>(null);
  const [blocksError, setBlocksError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setData(await network.getAllowlist(db.id));
    } catch (e) {
      setData(null);
      setLoadError(message(e));
    }
  }, [db.id]);

  const loadBlocks = useCallback(async () => {
    if (!canManage) return;
    setBlocksError(null);
    try {
      setBlocks(await network.listBlocks(db.id));
    } catch (e) {
      setBlocks(null);
      setBlocksError(message(e));
    }
  }, [db.id, canManage]);

  useEffect(() => {
    void load();
    void loadBlocks();
  }, [load, loadBlocks]);

  const saved = data?.entries ?? [];
  const list = draft ?? saved;
  const changed = draft !== null && (draft.length !== saved.length || draft.some((e, i) => e !== saved[i]));
  const imported = parseImport(importText);

  function open(next: Dialog) {
    setDialogError(null);
    setBusy(false);
    setChecked(false);
    if (next === "import") setImportText("");
    setDialog(next);
  }

  function add(e: FormEvent) {
    e.preventDefault();
    const text = addValue.trim();
    if (!text) return setAddError("Enter an IP address, for example 203.0.113.7, or a network, for example 10.0.0.0/8.");
    const r = parseNetwork(text);
    if (!r.ok) return setAddError(`"${text}" ${r.problem}`);
    if (list.includes(r.text)) return setAddError(`${r.text} is already in the list.`);
    try {
      setDraft(addEntries(list, [r.text]).list);
    } catch (x) {
      return setAddError(message(x));
    }
    setAddValue("");
    setAddError(null);
  }

  function addImported() {
    try {
      const r = addEntries(list, imported.entries);
      setDraft(r.list);
      setDialog(null);
      const n = imported.entries.length - r.skipped;
      toast(r.skipped ? `Added ${plural(n, "entry", "entries")}; ${plural(r.skipped, "was", "were")} already in the list` : `Added ${plural(n, "entry", "entries")}`);
    } catch (x) {
      setDialogError(message(x));
    }
  }

  async function send(entries: string[], done: string) {
    setBusy(true);
    setDialogError(null);
    try {
      setData(await network.setAllowlist(db.id, entries));
      setDraft(null);
      setDialog(null);
      toast(done);
    } catch (e) {
      setDialogError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function reapply() {
    try {
      setData(await network.reapplyAllowlist(db.id));
      toast("Applied the saved IP allowlist again");
    } catch (e) {
      toast(message(e));
    }
  }

  async function unblock(ip: string) {
    try {
      await network.unblock(db.id, ip);
      toast(`Unblocked ${ip}`);
    } catch (e) {
      toast(message(e));
    }
    await loadBlocks();
  }

  const summary = list.length === 0 ? "All IP addresses are allowed." : `${plural(list.length, "address or network", "addresses and networks")} can connect. Every other address is refused.`;

  return (
    <>
      <Card
        id="allowlist"
        title="IP allowlist"
        description="Only these addresses can connect to the database. The dashboard's Data Explorer is not affected by the list."
      >
        {!data && !loadError && <Message>Loading IP allowlist</Message>}
        {loadError && (
          <div className="stack">
            <Message role="alert">{loadError}</Message>
            <div className="row-actions">
              <button type="button" className="btn" onClick={() => void load()}>
                <RefreshCw size={16} aria-hidden="true" />
                Try again
              </button>
            </div>
          </div>
        )}
        {data && (
          <div className="net">
            <p className="net-summary" role="status">
              <strong>{summary}</strong>
              {changed && <span className="tag">Unsaved changes</span>}
            </p>

            {data.dataExplorer.trusted === false && (
              <p className="once-warning" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>On this server the Data Explorer is checked against the list too, until the server is set up to trust it. A list that leaves it out stops it from showing this database's data.</span>
              </p>
            )}
            {data.engine.status === "different" && (
              <div className="callout" role="alert">
                <p className="net-callout-text">
                  The database is checking a different list from the saved one
                  {data.engine.entries && data.engine.entries.length > 0 ? `: ${data.engine.entries.join(", ")}` : ": no list, so every address can connect"}.
                </p>
                {canManage && (
                  <div className="row-actions">
                    <button type="button" className="btn" onClick={() => void reapply()}>
                      Apply again
                    </button>
                  </div>
                )}
              </div>
            )}
            {data.engine.status === "unavailable" && <Message>Could not check the list the database is using right now. The saved list is shown.</Message>}
            {data.engine.enforced === false && <Message>The database server does not check sign-ins at the moment, so the list has no effect yet.</Message>}

            {list.length > 0 && (
              <ul className="net-list" aria-label="IP allowlist entries">
                {list.map((e) => (
                  <li key={e} className="net-row">
                    <span className="mono net-entry">{e}</span>
                    {canManage && (
                      <button type="button" className="btn btn-sm" onClick={() => setDraft(list.filter((x) => x !== e))} aria-label={`Remove ${e}`}>
                        <Trash2 size={15} aria-hidden="true" />
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {canManage ? (
              <>
                <form className="net-add" onSubmit={add} noValidate>
                  <div className="field grow">
                    <label htmlFor="net-add">Address or network</label>
                    <input
                      id="net-add"
                      className="mono"
                      value={addValue}
                      onChange={(e) => (setAddValue(e.target.value), setAddError(null))}
                      placeholder="203.0.113.7 or 10.0.0.0/8"
                      autoComplete="off"
                      spellCheck={false}
                      inputMode="text"
                      aria-describedby="net-add-help"
                      aria-invalid={addError ? true : undefined}
                    />
                  </div>
                  <button type="submit" className="btn" disabled={list.length >= MAX_ENTRIES}>
                    <Plus size={16} aria-hidden="true" />
                    Add
                  </button>
                </form>
                <p id="net-add-help" className="muted small">
                  An IPv4 or IPv6 address, or a network in CIDR form. Up to {MAX_ENTRIES} entries; {list.length} used.
                </p>
                {addError && (
                  <p className="error" role="alert">
                    {addError}
                  </p>
                )}
                <div className="row-actions">
                  <button type="button" className="btn btn-primary" disabled={!changed} onClick={() => open(list.length === 0 ? "clear" : "save")}>
                    Save list
                  </button>
                  {changed && (
                    <button type="button" className="btn" onClick={() => (setDraft(null), setAddError(null))}>
                      Discard changes
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => open("import")}>
                    <Upload size={16} aria-hidden="true" />
                    Import
                  </button>
                  {saved.length > 0 && (
                    <button type="button" className="btn btn-danger" onClick={() => open("clear")}>
                      Clear list
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="readonly-note">Only an owner or admin can change the IP allowlist.</p>
            )}

            {data.updatedAt && (
              <p className="muted small">
                Last changed {formatDateTime(data.updatedAt)}
                {data.updatedBy?.name ? ` by ${data.updatedBy.type === "api_key" ? `the API key ${data.updatedBy.name}` : data.updatedBy.name}` : ""}.
              </p>
            )}
          </div>
        )}
      </Card>

      <Card
        id="blocks"
        title="Blocked addresses"
        description="An address that fails to sign in to this database 5 times within a minute is refused for 5 minutes, then for longer each time it happens again, up to an hour. Even the right password is refused while it is blocked."
        actions={
          canManage ? (
            <button type="button" className="btn btn-sm" onClick={() => void loadBlocks()}>
              <RefreshCw size={15} aria-hidden="true" />
              Refresh
            </button>
          ) : undefined
        }
      >
        {!canManage && <p className="readonly-note">Only an owner or admin can see and unblock blocked addresses.</p>}
        {canManage && !blocks && !blocksError && <Message>Loading blocked addresses</Message>}
        {canManage && blocksError && <Message role="alert">{blocksError}</Message>}
        {canManage && blocks && blocks.length === 0 && <p className="muted">No address is blocked right now.</p>}
        {canManage && blocks && blocks.length > 0 && (
          <ul className="net-list" aria-label="Blocked addresses">
            {blocks.map((b) => (
              <li key={b.ip} className="net-row">
                <span className="net-block">
                  <span className="mono net-entry">{b.ip}</span>
                  <span className="muted small">Blocked until {formatDateTime(b.until)}</span>
                </span>
                <button type="button" className="btn btn-sm" onClick={() => void unblock(b.ip)} aria-label={`Unblock ${b.ip}`}>
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog open={dialog === "save"} title="Save the IP allowlist?" confirmLabel="Save list" busy={busy} confirmDisabled={!checked} onConfirm={() => void send(list, "Saved the IP allowlist")} onCancel={() => setDialog(null)}>
        <p>
          Only the {plural(list.length, "address or network", "addresses and networks")} in the list will be able to connect to {db.name}. Any other address is refused with the same error as a wrong password.
        </p>
        <p className="once-warning">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            FENVIX cannot see the address your applications connect from, so it cannot check that the list includes it. If it does not, they stop working, and after a few attempts that address is blocked for a while.
          </span>
        </p>
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          I have checked that the addresses of my applications are in the list
        </label>
        {dialogError && (
          <p className="error" role="alert">
            {dialogError}
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog open={dialog === "clear"} title="Clear the IP allowlist?" confirmLabel="Clear list" busy={busy} onConfirm={() => void send([], "Cleared the IP allowlist: all IP addresses are allowed")} onCancel={() => setDialog(null)}>
        <p>Every IP address will be able to connect to {db.name} again. Users still need their password.</p>
        {dialogError && (
          <p className="error" role="alert">
            {dialogError}
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "import"}
        title="Import addresses"
        confirmLabel={imported.entries.length ? `Add ${plural(imported.entries.length, "entry", "entries")}` : "Add entries"}
        confirmDisabled={imported.entries.length === 0 || imported.problems.length > 0}
        onConfirm={addImported}
        onCancel={() => setDialog(null)}
      >
        <div className="field">
          <label htmlFor="net-import">Addresses and networks</label>
          <textarea
            id="net-import"
            className="mono"
            rows={6}
            value={importText}
            onChange={(e) => (setImportText(e.target.value), setDialogError(null))}
            placeholder={"203.0.113.7\n10.0.0.0/8\n2001:db8::/32"}
            spellCheck={false}
            aria-describedby="net-import-help"
          />
          <p id="net-import-help" className="muted small">
            One per line, or separated by commas or spaces. Lines starting with # are skipped. They are added to the list; save the list to apply them.
          </p>
        </div>
        {importText.trim() !== "" && imported.problems.length === 0 && (
          <p className="muted small" role="status">
            {plural(imported.entries.length, "entry", "entries")} ready to add{imported.duplicates ? `; ${plural(imported.duplicates, "repeat was", "repeats were")} left out` : ""}.
          </p>
        )}
        {imported.problems.length > 0 && (
          <div className="error-list" role="alert">
            <p className="error">Fix these lines first:</p>
            <ul>
              {imported.problems.slice(0, 8).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {imported.problems.length > 8 && <p className="small">And {imported.problems.length - 8} more.</p>}
          </div>
        )}
        {dialogError && (
          <p className="error" role="alert">
            {dialogError}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
