// Shining Soul II web patcher: the browser version of Patch_Manager/patch_manager.py.
//
// Reads the patch list from patches/index.json (written by tools/make_index.py). If that file is
// missing it falls back to the web server's directory listing of patches/ (nginx autoindex,
// Apache Indexes, python -m http.server), so new .ips files show up even before the index is rebuilt.
//
// Formats: IPS ("PATCH" ... "EOF", 24-bit offsets, RLE records, optional truncate size),
// IPS32 ("IPS32" ... "EEOF", 32-bit offsets) and BPS ("BPS1", with source/target CRC32s).
// Two base patches turn the Japanese ROM into a playable base and are applied first (tick one):
// "kind": "translation" (JP -> English) and "kind": "cn_base" (JP -> the Chinese community ROM,
// SS2_SC_bug_fixed). Every mod is made against the English ROM. When the result is the Chinese
// game (Chinese base ticked, or the Chinese ROM uploaded) each mod is swapped for its Chinese
// version, patches/cn/<name>.bps ("cn" in index.json); mods without one ("cn_reason") are greyed
// out. Same rules as Patch_Manager/patch_manager.py, so both give byte-identical ROMs. A mod BPS is decoded
// against the ROM at that point and turned into a list of changed bytes, so all mods go through
// the same conflict check: two patches that write different bytes to the same offset are refused
// (identical bytes are allowed). Output bigger than 16 MiB is padded with zeros to 32 MiB.
"use strict";

const PATCH_DIR = "patches/";
const EXTS = [".ips", ".ips32", ".bps"];
const MIB16 = 0x1000000, MIB32 = 0x2000000;
const STORE_KEY = "ss2-patcher-selection";

const $ = (id) => document.getElementById(id);
const state = { patches: [], base: new Map(), baseKind: new Map(), baseName: "", rom: null, romName: "",
  romSha: "", romKind: null };

// ---------------------------------------------------------------- patch logic

class PatchError extends Error {}

function bytesEqual(data, pos, str) {
  if (pos + str.length > data.length) return false;
  for (let i = 0; i < str.length; i++) if (data[pos + i] !== str.charCodeAt(i)) return false;
  return true;
}

function readInt(data, pos, width) {
  let v = 0;
  for (let i = 0; i < width; i++) v = v * 256 + data[pos + i];
  return v;
}

// Parse an IPS/IPS32 file into {writes: [[offset, Uint8Array]], truncate}.
function parsePatch(name, data) {
  let pos, width, eof;
  if (bytesEqual(data, 0, "IPS32")) [pos, width, eof] = [5, 4, "EEOF"];
  else if (bytesEqual(data, 0, "PATCH")) [pos, width, eof] = [5, 3, "EOF"];
  else throw new PatchError(`${name}: not an IPS or IPS32 file`);
  const writes = [];
  let truncate = null;
  for (;;) {
    const left = data.length - pos;
    if (bytesEqual(data, pos, eof) && (width === 4 || left === 3 || left === 6)) {
      if (width === 3 && left === 6) truncate = readInt(data, pos + 3, 3);
      break;
    }
    if (pos + width + 2 > data.length) throw new PatchError(`${name}: truncated (no ${eof} marker)`);
    const off = readInt(data, pos, width);
    const size = readInt(data, pos + width, 2);
    pos += width + 2;
    if (size === 0) { // RLE record
      const count = readInt(data, pos, 2);
      writes.push([off, new Uint8Array(count).fill(data[pos + 2])]);
      pos += 3;
    } else {
      if (pos + size > data.length) throw new PatchError(`${name}: truncated record at 0x${off.toString(16)}`);
      writes.push([off, data.subarray(pos, pos + size)]);
      pos += size;
    }
  }
  return { writes, truncate };
}

// ---------------------------------------------------------------- BPS

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const hex8 = (v) => v.toString(16).toUpperCase().padStart(8, "0");
const le32 = (d, p) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;

