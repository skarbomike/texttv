"""Generate the app icons (run: python3 tools/make_icons.py)."""
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "icons"
FONT = subprocess.run(["fc-match", "-f", "%{file}", "DejaVu Sans:bold"],
                      capture_output=True, text=True, check=True).stdout

S = 1024
img = Image.new("RGB", (S, S), "black")
d = ImageDraw.Draw(img)

# Teletext Fastext bar: red, green, yellow, cyan.
colors = ["#ff2b2b", "#22dd22", "#ffde00", "#22dddd"]
bar_y, bar_h, margin = 690, 110, 170
w = (S - 2 * margin) / 4
for i, c in enumerate(colors):
    d.rectangle([margin + i * w + 8, bar_y, margin + (i + 1) * w - 8, bar_y + bar_h], fill=c)

font = ImageFont.truetype(FONT, 330)
text = "100"
l, t, r, b = d.textbbox((0, 0), text, font=font)
d.text(((S - (r - l)) / 2 - l, 300 - (b - t) / 2 - t), text, font=font, fill="#ffde00")

small = ImageFont.truetype(FONT, 92)
label = "TEXT-TV"
l, t, r, b = d.textbbox((0, 0), label, font=small)
d.text(((S - (r - l)) / 2 - l, 540 - t), label, font=small, fill="white")

OUT.mkdir(exist_ok=True)
for size in (180, 192, 512):
    img.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png", optimize=True)
print("wrote", sorted(p.name for p in OUT.iterdir()))
