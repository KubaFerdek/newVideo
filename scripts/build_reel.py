#!/usr/bin/env python3
"""
Build a vertical reel from scenes.json and numbered scene images.

Install dependencies:
    python3 -m pip install pillow numpy imageio imageio-ffmpeg

Run:
    python3 scripts/build_reel.py

Optional:
    python3 scripts/build_reel.py --seed 123 --fps 30 --output output/reel.mp4
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

try:
    import imageio.v2 as imageio
    import numpy as np
    from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont
except ImportError as exc:
    print(
        "Missing dependency: "
        f"{exc.name}\n\n"
        "Install required packages:\n"
        "    python3 -m pip install pillow numpy imageio imageio-ffmpeg",
        file=sys.stderr,
    )
    raise SystemExit(1)


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SCENES = ROOT_DIR / "output" / "scenes.json"
DEFAULT_OUTPUT = ROOT_DIR / "output" / "reel.mp4"
IMAGE_DIR_CANDIDATES = (
    ROOT_DIR / "output" / "images",
    ROOT_DIR / "output" / "image",
)

WIDTH = 1080
HEIGHT = 1920
SAFE_X = 72
TEXT_BOX_TOP = 1110
TEXT_BOX_BOTTOM = 1830

FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf",
    "/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)

PALETTES = (
    {
        "name": "gold noir",
        "accent": (245, 184, 76),
        "accent_2": (255, 221, 145),
        "text": (255, 255, 255),
        "muted": (224, 224, 224),
        "shadow": (0, 0, 0),
        "panel": (10, 10, 14, 188),
    },
    {
        "name": "rose cinema",
        "accent": (255, 112, 144),
        "accent_2": (255, 190, 204),
        "text": (255, 255, 255),
        "muted": (236, 232, 235),
        "shadow": (0, 0, 0),
        "panel": (14, 8, 13, 190),
    },
    {
        "name": "ice blue",
        "accent": (98, 203, 255),
        "accent_2": (182, 234, 255),
        "text": (255, 255, 255),
        "muted": (226, 240, 246),
        "shadow": (0, 0, 0),
        "panel": (7, 13, 18, 188),
    },
)


@dataclass(frozen=True)
class Scene:
    number: int
    visual: str
    narration: str
    on_screen: str
    image_path: Path
    duration: float
    image_effect: str
    text_effect: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a vertical reel from scenes and generated images.")
    parser.add_argument("--scenes", type=Path, default=DEFAULT_SCENES, help="Path to scenes.json.")
    parser.add_argument("--images", type=Path, default=None, help="Directory with numbered images, e.g. 1.png.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output MP4 path.")
    parser.add_argument("--fps", type=int, default=30, help="Frames per second.")
    parser.add_argument("--seed", type=int, default=None, help="Random seed for repeatable effects.")
    parser.add_argument("--palette", choices=[p["name"] for p in PALETTES], default=None)
    return parser.parse_args()


def choose_image_dir(explicit: Path | None) -> Path:
    if explicit:
        if explicit.exists():
            return explicit
        raise FileNotFoundError(f"Image directory does not exist: {explicit}")

    for candidate in IMAGE_DIR_CANDIDATES:
        if candidate.exists():
            return candidate

    searched = ", ".join(str(path) for path in IMAGE_DIR_CANDIDATES)
    raise FileNotFoundError(f"Could not find image directory. Searched: {searched}")


def find_image(image_dir: Path, scene_number: int) -> Path:
    for suffix in (".png", ".jpg", ".jpeg", ".webp"):
        path = image_dir / f"{scene_number}{suffix}"
        if path.exists():
            return path
    raise FileNotFoundError(f"Missing image for scene {scene_number} in {image_dir}")


def word_count(text: str) -> int:
    return len(re.findall(r"\w+", text, flags=re.UNICODE))


def scene_duration(visual: str, narration: str, on_screen: str) -> float:
    words = word_count(" ".join([visual, narration, on_screen]))
    # About 135 words/minute, plus a moment to absorb the image.
    return max(6.0, min(12.0, 1.4 + words / 2.25))


def load_scenes(path: Path, image_dir: Path, rng: random.Random) -> list[Scene]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    raw_scenes = data["scenes"] if isinstance(data, dict) else data
    image_effects = ("slow_zoom_in", "slow_zoom_out", "pan_left", "pan_right", "drama_push")
    text_effects = ("slide_up", "slide_left", "fade_pop", "type_reveal", "cinema_drop")

    scenes: list[Scene] = []
    for item in sorted(raw_scenes, key=lambda scene: int(scene["sceneNumber"])):
        visual = item.get("visualDescription", "").strip()
        narration = item.get("narration", "").strip()
        on_screen = item.get("onScreenText", "").strip()
        scenes.append(
            Scene(
                number=int(item["sceneNumber"]),
                visual=visual,
                narration=narration,
                on_screen=on_screen,
                image_path=find_image(image_dir, int(item["sceneNumber"])),
                duration=scene_duration(visual, narration, on_screen),
                image_effect=rng.choice(image_effects),
                text_effect=rng.choice(text_effects),
            )
        )
    return scenes


@lru_cache(maxsize=16)
def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = list(FONT_CANDIDATES)
    if bold:
        candidates = [path for path in candidates if path.endswith(("-B.ttf", "-Bold.ttf"))] + candidates

    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def ease_out_cubic(t: float) -> float:
    return 1 - pow(1 - clamp(t), 3)


def ease_in_out(t: float) -> float:
    t = clamp(t)
    return t * t * (3 - 2 * t)


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def cover_image(image: Image.Image, width: int, height: int, extra_scale: float, pan_x: float, pan_y: float) -> Image.Image:
    source_w, source_h = image.size
    scale = max(width / source_w, height / source_h) * extra_scale
    new_size = (math.ceil(source_w * scale), math.ceil(source_h * scale))
    resized = image.resize(new_size, Image.Resampling.LANCZOS)

    max_x = max(0, resized.width - width)
    max_y = max(0, resized.height - height)
    left = int(max_x * clamp(pan_x))
    top = int(max_y * clamp(pan_y))
    return resized.crop((left, top, left + width, top + height))


def image_motion(effect: str, progress: float) -> tuple[float, float, float]:
    eased = ease_in_out(progress)
    if effect == "slow_zoom_out":
        return 1.13 - 0.08 * eased, 0.5, 0.5
    if effect == "pan_left":
        return 1.10, 0.72 - 0.44 * eased, 0.5
    if effect == "pan_right":
        return 1.10, 0.28 + 0.44 * eased, 0.5
    if effect == "drama_push":
        return 1.03 + 0.11 * ease_out_cubic(progress), 0.5, 0.44 + 0.08 * eased
    return 1.03 + 0.08 * eased, 0.5, 0.5


@lru_cache(maxsize=1)
def vignette_overlay() -> Image.Image:
    y, x = np.ogrid[:HEIGHT, :WIDTH]
    cx, cy = WIDTH / 2, HEIGHT / 2
    distance = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / math.hypot(cx, cy)
    alpha = np.clip((distance - 0.45) / 0.55, 0, 1) * 120
    overlay = np.zeros((HEIGHT, WIDTH, 4), dtype=np.uint8)
    overlay[:, :, 3] = alpha.astype(np.uint8)
    return Image.fromarray(overlay, "RGBA")


def add_vignette(frame: Image.Image) -> Image.Image:
    return Image.alpha_composite(frame.convert("RGBA"), vignette_overlay())


def add_bottom_panel(frame: Image.Image, palette: dict[str, tuple[int, ...]]) -> Image.Image:
    overlay = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    top = TEXT_BOX_TOP - 90
    for y in range(top, HEIGHT):
        alpha = int(210 * clamp((y - top) / (HEIGHT - top)))
        draw.line((0, y, WIDTH, y), fill=(0, 0, 0, alpha))
    draw.rounded_rectangle(
        (42, TEXT_BOX_TOP - 36, WIDTH - 42, TEXT_BOX_BOTTOM + 24),
        radius=34,
        fill=palette["panel"],
        outline=palette["accent"] + (115,),
        width=2,
    )
    return Image.alpha_composite(frame, overlay)


def text_bbox(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, font: ImageFont.ImageFont) -> tuple[int, int, int, int]:
    return draw.textbbox(xy, text, font=font, stroke_width=0)


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current: list[str] = []
    for word in words:
        candidate = " ".join([*current, word]).strip()
        width = text_bbox(draw, (0, 0), candidate, font)[2]
        if width <= max_width or not current:
            current.append(word)
        else:
            lines.append(" ".join(current))
            current = [word]
    if current:
        lines.append(" ".join(current))
    return lines


def draw_text_with_shadow(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int, int],
    shadow: tuple[int, int, int, int],
    stroke_width: int = 0,
) -> None:
    x, y = xy
    draw.text((x + 3, y + 4), text, font=font, fill=shadow, stroke_width=stroke_width, stroke_fill=shadow)
    draw.text((x, y), text, font=font, fill=fill, stroke_width=stroke_width, stroke_fill=shadow)


def text_progress(effect: str, scene_progress: float, duration: float) -> tuple[float, int, int, float]:
    appear = clamp(scene_progress / min(0.28, 1.7 / duration))
    disappear = clamp((1.0 - scene_progress) / min(0.16, 1.0 / duration))
    alpha = min(ease_out_cubic(appear), ease_out_cubic(disappear))

    x_offset = 0
    y_offset = 0
    reveal = 1.0
    if effect == "slide_up":
        y_offset = int((1 - ease_out_cubic(appear)) * 110)
    elif effect == "slide_left":
        x_offset = int((1 - ease_out_cubic(appear)) * 150)
    elif effect == "fade_pop":
        scale_hint = 1 - 0.07 * (1 - ease_out_cubic(appear))
        y_offset = int((1 - scale_hint) * 80)
    elif effect == "type_reveal":
        reveal = clamp((scene_progress - 0.07) / 0.55)
    elif effect == "cinema_drop":
        y_offset = int(-(1 - ease_out_cubic(appear)) * 95)

    return alpha, x_offset, y_offset, reveal


def render_text_layer(
    scene: Scene,
    palette: dict[str, tuple[int, ...]],
    progress: float,
) -> Image.Image:
    layer = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    title_font = load_font(46, bold=True)
    narration_font = load_font(57, bold=True)
    visual_font = load_font(34)
    meta_font = load_font(27, bold=True)

    alpha, x_offset, y_offset, reveal = text_progress(scene.text_effect, progress, scene.duration)
    alpha_i = int(255 * alpha)
    if alpha_i <= 0:
        return layer

    accent = palette["accent"] + (alpha_i,)
    text = palette["text"] + (alpha_i,)
    muted = palette["muted"] + (int(alpha_i * 0.88),)
    shadow = palette["shadow"] + (int(alpha_i * 0.7),)
    max_width = WIDTH - SAFE_X * 2
    y = TEXT_BOX_TOP + y_offset
    x = SAFE_X + x_offset

    draw.rounded_rectangle((x, y - 42, x + 118, y - 20), radius=11, fill=accent)
    scene_label = f"SCENA {scene.number:02d}"
    draw_text_with_shadow(draw, (x, y - 84), scene_label, meta_font, accent, shadow)

    if scene.on_screen:
        lines = wrap_text(draw, scene.on_screen.upper(), title_font, max_width)
        for line in lines[:2]:
            draw_text_with_shadow(draw, (x, y), line, title_font, accent, shadow, stroke_width=1)
            y += 54
        y += 14

    narration = scene.narration
    if scene.text_effect == "type_reveal":
        narration = narration[: max(1, int(len(narration) * ease_out_cubic(reveal)))]

    for line in wrap_text(draw, narration, narration_font, max_width)[:4]:
        draw_text_with_shadow(draw, (x, y), line, narration_font, text, shadow, stroke_width=1)
        y += 67

    y += 20
    visual = scene.visual
    if scene.text_effect == "type_reveal" and reveal < 0.88:
        visual = ""
    for line in wrap_text(draw, visual, visual_font, max_width)[:4]:
        draw_text_with_shadow(draw, (x, y), line, visual_font, muted, shadow)
        y += 43

    return layer


def add_flash_transition(frame: Image.Image, scene_progress: float) -> Image.Image:
    edge = max(clamp(scene_progress / 0.09), clamp((1 - scene_progress) / 0.09))
    alpha = int(45 * ease_out_cubic(1 - edge))
    if alpha <= 0:
        return frame
    overlay = Image.new("RGBA", frame.size, (255, 255, 255, alpha))
    return Image.alpha_composite(frame, overlay)


def render_scene_frame(source: Image.Image, scene: Scene, palette: dict[str, tuple[int, ...]], progress: float) -> Image.Image:
    scale, pan_x, pan_y = image_motion(scene.image_effect, progress)
    frame = cover_image(source, WIDTH, HEIGHT, scale, pan_x, pan_y)
    frame = ImageEnhance.Contrast(frame).enhance(1.06)
    frame = ImageEnhance.Color(frame).enhance(0.96)
    frame = add_vignette(frame)
    frame = add_bottom_panel(frame, palette)
    frame = Image.alpha_composite(frame, render_text_layer(scene, palette, progress))
    frame = add_flash_transition(frame, progress)
    return frame.convert("RGB")


def build_video(scenes: list[Scene], output: Path, fps: int, palette: dict[str, tuple[int, ...]]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    writer = imageio.get_writer(output, fps=fps, codec="libx264", quality=8, macro_block_size=None)

    total_frames = 0
    try:
        for index, scene in enumerate(scenes, start=1):
            print(
                f"[{index}/{len(scenes)}] scene {scene.number}: "
                f"{scene.duration:.1f}s, image={scene.image_effect}, text={scene.text_effect}"
            )
            source = Image.open(scene.image_path).convert("RGB")
            frame_count = max(1, int(round(scene.duration * fps)))
            for frame_index in range(frame_count):
                progress = frame_index / max(1, frame_count - 1)
                frame = render_scene_frame(source, scene, palette, progress)
                writer.append_data(np.asarray(frame))
                total_frames += 1
    finally:
        writer.close()

    print(f"Done: {output}")
    print(f"Frames: {total_frames}, fps: {fps}, duration: {total_frames / fps:.1f}s")


def main() -> None:
    args = parse_args()
    rng = random.Random(args.seed)
    image_dir = choose_image_dir(args.images)
    palette = next((p for p in PALETTES if p["name"] == args.palette), None) if args.palette else rng.choice(PALETTES)
    scenes = load_scenes(args.scenes, image_dir, rng)

    print(f"Scenes: {len(scenes)}")
    print(f"Images: {image_dir}")
    print(f"Palette: {palette['name']}")
    print(f"Output: {args.output}")
    build_video(scenes, args.output, args.fps, palette)


if __name__ == "__main__":
    main()
