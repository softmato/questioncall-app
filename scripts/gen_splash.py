"""Builds `assets/images/splash-logo.png` — the icon + wordmark lockup.

The lockup is one tight group: icon, a small gap, then the app name. The canvas
is cropped to that group with equal padding on every side, so whichever surface
centres the image — the native splash, or the JS overlay in
`components/branding/brand-splash.tsx` — centres the *lockup* rather than the
icon alone. That lifts the icon just above the optical centre and keeps the
name attached to it instead of stranded near the bottom.

Everything is measured from ink, not from bounding boxes with slack in them:
the icon is cropped to its coloured pixels and the wordmark to its glyphs, so
`PAD` and `GAP` mean exactly what they say.

`ICON_INK_W` is chosen so the icon's rendered size is unchanged from the older
composition; only the vertical arrangement moves.

After editing this, run it and copy the `LOGO_ASPECT` it prints into
`brand-splash.tsx`.
"""

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ICON_SRC = "D:/Jiwan-Mijhar/app/assets/images/icon.png"
OUT = "D:/Jiwan-Mijhar/app/assets/images/splash-logo.png"

CANVAS_W = 1024
# Width of the icon's coloured pixels on the canvas. At CANVAS_W = 1024 and an
# `imageWidth` of 280dp this renders the icon 144dp wide.
ICON_INK_W = 528
# Icon ink to wordmark cap-height. Reads as ~18dp on screen.
GAP = 66
# Margin around the lockup. Equal on all sides so centring the image centres
# the lockup; it only exists so `contain` scaling never clips the ink.
PAD = 60

FONT = "C:/Windows/Fonts/segoeuib.ttf"
FONT_SIZE = 62
TEXT = "Question Call"
TEXT_COLOR = (28, 28, 28)
BACKGROUND = (255, 255, 255)

# Crop the icon to its ink. icon.png is opaque white behind the mark, so the
# mark is found by colour rather than by alpha.
icon = Image.open(ICON_SRC).convert("RGB")
arr = np.array(icon)
ink = ~((arr[:, :, 0] > 240) & (arr[:, :, 1] > 240) & (arr[:, :, 2] > 240))
rmin, rmax = np.where(np.any(ink, axis=1))[0][[0, -1]]
cmin, cmax = np.where(np.any(ink, axis=0))[0][[0, -1]]
icon_ink = icon.crop((cmin, rmin, cmax + 1, rmax + 1))

icon_h = round(ICON_INK_W * icon_ink.height / icon_ink.width)
icon_resized = icon_ink.resize((ICON_INK_W, icon_h), Image.LANCZOS)

# Measure the wordmark's ink box so GAP and PAD are to the glyphs, not to the
# font's ascent and descent.
font = ImageFont.truetype(FONT, FONT_SIZE)
tx0, ty0, tx1, ty1 = ImageDraw.Draw(Image.new("RGB", (1, 1))).textbbox(
    (0, 0), TEXT, font=font
)
text_w, text_h = tx1 - tx0, ty1 - ty0

canvas_h = PAD + icon_h + GAP + text_h + PAD
canvas = Image.new("RGB", (CANVAS_W, canvas_h), BACKGROUND)
canvas.paste(icon_resized, ((CANVAS_W - ICON_INK_W) // 2, PAD))

# The textbbox origin is subtracted so the glyphs land exactly at the requested
# position rather than the text layout box.
ImageDraw.Draw(canvas).text(
    ((CANVAS_W - text_w) // 2 - tx0, PAD + icon_h + GAP - ty0),
    TEXT,
    fill=TEXT_COLOR,
    font=font,
)

canvas.save(OUT, "PNG")
print(f"Done | canvas {CANVAS_W}x{canvas_h} | LOGO_ASPECT = {canvas_h} / {CANVAS_W}")
