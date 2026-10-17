# Shining Soul II Patcher

A static web page that applies gameplay patches to the **English translation of Shining Soul II
(GBA)**. Pick your ROM, tick patches, download the patched ROM. Everything runs in the browser;
the ROM is never uploaded. No ROMs are included in this repo.

The patches are made for the English ROM `ss2-en-phase1d.gba`
(SHA-256 `4343a9c7fa9b6f9889a5fd9e334b807ebf98e200729810e92108b27d9bb953cb`). The page warns if
your ROM is different.

## Files

```
index.html          the page
patcher.js          IPS / IPS32 parser, conflict check, patching, SHA-256
patches/            the patches
  *.ips, *.ips32    patch files
  *.txt             optional description per patch (same name as the patch)
  base_rom.sha256   the ROM the patches are made for
  index.json        list of patches the page reads (generated, see below)
tools/make_index.py rebuilds patches/index.json
.githooks/          pre-commit hook that runs make_index.py
```

## Adding a patch

1. Copy `my_patch.ips` (or `.ips32`) into `patches/`.
2. Optionally add `patches/my_patch.txt`:
   ```
   Title: My patch
   One or two sentences about what it does.
   ```
   Without a `Title:` line the title is made from the file name.
3. Commit and push. With the hook enabled (once per clone:
   `git config core.hooksPath .githooks`), `patches/index.json` is rebuilt and added on every
   commit. Without it, run `python3 tools/make_index.py` before committing.
4. On the server: `git pull`.

If `index.json` is missing, the page falls back to the server's directory listing of `patches/`
(nginx `autoindex on`, Apache `Options +Indexes`), descriptions included.

## Hosting

Any static web server works. Example nginx site:

```nginx
server {
    listen 80;
    server_name patcher.example.com;
    root /var/www/ss2-patcher;      # the git clone
    index index.html;

    location ~ /\.git { deny all; }
    location /patches/ { autoindex on; }   # optional, only for the fallback
}
```

Deploy and update:

```sh
git clone https://github.com/Ddhuet/SS2-Patcher.git /var/www/ss2-patcher
cd /var/www/ss2-patcher && git pull
```

Plain HTTP works (the page has its own SHA-256 when the browser's crypto API is unavailable),
but HTTPS (e.g. certbot) is recommended. Opening `index.html` straight from disk (`file://`) does not
work because browsers block `fetch` there; for local testing run `python3 -m http.server` in this folder.

## Formats and safety

- **IPS**: `PATCH` … `EOF`, 24-bit offsets, RLE records, optional truncate size.
- **IPS32**: `IPS32` … `EEOF`, 32-bit offsets. Needed for patches that write above 16 MiB.
  Flips and most other IPS tools can't read these; this page can.
- Before patching, the selected patches are checked against each other. If two write different
  bytes to the same offset, the page refuses and names them. The current set doesn't overlap, so
  any combination applies.

The output is byte-identical to the desktop Patch Manager (`patch_manager.py`) for the same ROM
and patches.

## Credits

Most of these mods are by the Chinese Shining Soul II modding community, ported to the English
translation. `guaranteed_fusing`, `normal_attack_charge_accuracy`, `town_return_heal` and the
WAITCNT fix are new for the English ROM.
