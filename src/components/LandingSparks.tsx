import { useEffect, useRef } from "react";

/**
 * The landing hero's light background drawing (fenvix-landing, home hero): a few of the small blue squares near the
 * bottom light up and fade. It sits on the same sky gradient and square band as the landing (see .signin-hero in
 * styles.css). Squares are snapped to the band's 5px grid. Still for people who asked for less motion. Decoration only.
 */
export function LandingSparks() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let W = 0;
    let H = 0;
    let pts: { x: number; y: number; ph: number; sp: number }[] = [];
    const size = () => {
      const r = cv.getBoundingClientRect();
      const d = Math.min(2, window.devicePixelRatio || 1);
      W = r.width;
      H = r.height;
      cv.width = Math.round(W * d);
      cv.height = Math.round(H * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
      pts = Array.from({ length: Math.round(W / 9) }, () => ({
        x: Math.floor((Math.random() * W) / 5) * 5 + 0.6,
        y: Math.round((H - Math.pow(Math.random(), 1.6) * H * 0.42) / 5) * 5 + 0.6,
        ph: Math.random() * 6.28,
        sp: 0.4 + Math.random() * 0.9,
      }));
    };
    const draw = (t: number) => {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#0d4fa3";
      for (const p of pts) {
        const a = Math.max(0, Math.sin(t * p.sp + p.ph));
        if (a < 0.05) continue;
        ctx.globalAlpha = a * a * 0.9;
        ctx.fillRect(p.x - 1.1, p.y - 1.1, 2.2, 2.2);
        ctx.globalAlpha = a * a * 0.18;
        ctx.fillRect(p.x - 3.2, p.y - 3.2, 6.4, 6.4);
      }
      ctx.globalAlpha = 1;
    };
    size();
    draw(2);
    const ro = new ResizeObserver(() => (size(), draw(2)));
    ro.observe(cv);
    if (reduce) return () => ro.disconnect();
    let raf = 0;
    const loop = (now: number) => {
      draw(now / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  return <canvas ref={ref} className="signin-sparks" aria-hidden="true" />;
}
