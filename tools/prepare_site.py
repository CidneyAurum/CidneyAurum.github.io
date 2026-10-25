#!/usr/bin/env python3
"""Stage only public website files for the GitHub Pages artifact."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIRS = ("assets", "css", "js", "data", "posts", "says")
PUBLIC_FILES = ("feed.xml", "sitemap.xml", "robots.txt", "manifest.webmanifest", "sw.js", "CNAME")


def prepare_site(root: Path = ROOT, destination: Path | None = None) -> Path:
    destination = (destination or root / "_site").resolve()
    root = root.resolve()
    if destination.parent != root or destination.name in PUBLIC_DIRS:
        raise ValueError("The staging directory must be a separate directory directly inside the repository.")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError(f"Staging directory must be empty: {destination}")
    destination.mkdir(parents=True, exist_ok=True)
    for source in list(root.glob("*.html")) + [root / name for name in PUBLIC_FILES]:
        if source.is_file():
            shutil.copy2(source, destination / source.name)
    for name in PUBLIC_DIRS:
        source = root / name
        if source.is_dir():
            shutil.copytree(source, destination / name, ignore=shutil.ignore_patterns(".*", "__pycache__"))
    (destination / ".nojekyll").touch()
    print(f"Pages artifact: {destination.name} ({sum(1 for path in destination.rglob('*') if path.is_file())} files)")
    return destination


if __name__ == "__main__":
    prepare_site()
