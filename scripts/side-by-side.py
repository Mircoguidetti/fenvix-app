"""Puts docs/ui/<name>-mockup-1440.png and docs/ui/<name>-1440.png next to each other as <name>-side-by-side-1440.png."""
import glob, os
from PIL import Image, ImageDraw

for mock in sorted(glob.glob("docs/ui/*-mockup-1440.png")):
    name = os.path.basename(mock)[: -len("-mockup-1440.png")]
    a, b = Image.open(mock).convert("RGB"), Image.open(f"docs/ui/{name}-1440.png").convert("RGB")
    out = Image.new("RGB", (a.width + b.width + 20, max(a.height, b.height) + 28), (136, 136, 136))
    out.paste(a, (0, 28)); out.paste(b, (a.width + 20, 28))
    d = ImageDraw.Draw(out); d.text((6, 8), "mockup", fill="white"); d.text((a.width + 26, 8), "real", fill="white")
    out.save(f"docs/ui/{name}-side-by-side-1440.png")
    print(name)
