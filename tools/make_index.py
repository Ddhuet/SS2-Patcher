#!/usr/bin/env python3
"""Write patches/index.json from the .ips/.ips32 files in patches/.

Each patch may have a sidecar <name>.txt next to it holding its description (plain text).
A first line of the form "Title: ..." overrides the title made from the file name.
The pre-commit hook in .githooks/ runs this automatically; you can also run it by hand.
"""
import hashlib
import json
from pathlib import Path

PATCH_DIR = Path(__file__).resolve().parent.parent / "patches"
EXTS = (".ips", ".ips32")


def entry(path):
    item = {"file": path.name}
    side = path.with_suffix(".txt")
    if side.exists():
        lines = side.read_text(encoding="utf-8").strip().splitlines()
        if lines and lines[0].lower().startswith("title:"):
            item["title"] = lines.pop(0).split(":", 1)[1].strip()
        desc = " ".join(l.strip() for l in lines if l.strip())
        if desc:
            item["description"] = desc
    item["size"] = path.stat().st_size
    item["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    return item


def main():
    files = sorted((p for p in PATCH_DIR.iterdir() if p.is_file() and p.suffix.lower() in EXTS),
                   key=lambda p: p.name.lower())
    index = {"patches": [entry(p) for p in files]}
    out = PATCH_DIR / "index.json"
    text = json.dumps(index, indent=2, ensure_ascii=False) + "\n"
    if not out.exists() or out.read_text(encoding="utf-8") != text:
        out.write_text(text, encoding="utf-8")
        print(f"wrote {out.relative_to(PATCH_DIR.parent)} ({len(files)} patches)")


if __name__ == "__main__":
    main()
