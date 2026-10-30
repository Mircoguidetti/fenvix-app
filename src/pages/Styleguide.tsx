import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Search, Trash2 } from "lucide-react";
import { PageHeader, Card, Message } from "../components/PageHeader";
import { Switch } from "../components/Switch";
import { Segmented } from "../components/Segmented";
import { Select } from "../components/Select";
import { SearchInput } from "../components/SearchInput";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StateBadge, StatusPill } from "../components/StateBadge";
import { LogoMark } from "../components/Logo";
import { useToast } from "../components/Toast";

/** The route exists only in development, or in a build made with VITE_STYLEGUIDE=1. It is not linked anywhere. */
export const STYLEGUIDE_ON = import.meta.env.DEV || import.meta.env.VITE_STYLEGUIDE === "1";

const SWATCHES = ["--black", "--page", "--bg", "--border", "--border-strong", "--muted", "--muted-2", "--success", "--warning", "--danger"];

export function StyleguidePage() {
  const toast = useToast();
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState("all");
  const [region, setRegion] = useState("eu-west-1");
  const [dialog, setDialog] = useState<null | "plain" | "danger">(null);
  const [typed, setTyped] = useState("");

  return (
    <div className="sg">
      <PageHeader title="Styleguide" description="Every component in every state. Development only." />

      <Card id="sg-color" title="Colour and type" description="One dark colour, greys with a slight blue tint, three status colours.">
        <div className="sg-swatches">
          {SWATCHES.map((n) => (
            <div key={n} className="sg-swatch">
              <span className="sg-chip" style={{ background: `var(${n})` }} />
              <span className="mono">{n}</span>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>Geist 600, 28 px: Databases</p>
        <p>Geist 400, 14 px. Every database sleeps when idle and wakes on its first request.</p>
        <p className="mono">Geist Mono: acme-orders, db_a1b2, eu-west-1, mongodb://app:&lt;password&gt;@host:27018</p>
        <div className="sg-dark">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <LogoMark />
            <span className="logo-word">FENVIX</span>
          </span>
        </div>
      </Card>

      <Card id="sg-buttons" title="Buttons" description="36 px, small 32, extra small 28, radius 8. 44 px on a phone.">
        <div className="sg-grid">
          <button type="button" className="btn btn-primary">
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
            Primary
          </button>
          <button type="button" className="btn">
            Secondary
          </button>
          <button type="button" className="btn btn-quiet">
            Quiet
          </button>
          <button type="button" className="btn btn-danger">
            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
            Danger
          </button>
          <button type="button" className="btn btn-primary" disabled>
            Disabled
          </button>
          <button type="button" className="btn btn-sm">
            Small
          </button>
          <button type="button" className="btn btn-xs">
            Extra small
          </button>
          <button type="button" className="icon-btn" aria-label="Search">
            <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <Link to="/databases" className="btn">
            Link as button
          </Link>
        </div>
      </Card>

      <Card id="sg-fields" title="Fields" description="Default, with a value, focused (press Tab), error and disabled.">
        <div className="stack wide">
          <div className="field">
            <label htmlFor="sg-a">Name</label>
            <input id="sg-a" placeholder="acme-labs-prod-01" />
            <p className="help">Lowercase letters, numbers and dashes.</p>
          </div>
          <div className="field">
            <label htmlFor="sg-b">Mono value</label>
            <input id="sg-b" className="mono" defaultValue="customer:acme-labs" />
          </div>
          <div className="field">
            <label htmlFor="sg-c">With an error</label>
            <input id="sg-c" defaultValue="Bad Name" aria-invalid="true" aria-describedby="sg-c-e" />
            <p id="sg-c-e" className="error" role="alert">
              Use lowercase letters, numbers and dashes.
            </p>
          </div>
          <div className="field">
            <label htmlFor="sg-d">Disabled</label>
            <input id="sg-d" defaultValue="locked" disabled />
          </div>
          <div className="field">
            <label htmlFor="sg-e">Search</label>
            <SearchInput id="sg-e" placeholder="Search by name" />
          </div>
          <div className="field">
            <label htmlFor="sg-f">Select</label>
            <Select id="sg-f" value={region} onChange={setRegion} options={[{ value: "eu-west-1", label: "eu-west-1" }, { value: "eu-central-1", label: "eu-central-1" }, { value: "us-east-1", label: "us-east-1" }]} />
          </div>
        </div>
      </Card>

      <Card id="sg-controls" title="Switch and segmented control">
        <div className="stack wide">
          <Switch id="sg-sw" checked={on} onChange={setOn} label="Keep awake" help="The database never sleeps, so its first request is never slow." />
          <Switch id="sg-sw2" checked={false} onChange={() => {}} label="Off" />
          <Switch id="sg-sw3" checked disabled onChange={() => {}} label="Disabled" />
          <Segmented label="State" value={seg} onChange={setSeg} options={[{ value: "all", label: "All", count: 12 }, { value: "awake", label: "Awake", count: 2 }, { value: "asleep", label: "Asleep", count: 9 }, { value: "keep", label: "Kept awake", count: 1 }]} />
        </div>
      </Card>

      <Card id="sg-badges" title="Status and chips" description="A word always comes with the colour.">
        <div className="sg-grid">
          <StateBadge state="awake" />
          <StateBadge state="asleep" />
          <StateBadge state="awake" kept />
          <StatusPill tone="ok">Active</StatusPill>
          <StatusPill tone="warn">Open</StatusPill>
          <StatusPill tone="neutral">Revoked</StatusPill>
          <span className="chip">env:prod</span>
          <span className="chip chip-lg chip-removable">
            customer:acme-labs
            <button type="button" aria-label="Remove tag filter customer:acme-labs">
              ×
            </button>
          </span>
        </div>
        <Message>A plain note.</Message>
        <Message role="alert">Something failed.</Message>
        <Message tone="warning">This needs attention.</Message>
      </Card>

      <Card id="sg-feedback" title="Dialogs and toasts" description="On a phone a dialog is a full-screen sheet with its buttons at the bottom.">
        <div className="sg-grid">
          <button type="button" className="btn" onClick={() => setDialog("plain")}>
            Open a dialog
          </button>
          <button type="button" className="btn btn-danger" onClick={() => (setTyped(""), setDialog("danger"))}>
            Open a confirmation
          </button>
          <button type="button" className="btn" onClick={() => toast("Created database acme-orders", "success")}>
            Success toast
          </button>
          <button type="button" className="btn" onClick={() => toast("Could not reach the server.", "error")}>
            Error toast
          </button>
        </div>
      </Card>

      <ConfirmDialog open={dialog === "plain"} title="Add a tag" confirmLabel="Add tag" onConfirm={() => setDialog(null)} onCancel={() => setDialog(null)}>
        <div className="field">
          <label htmlFor="sg-dlg">Tag (key:value)</label>
          <input id="sg-dlg" className="mono" placeholder="customer:acme-labs" autoComplete="off" />
        </div>
      </ConfirmDialog>
      <ConfirmDialog danger open={dialog === "danger"} title="Erase this database?" confirmLabel="Erase database" confirmDisabled={typed !== "acme-orders"} onConfirm={() => setDialog(null)} onCancel={() => setDialog(null)}>
        <p>This permanently deletes the database and all its data. It cannot be undone.</p>
        <div className="field">
          <label htmlFor="sg-type">
            Type <span className="mono">acme-orders</span> to confirm
          </label>
          <input id="sg-type" className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
        </div>
      </ConfirmDialog>
    </div>
  );
}
