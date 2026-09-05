#!/usr/bin/env python3
"""把全站 html 的静态资源版本号统一替换为指定值（CI 里传 git 短 SHA）。

用法：python tools/version_pin.py <sha>
匹配 ?v=任意字母数字（如 ?v=23 / ?v=abc1234），统一替换为 ?v=<sha>。
本地开发不跑此脚本（保持 ?v=23 即可），部署时由 CI 保证每次部署版本号唯一，
彻底绕开 GitHub Pages CDN 对同名 URL 的缓存。
"""
import re
import sys
import pathlib

sha = sys.argv[1] if len(sys.argv) > 1 else "dev"
root = pathlib.Path(__file__).resolve().parent.parent
files = list(root.glob("*.html")) + list((root / "posts").glob("*.html"))

changed = 0
for f in files:
    text = f.read_text(encoding="utf-8")
    new = re.sub(r"\?v=[A-Za-z0-9_]+", "?v=" + sha, text)
    if new != text:
        f.write_text(new, encoding="utf-8")
        changed += 1
print(f"version-pin: {changed} 个 html 的资源版本号已统一为 ?v={sha}")
