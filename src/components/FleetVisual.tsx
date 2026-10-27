import { useId } from "react";

/**
 * The fleet, drawn the way the landing page draws it: a field of databases, nearly all asleep,
 * a few awake and wired to the FENVIX node in the middle. Static: nothing moves.
 *
 * Lines only ever run along the gaps between chips, so no line crosses a database.
 */
const COLS = 9;
const ROWS = 7;
const CELL_W = 62;
const CELL_H = 54;
const CHIP_W = 44;
const CHIP_H = 32;
const WIDTH = COLS * CELL_W;
const HEIGHT = ROWS * CELL_H;

/** The node covers the three middle cells of the middle row. */
const NODE_ROW = 3;
const NODE = { x: WIDTH / 2, y: NODE_ROW * CELL_H + CELL_H / 2, w: 3 * CELL_W, h: CELL_H };
const NODE_TOP = NODE.y - NODE.h / 2;
const NODE_BOTTOM = NODE.y + NODE.h / 2;

const cx = (c: number) => c * CELL_W + CELL_W / 2;
const cy = (r: number) => r * CELL_H + CELL_H / 2;

/** Awake databases, with the gap between columns their line travels down. */
const AWAKE = [
  { c: 1, r: 1, gap: 4 },
  { c: 7, r: 0, gap: 5 },
  { c: 0, r: 5, gap: 4 },
  { c: 6, r: 6, gap: 5 },
  { c: 8, r: 3, gap: 0 },
];

function route({ c, r, gap }: { c: number; r: number; gap: number }): string {
  const x = cx(c);
  const y = cy(r);
  if (r === NODE_ROW) return `M${x} ${y} H${x < NODE.x ? NODE.x - NODE.w / 2 : NODE.x + NODE.w / 2}`;
  const above = r < NODE_ROW;
  const gutterY = above ? (r + 1) * CELL_H : r * CELL_H;
  const gutterX = gap * CELL_W;
  return `M${x} ${y} V${gutterY} H${gutterX} V${above ? NODE_TOP : NODE_BOTTOM}`;
}

function Cylinder({ x, y, awake }: { x: number; y: number; awake: boolean }) {
  return (
    <g transform={`translate(${x - 6} ${y - 7})`} stroke={awake ? "#0a0a0b" : "currentColor"} strokeWidth="1.2" fill="none">
      <ellipse cx="6" cy="2.4" rx="6" ry="2.4" />
      <path d="M0 2.4v9.2c0 1.33 2.7 2.4 6 2.4s6-1.07 6-2.4V2.4M0 7a6 2.4 0 0 0 12 0" />
    </g>
  );
}

export function FleetVisual() {
  const gradient = `fleet-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const awake = new Map(AWAKE.map((a) => [`${a.c}:${a.r}`, a]));
  const chips = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (r === NODE_ROW && c >= 3 && c <= 5) continue;
      const on = awake.has(`${c}:${r}`);
      chips.push(
        <g key={`${c}:${r}`} className={on ? "chip-on" : "chip-off"}>
          <rect x={cx(c) - CHIP_W / 2} y={cy(r) - CHIP_H / 2} width={CHIP_W} height={CHIP_H} rx="9" fill={on ? "#ffffff" : "none"} stroke="currentColor" strokeWidth="1" />
          <Cylinder x={cx(c)} y={cy(r)} awake={on} />
        </g>,
      );
    }
  }

  return (
    <svg className="fleet" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="A field of databases: five awake and connected to FENVIX, the rest asleep.">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.5" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.3" />
        </linearGradient>
      </defs>
      <g className="fleet-lines">
        {AWAKE.map((a) => (
          <g key={`${a.c}:${a.r}`}>
            <path d={route(a)} fill="none" stroke="currentColor" strokeWidth="1" />
            <circle cx={cx(a.c)} cy={cy(a.r)} r="1.8" fill="#ffffff" />
          </g>
        ))}
      </g>
      {chips}
      <g className="fleet-node">
        <rect x={NODE.x - NODE.w / 2} y={NODE_TOP} width={NODE.w} height={NODE.h} rx="14" fill="#0a0a0b" stroke={`url(#${gradient})`} strokeWidth="1.6" />
        <g transform={`translate(${NODE.x - 64} ${NODE.y - 12})`}>
          <rect x="5.2" y="2.8" width="13.6" height="18.4" rx="4.2" fill="none" stroke={`url(#${gradient})`} strokeWidth="2.6" />
        </g>
        <text x={NODE.x - 34} y={NODE.y + 5} className="fleet-word">
          FENVIX
        </text>
      </g>
    </svg>
  );
}
