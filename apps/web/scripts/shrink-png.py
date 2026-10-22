"""Re-encode a screenshot PNG with a 256-colour palette so it stays under 200 KB. Usage: python3 shrink-png.py file.png"""
import sys

from PIL import Image

for path in sys.argv[1:]:
    img = Image.open(path).convert("RGB")
    img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)
