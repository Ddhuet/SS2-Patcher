#!/usr/bin/env python3
"""Write patches/index.json from the .ips/.ips32/.bps files in patches/.

Each patch may have a sidecar <name>.txt next to it holding its description (plain text).
Leading "Key: value" lines are metadata: "Title: ..." overrides the title made from the file
name, "Kind: translation" marks the whole-ROM patch JP -> English and "Kind: cn_base" the one
JP -> Chinese community ROM; the page applies the chosen one first.
Chinese versions of the mods live in patches/cn/ (made by the modding repo's
Tools/Scripts/make_cn_set.py, which also writes cn/compat.json): each entry gets "cn" (that file)
or "cn_reason" (why the mod is English-only). base_rom.sha256 lines are "<sha256>  <jp|en|cn>  <label>";
they become "roms" in the index.
The pre-commit hook in .githooks/ runs this automatically; you can also run it by hand.
"""
import hashlib
import json
from pathlib import Path

PATCH_DIR = Path(__file__).resolve().parent.parent / "patches"
EXTS = (".ips", ".ips32", ".bps")
META = ("title", "kind")


def entry(path):
    item = {"file": path.name}
    side = path.with_suffix(".txt")
    if side.exists():
        lines = side.read_text(encoding="utf-8").strip().splitlines()
        while lines and lines[0].split(":", 1)[0].strip().lower() in META and ":" in lines[0]:
            key, value = lines.pop(0).split(":", 1)
            item[key.strip().lower()] = value.strip()
        desc = " ".join(l.strip() for l in lines if l.strip())
        if desc:
            item["description"] = desc
    item["size"] = path.stat().st_size
    item["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    return item


def cn_info(item):
    """Add the Chinese version (or why there is none) from cn/compat.json."""
    if item.get("kind") in ("translation", "cn_base"):
        return item
    stem = Path(item["file"]).stem
    cn = PATCH_DIR / "cn" / f"{stem}.bps"
    try:
        compat = json.loads((PATCH_DIR / "cn" / "compat.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        compat = {}
    entry = compat.get(stem, {})
    if cn.is_file() and entry.get("en_sha256") == item["sha256"]:
        item["cn"] = f"cn/{cn.name}"
        item["cn_sha256"] = hashlib.sha256(cn.read_bytes()).hexdigest()
    else:
        item["cn_reason"] = entry["reason"] if entry and not entry.get("cn") and \
            entry.get("en_sha256") == item["sha256"] else "no Chinese version made for this file yet"
    return item


def roms():
    out = {}
    f = PATCH_DIR / "base_rom.sha256"
    for line in f.read_text().splitlines() if f.exists() else []:
        parts = line.split(None, 2)
        if len(parts) >= 2 and parts[1] in ("jp", "en", "cn"):
            out[parts[1]] = {"sha256": parts[0].lower(), "label": parts[2] if len(parts) > 2 else ""}
    return out


def main():
    files = sorted((p for p in PATCH_DIR.iterdir() if p.is_file() and p.suffix.lower() in EXTS),
                   key=lambda p: p.name.lower())
    index = {"roms": roms(), "patches": [cn_info(entry(p)) for p in files]}
    out = PATCH_DIR / "index.json"
    text = json.dumps(index, indent=2, ensure_ascii=False) + "\n"
    if not out.exists() or out.read_text(encoding="utf-8") != text:
        out.write_text(text, encoding="utf-8")
        print(f"wrote {out.relative_to(PATCH_DIR.parent)} ({len(files)} patches)")


if __name__ == "__main__":
    main()
