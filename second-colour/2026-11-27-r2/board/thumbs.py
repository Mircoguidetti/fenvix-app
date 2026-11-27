# Board pictures: JPEG copies of ../shots (1440 px wide desktop, 780 px phone). Not committed; regenerate with
#   python3 second-colour/2026-11-27-r2/board/thumbs.py
import glob, os
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
for p in glob.glob(os.path.join(here, "..", "shots", "*", "*.png")):
    kit, name = p.split(os.sep)[-2], os.path.basename(p)[:-4]
    os.makedirs(os.path.join(here, "img", kit), exist_ok=True)
    im = Image.open(p).convert("RGB")
    w = 1440 if "desktop" in name else 780
    im.resize((w, int(im.height * w / im.width)), Image.LANCZOS).save(os.path.join(here, "img", kit, name + ".jpg"), quality=82, optimize=True)
