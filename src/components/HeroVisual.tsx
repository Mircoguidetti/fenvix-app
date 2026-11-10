import { useEffect, useRef } from "react";

/**
 * The landing's hero drawing (fenvix-landing index.html, `sqgrid` and `infv` variant "e"): a quiet grid of tiny squares
 * that twinkle, and a Moebius strip of points flowing at the bottom. It is drawn wider than its box, as wide as the
 * landing's hero, so the strip keeps the landing's proportions; the box clips the sides. Still for people who asked for
 * less motion. Decoration only.
 */
export function HeroVisual({ textY = 0.34 }: { textY?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const hash = (a: number, b: number) => {
      const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
      return h - Math.floor(h);
    };
    let W = 0;
    let H = 0;
    const size = () => {
      const r = cv.getBoundingClientRect();
      const d = Math.min(2, window.devicePixelRatio || 1);
      W = r.width;
      H = r.height;
      cv.width = Math.round(W * d);
      cv.height = Math.round(H * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
    };
    const draw = (now: number) => {
      if (!W || !H) return;
      const c = ctx;
      c.clearRect(0, 0, W, H);
      const t = now * 0.001;
      c.fillStyle = "#F3F4F6";
      const g = W < 720 ? 32 : 40;
      const gcx = W / 2;
      const gcy = H * textY;
      const wave = ((now * 0.00016) % 1.6) - 0.3;
      for (let x = gcx % g; x < W; x += g)
        for (let y = gcy % g; y < H; y += g) {
          const f = Math.max(0, 1 - Math.hypot((x - gcx) / (W * 0.62), (y - gcy) / (H * 0.7)));
          if (f <= 0) continue;
          const r = hash(x, y);
          const tw = 0.5 + 0.5 * Math.sin(now * 0.0016 + r * 40);
          const wv = Math.max(0, 1 - Math.abs(x / W - wave) / 0.1);
          const br = r > 0.93 ? 2.2 : 1;
          c.globalAlpha = Math.min(0.7, (0.13 * br * (0.55 + 0.45 * tw) + 0.3 * wv) * f);
          c.fillRect(x - 1, y - 1, 2.2, 2.2);
        }
      const cx = W / 2;
      const cy = H * (W < 720 ? 0.86 : 0.85);
      const sq = W < 720 ? 0.6 : 0.7;
      const S = Math.min(W, H);
      const ax = 0.5 + Math.sin(t * 0.1) * 0.08;
      const cA = Math.cos(ax), sA = Math.sin(ax), cB = Math.cos(0.4), sB = Math.sin(0.4), Z = S * 1.6;
      const dot = (x: number, y: number, z: number, k: number) => {
        const x1 = x * cB - z * sB, z1 = x * sB + z * cB, y2 = y * cA - z1 * sA, z2 = y * sA + z1 * cA;
        const f = Z / (Z + z2), dz = Math.max(0, Math.min(1, 0.5 + z2 / (k * 2)));
        c.globalAlpha = 0.07 + 0.63 * (1 - dz);
        const r = 0.6 + 1.3 * (1 - dz);
        c.fillRect(cx + x1 * f - r / 2, cy + y2 * f * sq - r / 2, r, r);
      };
      const R2 = W * (W < 720 ? 0.62 : 0.42);
      for (let i = 0; i < 300; i++)
        for (let j = 0; j < 16; j++) {
          const uu = (i / 300) * Math.PI * 2 + t * 0.06, vv = (j / 15 - 0.5) * R2 * 0.8;
          const x = (R2 + vv * Math.cos(uu / 2)) * Math.cos(uu), y = (R2 + vv * Math.cos(uu / 2)) * Math.sin(uu), z = vv * Math.sin(uu / 2);
          dot(x, z, y, R2 * 1.4);
        }
      c.globalAlpha = 1;
    };
    size();
    if (reduce) {
      draw(4000);
      return;
    }
    let raf = 0;
    const loop = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(loop);
    };
    const onResize = () => size();
    window.addEventListener("resize", onResize);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [textY]);
  return (
    <div className="hero-visual" aria-hidden="true">
      <canvas ref={ref} />
    </div>
  );
}
