#!/usr/bin/env python3
"""资产体积优化（CI 运行，需要 Pillow；本地没有 Pillow 可跳过）。

做四件事，全部幂等（已处理过的文件自动跳过）：
1. Live2D 纹理 256 色量化：assets/live2d/miku/miku.4096/*.png（25.6MB → 约 6MB）
2. 背景图模糊版：assets/background.png → assets/background-blur.webp（运行时不再做 26px blur）
3. 头像 WebP：assets/avatar.jpg → assets/avatar.webp
4. 相册/说说缩略图：assets/gallery/thumbs/、assets/says/thumbs/（列表页用缩略图，灯箱才加载原图）
"""
import sys
import pathlib

try:
    from PIL import Image, ImageFilter, ImageOps
except ImportError:
    print("optimize_assets: 未安装 Pillow，跳过（CI 会安装后重跑）")
    sys.exit(0)

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"


def human(n: int) -> str:
    for unit in ("B", "KB", "MB"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}GB"


def make_webp(src: pathlib.Path, dst: pathlib.Path, *, width=None, size=None,
              blur=0, quality=80) -> None:
    """生成 WebP 派生图；目标已存在则跳过。"""
    if dst.exists() or not src.exists():
        return
    img = Image.open(src).convert("RGB")
    if size:
        img = ImageOps.fit(img, size, Image.LANCZOS)
    elif width and img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "WEBP", quality=quality, method=6)
    print(f"  webp {dst.relative_to(ROOT)}: {human(dst.stat().st_size)} (源 {human(src.stat().st_size)})")


def make_thumbs(folder: pathlib.Path, width: int = 420, quality: int = 78) -> None:
    """为目录内图片生成 thumbs/*.webp 缩略图。"""
    if not folder.exists():
        return
    out = folder / "thumbs"
    made = 0
    for f in sorted(folder.iterdir()):
        if f.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp") or f.is_dir():
            continue
        dst = out / (f.stem + ".webp")
        if dst.exists():
            continue
        img = Image.open(f).convert("RGB")
        if img.width > width:
            img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
        out.mkdir(parents=True, exist_ok=True)
        img.save(dst, "WEBP", quality=quality, method=6)
        made += 1
    if made:
        print(f"  缩略图 {out.relative_to(ROOT)}/: 新增 {made} 张")


def main() -> None:
    print("optimize_assets 开始")

    # Live2D 纹理保持原画质——量化压缩曾导致画质劣化，已应站主要求永久移除

    make_webp(ASSETS / "background.png", ASSETS / "background-blur.webp",
              width=1280, blur=14, quality=68)
    make_webp(ASSETS / "avatar.jpg", ASSETS / "avatar.webp", size=(512, 512), quality=82)

    # PWA 图标（方图 512/192）
    for size, name in ((512, "icon-512.png"), (192, "icon-192.png")):
        dst = ASSETS / name
        if dst.exists() or not (ASSETS / "avatar.jpg").exists():
            continue
        img = Image.open(ASSETS / "avatar.jpg").convert("RGB")
        img = ImageOps.fit(img, (size, size), Image.LANCZOS)
        q = img.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)
        q.save(dst, "PNG", optimize=True)
        print(f"  图标 {name}: {human(dst.stat().st_size)}")

    make_thumbs(ASSETS / "gallery")
    make_thumbs(ASSETS / "says")

    print("optimize_assets 完成")


if __name__ == "__main__":
    main()
