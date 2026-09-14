# Contact sheet of viewport crops: python scripts/sheet.py out.png shot1.png shot2.png ...
# Crops the 3D viewport (between the side panels, below the toolbars) from 1500px-wide shots.
import sys
from PIL import Image, ImageDraw

out, files = sys.argv[1], sys.argv[2:]
tile = 520
cols = 3 if len(files) > 4 else 2
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (tile * cols, tile * rows), (20, 20, 20))
for i, f in enumerate(files):
    im = Image.open(f).convert("RGB")
    w, h = im.size
    left, right = (264, w - 300) if w > 1180 else (230, w - 260)
    vw = right - left
    top = 88
    side = min(vw, h - top)
    cx = left + vw // 2
    cy = top + (h - top) // 2
    crop = im.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2)).resize((tile, tile))
    ImageDraw.Draw(crop).text((10, 10), f.split("/")[-1].split("\\")[-1], fill=(255, 255, 0))
    sheet.paste(crop, ((i % cols) * tile, (i // cols) * tile))
sheet.save(out)
print(out)
