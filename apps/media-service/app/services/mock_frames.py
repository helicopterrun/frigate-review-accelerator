"""Generate placeholder frames for dev/testing without a real Frigate instance."""

import io
import math
from datetime import datetime, timezone

from PIL import Image, ImageDraw, ImageFont


def generate_mock_frame(
    camera: str, timestamp: float, width: int = 320, fmt: str = "jpg"
) -> bytes:
    """Generate a colored placeholder image with camera name and timestamp."""
    height = int(width * 9 / 16)  # 16:9 aspect ratio

    # Derive a consistent color from the camera name + time bucket
    bucket = int(timestamp) // 30  # Change color every 30 seconds
    hue = (hash(camera) * 37 + bucket * 73) % 360

    # HSV to RGB (simple conversion, S=0.4, V=0.35 for muted dark tones)
    s, v = 0.4, 0.35
    c = v * s
    x = c * (1 - abs((hue / 60) % 2 - 1))
    m = v - c

    if hue < 60: r, g, b = c, x, 0
    elif hue < 120: r, g, b = x, c, 0
    elif hue < 180: r, g, b = 0, c, x
    elif hue < 240: r, g, b = 0, x, c
    elif hue < 300: r, g, b = x, 0, c
    else: r, g, b = c, 0, x

    bg_color = (int((r + m) * 255), int((g + m) * 255), int((b + m) * 255))

    img = Image.new("RGB", (width, height), bg_color)
    draw = ImageDraw.Draw(img)

    # Draw timestamp text
    dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    time_str = dt.strftime("%H:%M:%S")
    date_str = dt.strftime("%Y-%m-%d")

    # Use default font
    try:
        font_large = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", size=max(14, width // 16))
        font_small = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", size=max(10, width // 24))
    except (OSError, IOError):
        font_large = ImageFont.load_default()
        font_small = font_large

    text_color = (200, 200, 200)

    # Camera name at top
    draw.text((8, 6), camera, fill=text_color, font=font_small)

    # Time in center
    bbox = draw.textbbox((0, 0), time_str, font=font_large)
    tw = bbox[2] - bbox[0]
    draw.text(((width - tw) // 2, height // 2 - 12), time_str, fill=(255, 255, 255), font=font_large)

    # Date below
    bbox2 = draw.textbbox((0, 0), date_str, font=font_small)
    tw2 = bbox2[2] - bbox2[0]
    draw.text(((width - tw2) // 2, height // 2 + 16), date_str, fill=text_color, font=font_small)

    # Slot indicator line at bottom
    slot_x = int((timestamp % 60) / 60 * width)
    draw.line([(slot_x, height - 3), (slot_x, height)], fill=(255, 89, 46), width=2)

    buf = io.BytesIO()
    if fmt == "webp":
        img.save(buf, format="WEBP", quality=80)
    else:
        img.save(buf, format="JPEG", quality=85)

    return buf.getvalue()
