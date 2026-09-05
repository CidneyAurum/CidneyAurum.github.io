#!/usr/bin/env python3
"""一次性：给 data/playlist.json 的每首歌补真实封面 URL。

从 Meting 代理拉歌单（带 pic 代理地址），逐首跟随重定向解析出
网易云真实 CDN 地址（p?.music.126.net，长期稳定），写回快照。
"""
import json
import pathlib
import urllib.request

PLAYLIST_API = "https://api.injahow.cn/meting/?type=playlist&server=netease&id=18205251703"
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "playlist.json"


def final_url(url: str) -> str:
    """跟随 302 取最终资源地址。"""
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.geturl()
    except Exception:
        return url  # 解析失败就存代理地址，img 一样能用


def main() -> None:
    data = json.load(OUT.open(encoding="utf-8"))
    songs = data.get("playlist", [])
    print(f"快照现有 {len(songs)} 首")

    req = urllib.request.Request(PLAYLIST_API, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        remote = json.loads(r.read().decode("utf-8"))
    print(f"在线拉到 {len(remote)} 首")

    by_id = {}
    for s in remote:
        sid = str(s.get("id") or "")
        m = None
        # 代理 url 里有 id 参数
        raw = str(s.get("url") or "")
        import re
        m = re.search(r"[?&]id=(\d+)", raw)
        if m:
            sid = m.group(1)
        if sid:
            by_id[sid] = s

    patched, resolved = 0, 0
    for s in songs:
        sid = str(s.get("id") or "")
        remote_s = by_id.get(sid)
        if not remote_s:
            continue
        pic_proxy = remote_s.get("pic") or ""
        if pic_proxy and "music.126.net" not in pic_proxy:
            real = final_url(pic_proxy)
            if "music.126.net" in real:
                resolved += 1
            s["pic"] = real
        elif pic_proxy:
            s["pic"] = pic_proxy
        patched += 1

    data["updated"] = "2026-09-05"
    data["count"] = len(songs)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已补封面 {patched} 首（其中解析为网易云真实 CDN {resolved} 首）")


if __name__ == "__main__":
    main()
