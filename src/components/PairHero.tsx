/**
 * The sign-in hero's drawing (option 2, "Two tests. One cause.", chosen by the founder on 2026-11-17): the dot band is
 * a test suite, one square per test. Two of them are linked: the test that leaves state behind (the polluter, run
 * first) and the test that then fails, with the seed and how far the order was minimised. Taken from the sample
 * defect dfx_9a10 (storefront). Decoration only: hidden from assistive technology; the page's text says the same.
 * Squares twinkle slowly and the link draws itself; everything is still for people who asked for less motion.
 */
const W = 800;
const H = 440;

function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// The suite: squares on a 16px grid, denser towards the bottom, fixed for every visit.
const SUITE = (() => {
  const r = rng(3);
  const out: { x: number; y: number; o: number; d: number }[] = [];
  for (let y = 24; y < H - 8; y += 16)
    for (let x = 16; x < W - 8; x += 16) {
      const depth = y / H;
      if (r() < 0.25 + depth * 0.45) out.push({ x, y, o: 0.08 + depth * 0.16 + r() * 0.08, d: r() * 6 });
    }
  return out;
})();

const A = { x: 208, y: 288 }; // the polluter
const B = { x: 576, y: 208 }; // the test that fails

export function PairHero() {
  return (
    <svg className="signin-pair" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
      {SUITE.map((s, i) => (
        <rect key={i} className="pair-dot" x={s.x - 2} y={s.y - 2} width="4" height="4" rx="1" style={{ opacity: s.o, animationDelay: `${-s.d}s` }} />
      ))}
      <path className="pair-link" d={`M${A.x} ${A.y} C ${A.x + 100} ${A.y - 190}, ${B.x - 150} ${B.y - 150}, ${B.x} ${B.y}`} pathLength="1" />
      {[A, B].map((p, i) => (
        <g key={i} className={i ? "pair-node pair-node-fails" : "pair-node"}>
          <circle cx={p.x} cy={p.y} r="13" />
          <rect x={p.x - 4.5} y={p.y - 4.5} width="9" height="9" rx="2" />
        </g>
      ))}
      <text className="pair-name" x={A.x - 110} y={A.y + 40}>
        1 test_voucher_cache_warm
      </text>
      <text className="pair-note" x={A.x - 110} y={A.y + 60}>
        POLLUTER · RUNS FIRST
      </text>
      <text className="pair-name" x={B.x - 170} y={B.y + 40}>
        2 test_checkout_complete_with_voucher
      </text>
      <text className="pair-note" x={B.x - 170} y={B.y + 60}>
        FAILS · SEED 1 · 214 TESTS MINIMISED TO 2
      </text>
    </svg>
  );
}