// Parse a BPS header and footer: {name, data, pos (first command), sourceSize, targetSize, sourceCrc, targetCrc}.
function parseBps(name, data) {
  if (!bytesEqual(data, 0, "BPS1") || data.length < 19) throw new PatchError(`${name}: not a BPS file`);
  if (crc32(data.subarray(0, data.length - 4)) !== le32(data, data.length - 4)) {
    throw new PatchError(`${name}: the patch file is damaged (checksum mismatch)`);
  }
  const bps = { name, data, pos: 4 };
  const num = () => bpsNumber(bps);
  bps.sourceSize = num();
  bps.targetSize = num();
  const metaSize = num();
  bps.pos += metaSize; // skip metadata
  bps.sourceCrc = le32(data, data.length - 12);
  bps.targetCrc = le32(data, data.length - 8);
  bps.start = bps.pos;
  return bps;
}

function bpsNumber(bps) {
  let value = 0, shift = 1;
  for (;;) {
    if (bps.pos >= bps.data.length - 12) throw new PatchError(`${bps.name}: truncated`);
    const b = bps.data[bps.pos++];
    value += (b & 0x7f) * shift;
    if (b & 0x80) return value;
    shift *= 128;
    value += shift;
  }
}

// Decode a BPS against source. romCrc may be passed when already known.
function applyBps(source, bps, romCrc = crc32(source)) {
  if (source.length !== bps.sourceSize || romCrc !== bps.sourceCrc) {
    throw new PatchError(`${bps.name} was made for a different ROM (expected CRC32 ${hex8(bps.sourceCrc)}, ` +
      `size ${bps.sourceSize}; this one is ${hex8(romCrc)}, size ${source.length}).`);
  }
  const out = new Uint8Array(bps.targetSize);
  const d = bps.data, end = d.length - 12;
  let out_ = 0, srcRel = 0, tgtRel = 0;
  bps.pos = bps.start;
  while (bps.pos < end) {
    const cmd = bpsNumber(bps), len = Math.floor(cmd / 4) + 1, action = cmd % 4;
    if (out_ + len > out.length) throw new PatchError(`${bps.name}: writes past the end of the ROM`);
    if (action === 0) {            // SourceRead
      out.set(source.subarray(out_, out_ + len), out_);
    } else if (action === 1) {     // TargetRead
      out.set(d.subarray(bps.pos, bps.pos + len), out_);
      bps.pos += len;
    } else {                       // SourceCopy / TargetCopy
      const r = bpsNumber(bps), delta = (r & 1 ? -1 : 1) * Math.floor(r / 2);
      if (action === 2) {
        srcRel += delta;
        out.set(source.subarray(srcRel, srcRel + len), out_);
        srcRel += len;
      } else {
        tgtRel += delta;
        for (let i = 0; i < len; i++) out[out_ + i] = out[tgtRel++]; // may overlap
      }
    }
    out_ += len;
  }
  if (out_ !== out.length || crc32(out) !== bps.targetCrc) {
    throw new PatchError(`${bps.name}: the result failed its checksum`);
  }
  return out;
}

// The bytes a BPS changes in base, as IPS-style writes.
function bpsWrites(base, bps, baseCrc) {
  const target = applyBps(base, bps, baseCrc);
  const writes = [];
  for (let i = 0; i < target.length;) {
    if (i < base.length && target[i] === base[i]) { i++; continue; }
    const start = i;
    while (i < target.length && !(i < base.length && target[i] === base[i])) i++;
    writes.push([start, target.subarray(start, i)]);
  }
  return { writes, truncate: null };
}

// Pad output that went past 16 MiB to the full 32 MiB a GBA cartridge maps.
function padRom(rom) {
  if (rom.length <= MIB16 || rom.length >= MIB32) return rom;
  const out = new Uint8Array(MIB32);
  out.set(rom);
  return out;
}

// [patch A, patch B, first offset] for each pair that writes different bytes to the same place.
function conflicts(patches) {
  const owner = new Map();
  const found = new Map();
  for (const p of patches) {
    for (const [off, data] of p.parsed.writes) {
      for (let i = 0; i < data.length; i++) {
        const prev = owner.get(off + i);
        if (prev && prev[1] !== data[i] && prev[0] !== p.title) {
          const key = prev[0] + "\0" + p.title;
          if (!found.has(key)) found.set(key, [prev[0], p.title, off + i]);
        }
        owner.set(off + i, [p.title, data[i]]);
      }
    }
  }
  return [...found.values()];
}

