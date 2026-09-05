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


def quantize_png(path: pathlib.Path, max_colors: int = 256) -> None:
    """256 色量化 PNG（对动漫纹理肉眼无差）。已量化（P 模式）的跳过。"""
    before = path.stat().st_size
    img = Image.open(path)
    if img.mode == "P":
        return  # 已量化过
    rgb = img.convert("RGB")
    q = rgb.quantize(colors=max_colors, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)
    tmp = path.with_suffix(".tmp.png")
    q.save(tmp, optimize=True)
    after = tmp.stat().st_size
    if after < before * 0.85:  # 至少省 15% 才替换
        tmp.replace(path)
        print(f"  纹理量化 {path.name}: {human(before)} → {human(after)}")
    else:
        tmp.unlink()
        print(f"  纹理跳过 {path.name}: 量化无收益（{human(before)}）")


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

    tex_dir = ASSETS / "live2d" / "miku" / "miku.4096"
    if tex_dir.exists():
        total_before = sum(f.stat().st_size for f in tex_dir.glob("*.png"))
        for f in sorted(tex_dir.glob("*.png")):
            quantize_png(f)
        total_after = sum(f.stat().st_size for f in tex_dir.glob("*.png"))
        print(f"  纹理总体积: {human(total_before)} → {human(total_after)}")

    make_webp(ASSETS / "background.png", ASSETS / "background-blur.webp",
              width=1280, blur=14, quality=68)
    make_webp(ASSETS / "avatar.jpg", ASSETS / "avatar.webp", size=(512, 512), quality=82)

    make_thumbs(ASSETS / "gallery")
    make_thumbs(ASSETS / "says")

    print("optimize_assets 完成")


if __name__ == "__main__":
    main()
