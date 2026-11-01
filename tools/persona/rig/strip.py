"""strip.py <frames dir> <first> <count> <step> <x,y,w,h> <out> [cols]: consecutive frames' crops in a grid, to see
motion frame by frame (each cell is labelled with its frame number)."""
import sys
from PIL import Image, ImageDraw

d, first, count, step, box, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), [int(v) for v in sys.argv[5].split(",")], sys.argv[6]
cols = int(sys.argv[7]) if len(sys.argv) > 7 else 6
x, y, w, h = box
rows = (count + cols - 1) // cols
s = Image.new("RGB", (cols * w, rows * h))
for k in range(count):
    i = first + k * step
    im = Image.open(f"{d}/{i:04d}.jpg").crop((x, y, x + w, y + h))
    ImageDraw.Draw(im).text((4, 4), str(i), fill=(255, 255, 0))
    s.paste(im, ((k % cols) * w, (k // cols) * h))
s.save(out)
