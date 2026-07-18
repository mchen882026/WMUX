"""Generate the wmux app icon: a dark terminal tile, two dim output lines,
and the amber block cursor — the same signature the dashboard uses."""
from PIL import Image, ImageDraw

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded dark tile with a subtle border
d.rounded_rectangle([8, 8, S - 8, S - 8], radius=96, fill=(16, 19, 24, 255),
                    outline=(36, 45, 56, 255), width=6)

# terminal "output" lines (dim)
line = (87, 97, 109, 255)
d.rounded_rectangle([96, 168, 336, 200], radius=16, fill=line)
d.rounded_rectangle([96, 240, 272, 272], radius=16, fill=line)

# the amber block cursor
amber = (232, 161, 60, 255)
d.rounded_rectangle([96, 312, 176, 416], radius=14, fill=amber)

img.save("build/icon.png")
img.resize((256, 256), Image.LANCZOS).save(
    "build/icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("wrote build/icon.png and build/icon.ico")