function applyPatches(rom, patches) {
  let size = rom.length;
  for (const p of patches) for (const [off, data] of p.parsed.writes) size = Math.max(size, off + data.length);
  const out = new Uint8Array(size);
  out.set(rom);
  let len = rom.length;
  for (const p of patches) {
    for (const [off, data] of p.parsed.writes) {
      out.set(data, off);
      len = Math.max(len, off + data.length);
    }
    if (p.parsed.truncate !== null && p.parsed.truncate < len) {
      out.fill(0, p.parsed.truncate); // like Python's del: later writes past it see zeros
      len = p.parsed.truncate;
    }
  }
  return out.subarray(0, len);
}

// ---------------------------------------------------------------- SHA-256
// crypto.subtle only exists on HTTPS (or localhost); plain-HTTP hosting uses the JS version.

async function sha256(bytes) {
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256js(bytes);
}

function sha256js(bytes) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const n = bytes.length;
  const total = Math.ceil((n + 9) / 64) * 64;
  const tail = new Uint8Array(total - Math.floor(n / 64) * 64);
  tail.set(bytes.subarray(Math.floor(n / 64) * 64));
  tail[n % 64] = 0x80;
  const bits = n * 8;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
  tv.setUint32(tail.length - 4, bits >>> 0);
  const W = new Uint32Array(64);
  const rotr = (x, r) => (x >>> r) | (x << (32 - r));
  const block = (view, base) => {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(base + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      W[i] = (W[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[i - 7] +
              (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  };
  const main = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const full = Math.floor(n / 64) * 64;
  for (let p = 0; p < full; p += 64) block(main, p);
  for (let p = 0; p < tail.length; p += 64) block(tv, p);
  return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}

// ---------------------------------------------------------------- loading the patch list

function pretty(stem) {
  const s = stem.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function isPatchFile(name) {
  return EXTS.some((e) => name.toLowerCase().endsWith(e));
}

async function fetchIndex() {
  const r = await fetch(PATCH_DIR + "index.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
  const j = await r.json();
  return j.patches.filter((p) => isPatchFile(p.file));
}

// Fallback: scrape the server's directory listing for patch links.
async function fetchListing() {
  const r = await fetch(PATCH_DIR, { cache: "no-cache" });
  if (!r.ok) throw new Error(`directory listing: HTTP ${r.status}`);
  const doc = new DOMParser().parseFromString(await r.text(), "text/html");
  const names = new Set();
  for (const a of doc.querySelectorAll("a[href]")) {
    const name = decodeURIComponent(a.getAttribute("href").split(/[?#]/)[0].split("/").pop());
    if (isPatchFile(name) || name.toLowerCase().endsWith(".txt")) names.add(name);
  }
  return Promise.all([...names].filter(isPatchFile).map(async (file) => {
    const side = file.replace(/\.[^.]+$/, ".txt");
    if (!names.has(side)) return { file };
    try {
      const t = await fetch(PATCH_DIR + encodeURIComponent(side), { cache: "no-cache" });
      return t.ok ? { file, ...parseSidecar(await t.text()) } : { file };
    } catch (e) { return { file }; }
  }));
}

// Same rules as tools/make_index.py: optional leading "Title: ..." / "Kind: ..." lines, the rest is the description.
function parseSidecar(text) {
  const lines = text.trim().split(/\r?\n/);
  const out = {};
  while (lines.length && /^(title|kind):/i.test(lines[0])) {
    const [key, ...rest] = lines.shift().split(":");
    out[key.trim().toLowerCase()] = rest.join(":").trim();
  }
  const desc = lines.map((l) => l.trim()).filter(Boolean).join(" ");
  if (desc) out.description = desc;
  return out;
}

async function loadBase() {
  try {
    const r = await fetch(PATCH_DIR + "base_rom.sha256", { cache: "no-cache" });
    if (!r.ok) return;
    for (const line of (await r.text()).split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const sha = (parts[0] || "").toLowerCase();
      const kind = ["jp", "en", "cn"].includes(parts[1]) ? parts[1] : null;
      const name = parts.slice(kind ? 2 : 1).join(" ");
      if (!sha) continue;
      state.base.set(sha, name);
      if (kind) state.baseKind.set(sha, kind);
      if (name && !state.baseName) state.baseName = name;
    }
    if (state.baseName) $("base-name").textContent = state.baseName;
  } catch (e) { /* no base file: skip the ROM check */ }
}

async function loadPatches() {
  let list;
  try {
    list = await fetchIndex();
  } catch (e) {
    try {
      list = await fetchListing();
    } catch (e2) {
      $("list").innerHTML = "";
      const li = document.createElement("li");
      li.className = "err";
      li.textContent = `Could not load the patch list (${e.message}; ${e2.message}).`;
      $("list").append(li);
      return;
    }
  }
  const saved = loadSelection();
  const baseOf = (p) => ({ translation: "en", cn_base: "cn" })[(p.kind || "").toLowerCase()] || null;
  const order = { en: 0, cn: 1 };
  state.patches = list
    .map((p) => {
      const stem = p.file.replace(/\.[^.]+$/, "");
      const base = baseOf(p);
      return {
        file: p.file,
        title: p.title || pretty(stem),
        description: p.description || "",
        ips32: p.file.toLowerCase().endsWith(".ips32"),
        bps: p.file.toLowerCase().endsWith(".bps"),
        base,
        translation: base === "en",
        cn: p.cn || null,
        cnReason: p.cn_reason || "it has no Chinese version",
        checked: saved.size ? saved.has(p.file) : base === "en",
      };
    })
    .sort((a, b) => ((order[a.base] ?? 2) - (order[b.base] ?? 2)) ||
      a.file.toLowerCase().localeCompare(b.file.toLowerCase()));
  if (!state.patches.some((p) => p.base && p.checked)) {
    const tr = state.patches.find((p) => p.base === "en");
    if (tr) tr.checked = true;
  }
  renderList();
}

function loadSelection() {
  try { return new Set(JSON.parse(localStorage.getItem(STORE_KEY) || "[]")); } catch (e) { return new Set(); }
}

function saveSelection() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(selected().map((p) => p.file))); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- UI

// "cn" when the download will be the Chinese game, else "en".
function language() {
  const base = state.patches.find((p) => p.base && p.checked);
  if (base) return base.base;
  return state.romKind === "cn" ? "cn" : "en";
}

// Why p can't be used right now ("" when it can): base patches need the Japanese ROM,
// English-only mods can't go on the Chinese game.
function unavailable(p) {
  if (p.base) return state.romKind === "en" || state.romKind === "cn" ? "your ROM is already patched" : "";
  return language() === "cn" && !p.cn ? `English only: ${p.cnReason}` : "";
}

// Untick what can't apply; bases first, since unticking one can change the language.
function settleChecks() {
  for (const p of state.patches) if (p.base && unavailable(p)) p.checked = false;
  for (const p of state.patches) if (!p.base && unavailable(p)) p.checked = false;
}

function renderList() {
  settleChecks();
  const ul = $("list");
  ul.innerHTML = "";
  if (!state.patches.length) {
    const li = document.createElement("li");
    li.className = "desc";
    li.textContent = "No patches found in patches/.";
    ul.append(li);
  }
  for (const p of state.patches) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = p.checked;
    const why = unavailable(p);
    cb.disabled = !!why;
    if (why) label.classList.add("off");
    cb.addEventListener("change", () => {
      p.checked = cb.checked;
      if (p.base && p.checked) for (const q of state.patches) if (q.base && q !== p) q.checked = false;
      saveSelection();
      if (p.base) renderList(); else updateStatus();
    });
    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = p.title;
    if (p.ips32 || p.bps) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = p.base ? "base, applied first" : p.ips32 ? "IPS32" : "BPS";
      name.append(tag);
    }
    text.append(name);
    if (p.description) {
      const d = document.createElement("div");
      d.className = "desc";
      d.textContent = p.description;
      text.append(d);
    }
    if (why) {
      const w = document.createElement("div");
      w.className = "desc why";
      w.textContent = why.charAt(0).toUpperCase() + why.slice(1) + ".";
      text.append(w);
    }
    const dl = document.createElement("a");
    dl.className = "dl";
    dl.href = PATCH_DIR + encodeURIComponent(p.file);
    dl.download = p.file;
    dl.textContent = p.file;
    dl.title = "Download this patch file on its own";
    dl.addEventListener("click", (e) => e.stopPropagation());
    label.append(cb, text, dl);
    li.append(label);
    ul.append(li);
  }
  updateStatus();
}

function selected() {
  return state.patches.filter((p) => p.checked);
}

function setStatus(text, cls = "") {
  const s = $("status");
  s.textContent = text;
  s.className = cls;
}

function updateStatus() {
  const n = selected().length;
  setStatus(`${n} of ${state.patches.length} patches selected.`);
  $("apply").disabled = !state.rom || n === 0;
}

async function setRom(file) {
  const info = $("rom-info");
  info.className = "info";
  info.textContent = `Reading ${file.name}…`;
  state.rom = new Uint8Array(await file.arrayBuffer());
  state.romName = file.name;
  info.textContent = `Hashing ${file.name}…`;
  state.romSha = await sha256(state.rom);
  const short = state.romSha.slice(0, 16) + "…";
  if (state.base.size && !state.base.has(state.romSha)) {
    info.className = "info warn";
    info.textContent = `${file.name}: SHA-256 ${short} — not the ROM these patches were made for` +
      (state.baseName ? ` (${state.baseName}). ` : ". ") + "Patching may break the game.";
  } else {
    info.className = "info ok";
    const which = state.base.get(state.romSha);
    info.textContent = `${file.name}: SHA-256 ${short}` + (which ? ` — matches ${which}.` : "");
  }
  const was = state.romKind;
  state.romKind = state.baseKind.get(state.romSha) || null;
  if (state.romKind === "jp" && was && was !== "jp" && !state.patches.some((p) => p.base && p.checked)) {
    const tr = state.patches.find((p) => p.base === "en");
    if (tr) tr.checked = true; // back on the Japanese ROM: default to English again
  }
  renderList();
}

function outputName(names, applied) {
  const stem = applied ? (applied.base === "cn" ? "Shining Soul II (Chinese)" : "Shining Soul II (English)")
    : state.romName.replace(/\.[^.]+$/, "");
  if (!names.length) return `${stem}.gba`;
  const ext = (state.romName.match(/\.[^.]+$/) || [".gba"])[0];
  const tag = names.length <= 3 ? names.join("+") : `${names.length}_patches`;
  return `${stem}+${tag}${ext}`;
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function doApply() {
  const chosen = selected();
  if (!state.rom || !chosen.length) return;
  $("apply").disabled = true;
  try {
    setStatus("Downloading patches…");
    const tr = state.patches.find((p) => p.base === "en");
    const cnb = state.patches.find((p) => p.base === "cn");
    for (const p of [tr, cnb, ...chosen]) if (p) await loadPatchFile(p);
    if (language() === "cn") {
      for (const p of chosen) {
        if (p.base || !p.cn) continue;
        p.cnPatch = p.cnPatch || { file: p.cn, title: p.title, bps: true };
        await loadPatchFile(p.cnPatch);
      }
    }
    setStatus("Patching…");
    await new Promise((r) => setTimeout(r)); // let the status paint
    const { out, applied, mods } = buildRom(state.rom, chosen, tr, cnb);
    const sha = await sha256(out);
    const name = outputName(mods.map((p) => p.file.replace(/^cn\//, "").replace(/\.[^.]+$/, "")), applied);
    download(out, name);
    setStatus(`Downloaded ${name}\n(${chosen.length} patches, SHA-256 ${sha.slice(0, 16)}…)`, "ok");
  } catch (e) {
    setStatus(e.message || String(e), "err");
  } finally {
    $("apply").disabled = !state.rom || !selected().length;
  }
}

async function loadPatchFile(p) {
  if (p.parsed || p.bpsData) return;
  const r = await fetch(PATCH_DIR + p.file.split("/").map(encodeURIComponent).join("/"), { cache: "no-cache" });
  if (!r.ok) throw new PatchError(`${p.file}: HTTP ${r.status}`);
  const data = new Uint8Array(await r.arrayBuffer());
  if (p.bps) p.bpsData = parseBps(p.file, data);
  else p.parsed = parsePatch(p.file, data);
}

// Base patch first (if chosen), then the mods as one conflict-checked set of writes, then padding.
// tr / cnb are the English / Chinese base patches (chosen or not), used to recognise the input ROM.
// On the Chinese ROM each mod is swapped for its Chinese version (p.cnPatch, loaded beforehand).
function romKindOf(crc, tr, cnb) {
  if ((tr && crc === tr.bpsData.sourceCrc) || (cnb && crc === cnb.bpsData.sourceCrc)) return "jp";
  if (tr && crc === tr.bpsData.targetCrc) return "en";
  if (cnb && crc === cnb.bpsData.targetCrc) return "cn";
  return null;
}

function buildRom(rom, chosen, tr, cnb) {
  const bases = chosen.filter((p) => p.base);
  let mods = chosen.filter((p) => !p.base);
  if (bases.length > 1) throw new PatchError("Tick only one of the English translation and the Chinese ROM.");
  const base = bases[0] || null;
  if (base && base.base === "en") tr = base;
  else if (base) cnb = base;
  let crc = crc32(rom), applied = null;
  let kind = romKindOf(crc, tr, cnb);
  if (base) {
    const b = base.bpsData;
    if (!(rom.length === b.targetSize && crc === b.targetCrc)) { // not that base yet
      if (crc !== b.sourceCrc) {
        const other = { en: "English", cn: "Chinese" }[kind];
        throw new PatchError(`${base.title} needs the Japanese ROM, Shining Soul II (Japan).gba ` +
          `(CRC32 ${hex8(b.sourceCrc)}). ` + (other ? `This is already the ${other} ROM: untick "${base.title}".`
            : `Your ROM's CRC32 is ${hex8(crc)}.`));
      }
      rom = applyBps(rom, b, crc);
      crc = b.targetCrc;
      applied = base;
      kind = romKindOf(crc, tr, cnb);
    }
  } else if (mods.length && kind === "jp") {
    throw new PatchError(`This is the Japanese ROM; tick "${tr ? tr.title : "English translation"}" ` +
      `(or "${cnb ? cnb.title : "Chinese"}" for the Chinese game) first.`);
  }
  if (kind === "cn") {
    mods = mods.map((p) => {
      if (!p.cnPatch) throw new PatchError(`${p.title} only works on the English ROM: ${p.cnReason}.`);
      return p.cnPatch;
    });
  }
  for (const p of mods) if (p.bps) p.parsed = bpsWrites(rom, p.bpsData, crc);
  const clash = conflicts(mods);
  if (clash.length) {
    throw new PatchError("These patches write different bytes to the same place:\n" +
      clash.map(([a, b, o]) => `  ${a} / ${b} at 0x${hex8(o)}`).join("\n"));
  }
  return { out: padRom(applyPatches(rom, mods)), applied, mods };
}

function setup() {
  const drop = $("drop");
  const input = $("rom-file");
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", () => { if (input.files[0]) setRom(input.files[0]); });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer.files[0]) setRom(e.dataTransfer.files[0]);
  });
  $("all").addEventListener("click", () => {
    state.patches.forEach((p) => { if (!p.base && !unavailable(p)) p.checked = true; });
    saveSelection(); renderList();
  });
  $("none").addEventListener("click", () => {
    state.patches.forEach((p) => { if (!p.base) p.checked = false; });
    saveSelection(); renderList();
  });
  $("apply").addEventListener("click", doApply);
  loadBase().then(loadPatches);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parsePatch, parseBps, applyBps, bpsWrites, buildRom, crc32, padRom, PatchError };
} else {
  setup();
}
