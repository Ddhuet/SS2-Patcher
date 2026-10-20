# Shining Soul II Patcher

A static web page that translates **Shining Soul II (GBA)** to English and applies gameplay
patches. Pick your ROM, tick patches, download the patched ROM. Everything runs in the browser;
the ROM is never uploaded. No ROMs are included in this repo.

Start from the Japanese ROM `Shining Soul II (Japan).gba`
(SHA-256 `9f3e0d0653de6504c1aeaf03de3cca06ae0c15a24089f0236398ec56d382d17a`, CRC32 `7B39A7B2`).
`english_translation.bps` turns it into the English ROM `ss2-en-phase1d.gba`
(SHA-256 `4343a9c7fa9b6f9889a5fd9e334b807ebf98e200729810e92108b27d9bb953cb`), which every other
patch is made against. That English ROM is also accepted as input; the translation is then skipped.
The page warns if your ROM is neither.

## Files

```
index.html          the page
patcher.js          IPS / IPS32 / BPS parser, conflict check, patching, SHA-256
patches/            the patches
  *.ips, *.bps      patch files (.ips32 is still read, but new 32 MiB patches ship as .bps)
  *.txt             optional description per patch (same name as the patch)
  base_rom.sha256   accepted input ROMs (Japanese first, then English)
  index.json        list of patches the page reads (generated, see below)
tools/make_index.py rebuilds patches/index.json
.githooks/          pre-commit hook that runs make_index.py
```

## Adding a patch

1. Copy `my_patch.ips` (or `.bps`, made against the English ROM) into `patches/`.
2. Optionally add `patches/my_patch.txt`:
   ```
   Title: My patch
   One or two sentences about what it does.
   ```
   Without a `Title:` line the title is made from the file name. `Kind: translation` (only on
   `english_translation.txt`) marks the patch that is applied first and ticked by default.
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
- **IPS32**: `IPS32` … `EEOF`, 32-bit offsets. Still read, no longer shipped.
- **BPS**: standard `BPS1` with source/target CRC32s; used for the translation and for patches
  that write above 16 MiB. A mod `.bps` is decoded against the English ROM and turned into a list
  of changed bytes, so it stacks and is conflict-checked like an IPS. In Flips / Rom Patcher JS a
  mod `.bps` only applies to the plain English ROM (its CRC check), so combine patches here.
- Order: translation first, then the gameplay patches. Output bigger than 16 MiB is padded with
  zeros to 32 MiB.
- Before patching, the selected patches are checked against each other. If two write different
  bytes to the same offset, the page refuses and names them. The current set doesn't overlap, so
  any combination applies.

The output is byte-identical to the desktop Patch Manager (`patch_manager.py`) for the same ROM
and patches.

## Credits

Most of these mods are by the Chinese Shining Soul II modding community, ported to the English
translation. `guaranteed_fusing`, `normal_attack_charge_accuracy`, `town_return_heal` and the
WAITCNT fix are new for the English ROM.
