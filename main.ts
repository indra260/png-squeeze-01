// png-squeeze-01: a lossless PNG compressor written from scratch.
// Reads 1280x720 RGBA screenshots from /input/<id>/image.png (or
// MAKEFUN_INPUT_DIR) and writes the smallest equivalent PNG it can find to
// /output/<id>/image.png (or MAKEFUN_OUTPUT_DIR). Node 22 stdlib only, no
// network, no clock, no environment-driven variation: two runs on the same
// set produce byte-identical output.
//
// Pipeline per instance: strict-decode the stored PNG to RGBA, analyse the
// picture (opaque? grey? at most 256 colours?), build candidate colour-type
// forms (palette in two orders, grey / grey+alpha / RGB / RGBA, with a
// transparent-key tRNS form where one exists), pick a per-row filter for
// each form under several strategies, screen the candidates with zlib
// level 6, then compress the finalists with zlib level 9 variants and with a
// hand-written DEFLATE encoder (one lazy parse, then one or two
// optimal-parse passes in the manner of zopfli, plus an all-candidates or
// plus-8 pass per stream size), keeping the smallest.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants as zc, deflateSync, inflateSync } from 'node:zlib';

const W = 1280;
const H = 720;
const NPIX = W * H;

// ---------------------------------------------------------------- CRC-32 --
// The standard PNG polynomial, built once into a 256-entry table.
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// -------------------------------------------------------------- Adler-32 --
// Computed in 5552-byte pieces with a modulo reduction, as zlib does.
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let off = 0; off < data.length; off += 5552) {
    const end = Math.min(data.length, off + 5552);
    for (let i = off; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return (((b % 65521) << 16) | (a % 65521)) >>> 0;
}

// ------------------------------------------------------------ PNG decode --
// Strict reader: only IHDR, PLTE, tRNS, IDAT and IEND chunks are accepted,
// every chunk CRC must match, and nothing may follow IEND. The input is
// always a stored RGBA PNG, but every colour type is expanded correctly so
// a transparent pixel's colour is preserved exactly as stored.

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const BPP_OF_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface Decoded {
  width: number;
  height: number;
  rgba: Buffer;
}

function fail(msg: string): never {
  throw new Error(msg);
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function decodePng(file: Buffer): Decoded {
  if (file.length < 8) fail('file too short for a PNG signature');
  for (let i = 0; i < 8; i++) if (file[i] !== PNG_SIG[i]) fail('bad PNG signature');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idatParts: Buffer[] = [];
  let seenIend = false;
  let seenIhdr = false;

  while (pos + 8 <= file.length) {
    const len = file.readUInt32BE(pos);
    const type = file.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > file.length) fail('chunk overruns the file: ' + type);
    const storedCrc = file.readUInt32BE(dataEnd);
    const calc = crc32(file, pos + 4, dataEnd);
    if (calc !== storedCrc) fail('CRC mismatch in chunk ' + type);
    const data = file.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (seenIhdr) fail('two IHDR chunks');
      seenIhdr = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
      if (data[10] !== 0 || data[11] !== 0) fail('unknown compression or filter method');
    } else if (type === 'PLTE') {
      plte = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      if (len !== 0) fail('IEND carries data');
      seenIend = true;
      pos = dataEnd + 4;
      break;
    } else {
      fail('unknown chunk: ' + type);
    }
    pos = dataEnd + 4;
  }
  if (!seenIend) fail('no IEND chunk');
  if (pos !== file.length) fail('trailing bytes after IEND');
  if (!seenIhdr) fail('no IHDR chunk');
  if (bitDepth !== 8) fail('bit depth is not 8');
  if (interlace !== 0) fail('interlaced PNG');
  const bpp = BPP_OF_TYPE[colourType];
  if (bpp === undefined) fail('unsupported colour type ' + colourType);
  if (colourType === 3 && !plte) fail('palette image without PLTE');

  const rowBytes = width * bpp;
  const raw = inflateSync(Buffer.concat(idatParts));
  const want = height * (rowBytes + 1);
  if (raw.length !== want) fail('inflated length ' + raw.length + ' != ' + want);

  // Unfilter each row in place into a samples buffer.
  const samples = Buffer.alloc(height * rowBytes);
  const prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const src = y * (rowBytes + 1);
    const filter = raw[src];
    const row = raw.subarray(src + 1, src + 1 + rowBytes);
    const out = samples.subarray(y * rowBytes, (y + 1) * rowBytes);
    if (filter === 0) {
      row.copy(out);
    } else if (filter === 1) {
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? out[i - bpp] : 0;
        out[i] = (row[i] + left) & 0xff;
      }
    } else if (filter === 2) {
      for (let i = 0; i < rowBytes; i++) out[i] = (row[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? out[i - bpp] : 0;
        out[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? out[i - bpp] : 0;
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        out[i] = (row[i] + paethPredictor(left, prev[i], upLeft)) & 0xff;
      }
    } else {
      fail('unknown row filter ' + filter);
    }
    out.copy(prev);
  }

  // Expand the samples to full RGBA, preserving transparent colours.
  const rgba = Buffer.alloc(NPIX * 4);
  if (colourType === 6) {
    samples.copy(rgba);
  } else if (colourType === 2) {
    let keyR = -1;
    let keyG = -1;
    let keyB = -1;
    if (trns && trns.length >= 6) {
      keyR = trns.readUInt16BE(0);
      keyG = trns.readUInt16BE(2);
      keyB = trns.readUInt16BE(4);
    }
    for (let p = 0; p < NPIX; p++) {
      const s = p * 3;
      const d = p * 4;
      const r = samples[s];
      const g = samples[s + 1];
      const b = samples[s + 2];
      rgba[d] = r;
      rgba[d + 1] = g;
      rgba[d + 2] = b;
      rgba[d + 3] = r === keyR && g === keyG && b === keyB ? 0 : 255;
    }
  } else if (colourType === 0) {
    let key = -1;
    if (trns && trns.length >= 2) key = trns.readUInt16BE(0);
    for (let p = 0; p < NPIX; p++) {
      const g = samples[p];
      const d = p * 4;
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let p = 0; p < NPIX; p++) {
      const g = samples[p * 2];
      const d = p * 4;
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = samples[p * 2 + 1];
    }
  } else {
    // Palette: PLTE gives RGB, tRNS gives alpha per entry (default 255).
    const entries = plte!.length / 3;
    const palR = new Uint8Array(entries);
    const palG = new Uint8Array(entries);
    const palB = new Uint8Array(entries);
    const palA = new Uint8Array(entries).fill(255);
    for (let e = 0; e < entries; e++) {
      palR[e] = plte![e * 3];
      palG[e] = plte![e * 3 + 1];
      palB[e] = plte![e * 3 + 2];
    }
    if (trns) for (let e = 0; e < trns.length && e < entries; e++) palA[e] = trns[e];
    for (let p = 0; p < NPIX; p++) {
      const idx = samples[p];
      const d = p * 4;
      rgba[d] = palR[idx];
      rgba[d + 1] = palG[idx];
      rgba[d + 2] = palB[idx];
      rgba[d + 3] = palA[idx];
    }
  }
  return { width, height, rgba };
}

// ------------------------------------------- Analysis and candidate forms --
// One pass records whether every pixel is opaque, whether the picture is
// grey (R == G == B everywhere), and the distinct RGBA colours, stopping the
// count as soon as a 257th colour appears: only "at most 256" matters.

interface Analysis {
  allOpaque: boolean;
  isGrey: boolean;
  // Present only when the picture holds at most 256 distinct colours.
  colours: { word: number; r: number; g: number; b: number; a: number; count: number }[] | null;
}

function analyse(rgba: Buffer): Analysis {
  let allOpaque = true;
  let isGrey = true;
  const counts = new Map<number, number>();
  let tooMany = false;
  for (let p = 0; p < NPIX; p++) {
    const d = p * 4;
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) allOpaque = false;
    if (r !== g || g !== b) isGrey = false;
    if (!tooMany) {
      const word = r * 0x1000000 + g * 0x10000 + b * 0x100 + a;
      const prev = counts.get(word);
      if (prev === undefined) {
        if (counts.size === 256) {
          tooMany = true;
          counts.clear();
        } else {
          counts.set(word, 1);
        }
      } else {
        counts.set(word, prev + 1);
      }
    }
  }
  let colours: Analysis['colours'] = null;
  if (!tooMany) {
    colours = [];
    for (const [word, count] of counts) {
      colours.push({
        word,
        r: (word / 0x1000000) | 0,
        g: ((word / 0x10000) | 0) & 0xff,
        b: ((word / 0x100) | 0) & 0xff,
        a: word & 0xff,
        count,
      });
    }
  }
  return { allOpaque, isGrey, colours };
}

// A transparent key exists when every non-opaque pixel is fully transparent
// and all of them share one colour, and no opaque pixel uses that colour.
// Two passes: the first finds the single transparent colour (rejecting any
// partial alpha or second colour), the second checks opaque pixels.
function findTransparentKey(rgba: Buffer): { r: number; g: number; b: number } | null {
  let kr = -1;
  let kg = -1;
  let kb = -1;
  let anyTransparent = false;
  for (let p = 0; p < NPIX; p++) {
    const d = p * 4;
    const a = rgba[d + 3];
    if (a === 0) {
      anyTransparent = true;
      const r = rgba[d];
      const g = rgba[d + 1];
      const b = rgba[d + 2];
      if (kr < 0) {
        kr = r;
        kg = g;
        kb = b;
      } else if (r !== kr || g !== kg || b !== kb) {
        return null;
      }
    } else if (a !== 255) {
      return null;
    }
  }
  if (!anyTransparent) return null;
  for (let p = 0; p < NPIX; p++) {
    const d = p * 4;
    if (rgba[d + 3] === 255 && rgba[d] === kr && rgba[d + 1] === kg && rgba[d + 2] === kb) {
      return null;
    }
  }
  return { r: kr, g: kg, b: kb };
}

interface Form {
  colourType: number;
  bpp: number;
  samples: Buffer;
  plte: Buffer | null;
  trns: Buffer | null;
  // The count-ordered palette form is screened with fixed-None only.
  paletteFirst: boolean;
}

// Palette entries are ordered with transparent entries first (smaller alpha
// first among them), then by the given order, then by colour word. Putting
// transparent entries first keeps the tRNS chunk as short as possible: it
// only needs to run up to the last non-opaque entry.
function paletteForm(
  rgba: Buffer,
  colours: NonNullable<Analysis['colours']>,
  byLuminance: boolean,
): Form {
  const entries = colours.slice();
  const lum = (c: { r: number; g: number; b: number }): number => 299 * c.r + 587 * c.g + 114 * c.b;
  entries.sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (x.a !== y.a) return x.a - y.a;
    const primary = byLuminance ? lum(x) - lum(y) : y.count - x.count;
    if (primary !== 0) return primary;
    return x.word - y.word;
  });
  const indexOf = new Map<number, number>();
  const plte = Buffer.alloc(entries.length * 3);
  const alphas: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    indexOf.set(entries[i].word, i);
    plte[i * 3] = entries[i].r;
    plte[i * 3 + 1] = entries[i].g;
    plte[i * 3 + 2] = entries[i].b;
    alphas.push(entries[i].a);
  }
  // Trim trailing opaque alphas from the tRNS chunk.
  let lastNonOpaque = -1;
  for (let i = 0; i < alphas.length; i++) if (alphas[i] !== 255) lastNonOpaque = i;
  const trns = lastNonOpaque < 0 ? null : Buffer.from(alphas.slice(0, lastNonOpaque + 1));
  const samples = Buffer.alloc(NPIX);
  for (let p = 0; p < NPIX; p++) {
    const d = p * 4;
    const word = rgba[d] * 0x1000000 + rgba[d + 1] * 0x10000 + rgba[d + 2] * 0x100 + rgba[d + 3];
    samples[p] = indexOf.get(word)!;
  }
  return { colourType: 3, bpp: 1, samples, plte, trns, paletteFirst: !byLuminance };
}

// One-channel forms: grey (type 0), grey+alpha (type 4), RGB (type 2),
// RGBA (type 6). The transparent-key form drops the alpha channel and
// records the key colour in tRNS instead.
function channelForm(
  rgba: Buffer,
  an: Analysis,
  key: { r: number; g: number; b: number } | null,
): Form {
  if (an.isGrey) {
    if (an.allOpaque || key) {
      const samples = Buffer.alloc(NPIX);
      for (let p = 0; p < NPIX; p++) samples[p] = rgba[p * 4];
      const trns = key ? (() => {
        const t = Buffer.alloc(2);
        t.writeUInt16BE(key.r, 0);
        return t;
      })() : null;
      return { colourType: 0, bpp: 1, samples, plte: null, trns, paletteFirst: false };
    }
    const samples = Buffer.alloc(NPIX * 2);
    for (let p = 0; p < NPIX; p++) {
      samples[p * 2] = rgba[p * 4];
      samples[p * 2 + 1] = rgba[p * 4 + 3];
    }
    return { colourType: 4, bpp: 2, samples, plte: null, trns: null, paletteFirst: false };
  }
  if (an.allOpaque || key) {
    const samples = Buffer.alloc(NPIX * 3);
    for (let p = 0; p < NPIX; p++) {
      samples[p * 3] = rgba[p * 4];
      samples[p * 3 + 1] = rgba[p * 4 + 1];
      samples[p * 3 + 2] = rgba[p * 4 + 2];
    }
    let trns: Buffer | null = null;
    if (key) {
      trns = Buffer.alloc(6);
      trns.writeUInt16BE(key.r, 0);
      trns.writeUInt16BE(key.g, 2);
      trns.writeUInt16BE(key.b, 4);
    }
    return { colourType: 2, bpp: 3, samples, plte: null, trns, paletteFirst: false };
  }
  const samples = Buffer.alloc(NPIX * 4);
  rgba.copy(samples);
  return { colourType: 6, bpp: 4, samples, plte: null, trns: null, paletteFirst: false };
}

// The candidate list: flat pictures (at most 256 colours) try the two
// palette orders; flat grey pictures also try the plain grey form, which
// can beat palette when its rows filter well. Rich grey pictures try one
// grey / grey+alpha form; rich colour pictures try one RGB / RGBA form.
function candidateForms(rgba: Buffer, an: Analysis): Form[] {
  if (an.colours) {
    const forms = [paletteForm(rgba, an.colours, false), paletteForm(rgba, an.colours, true)];
    if (an.isGrey) forms.push(channelForm(rgba, an, findTransparentKey(rgba)));
    return forms;
  }
  const key = findTransparentKey(rgba);
  return [channelForm(rgba, an, key)];
}

// ------------------------------------------------- Row filters, strategies --
// Filter one row of samples against the previous row. Filter numbers follow
// the PNG spec: 0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth.
function filterRow(row: Buffer, prev: Buffer, bpp: number, filter: number, out: Buffer): void {
  const n = row.length;
  if (filter === 0) {
    row.copy(out);
  } else if (filter === 1) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      out[i] = (row[i] - left) & 0xff;
    }
  } else if (filter === 2) {
    for (let i = 0; i < n; i++) out[i] = (row[i] - prev[i]) & 0xff;
  } else if (filter === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      out[i] = (row[i] - ((left + prev[i]) >> 1)) & 0xff;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      out[i] = (row[i] - paethPredictor(left, prev[i], upLeft)) & 0xff;
    }
  }
}

// Signed-sum cost of a filtered row: a byte costs its value below 128, or
// 256 minus its value at 128 and above. Bytes near zero from either side
// are the cheapest for DEFLATE to encode.
function signedSumCost(buf: Buffer): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Distinct-adjacent-pair count, with a 65536-entry stamp array so the
// table never needs clearing between rows.
const PAIR_STAMP = new Uint32Array(65536);
let pairStamp = 0;

function distinctPairsCost(buf: Buffer): number {
  pairStamp++;
  const stamp = pairStamp;
  let count = 0;
  for (let i = 0; i + 1 < buf.length; i++) {
    const pair = (buf[i] << 8) | buf[i + 1];
    if (PAIR_STAMP[pair] !== stamp) {
      PAIR_STAMP[pair] = stamp;
      count++;
    }
  }
  return count;
}

interface Screened {
  filtered: Buffer;
  total: number;
}

// Build the filtered stream for one form under one strategy, then screen it
// with zlib level 6 plus the cost of the extra chunks (12 bytes of framing
// plus the chunk data). Strategies: 'none' | 'sub' | 'up' | 'paeth' (one
// fixed filter for every row), 'minsum' (smallest signed-sum per row),
// 'minpairs' (fewest distinct adjacent pairs per row), 'brute' (smallest
// trial compression per row, zlib level 4 with memLevel 9 and the previous
// 32 KiB of filtered bytes as dictionary).
function screenForm(form: Form, strategy: string): Screened {
  const rowBytes = W * form.bpp;
  const filtered = Buffer.alloc(H * (rowBytes + 1));
  const trial = Buffer.alloc(rowBytes);
  const prev = Buffer.alloc(rowBytes);
  const zeroPrev = Buffer.alloc(rowBytes);
  const fixed = strategy === 'none' ? 0 : strategy === 'sub' ? 1 : strategy === 'up' ? 2 : strategy === 'paeth' ? 4 : -1;

  for (let y = 0; y < H; y++) {
    const row = form.samples.subarray(y * rowBytes, (y + 1) * rowBytes);
    const outAt = y * (rowBytes + 1);
    const out = filtered.subarray(outAt + 1, outAt + 1 + rowBytes);
    let chosen: number;
    if (fixed >= 0) {
      chosen = fixed;
      filterRow(row, y === 0 ? zeroPrev : prev, form.bpp, chosen, out);
    } else if (strategy === 'minsum' || strategy === 'minpairs') {
      let bestCost = Infinity;
      let bestFilter = 0;
      for (let f = 0; f < 5; f++) {
        filterRow(row, y === 0 ? zeroPrev : prev, form.bpp, f, trial);
        const cost = strategy === 'minsum' ? signedSumCost(trial) : distinctPairsCost(trial);
        if (cost < bestCost) {
          bestCost = cost;
          bestFilter = f;
        }
      }
      chosen = bestFilter;
      filterRow(row, y === 0 ? zeroPrev : prev, form.bpp, chosen, out);
    } else {
      // Brute force: trial-compress each filtered row.
      let bestSize = Infinity;
      let bestFilter = 0;
      const dictStart = Math.max(0, outAt - 32768);
      const dict = filtered.subarray(dictStart, outAt);
      for (let f = 0; f < 5; f++) {
        filterRow(row, y === 0 ? zeroPrev : prev, form.bpp, f, trial);
        const size = deflateSync(trial, { level: 4, memLevel: 9, dictionary: dict }).length;
        if (size < bestSize) {
          bestSize = size;
          bestFilter = f;
        }
      }
      chosen = bestFilter;
      filterRow(row, y === 0 ? zeroPrev : prev, form.bpp, chosen, out);
    }
    filtered[outAt] = chosen;
    row.copy(prev);
  }
  const z = deflateSync(filtered, { level: 6 }).length;
  let total = z;
  if (form.plte) total += 12 + form.plte.length;
  if (form.trns) total += 12 + form.trns.length;
  return { filtered, total };
}

// Try every form under its strategies, rank by screened total, and return
// the three best candidates. The count-ordered palette form is screened
// with fixed-None only: on the practice set it already wins unfiltered, and
// skipping the other six strategies there saves a large share of the time
// budget. The caller compresses each finalist for real and keeps the
// smallest finished PNG, because the level-6 screen can mis-rank streams
// whose level-9 sizes cross over.
// Iter 8: two-phase screening. Cheap strategies ('none', 'minpairs') rank
// the forms first; 'brute' runs only on the cheap-best form — on practice
// the cheap-best form IS the brute-best form 8/8 (probeI), and 'brute' on
// the other forms never produced a finalist. Dropped outright: 'sub',
// 'up', 'paeth' (never fi=0) and 'minsum' (never top-3). Saves ~4.4s.
function pickFinalists(forms: Form[]): { form: Form; filtered: Buffer; total: number }[] {
  const all: { form: Form; filtered: Buffer; total: number; strat: string }[] = [];
  for (const form of forms) {
    const strategies = form.paletteFirst ? ['none'] : ['none', 'minpairs'];
    for (const s of strategies) {
      const screened = screenForm(form, s);
      all.push({ form, filtered: screened.filtered, total: screened.total, strat: s });
    }
  }
  let bestForm: Form | null = null;
  let bestTotal = Infinity;
  for (const c of all) {
    if (!c.form.paletteFirst && c.total < bestTotal) {
      bestTotal = c.total;
      bestForm = c.form;
    }
  }
  // FIX-1938: brute screening only when the cheap-best total is large.
  // On practice brute changes fi=0 only on i003/i004 (both >100K screened);
  // the other six streams are byte-identical without it (nobrute test:
  // -4.2s for +904B i003 / +3583B i004 only). Gate at 70000 sits between
  // the largest unaffected stream (~58K) and the smallest affected (~106K).
  if (bestForm && bestTotal > 70000) {
    const screened = screenForm(bestForm, 'brute');
    all.push({ form: bestForm, filtered: screened.filtered, total: screened.total, strat: 'brute' });
  }
  all.sort((x, y) => x.total - y.total);
  const top = all.slice(0, 3);
  // Always give the count-ordered palette form (fixed-None) a real final
  // comparison: it can win at level 9 even when adaptive orders screen
  // better at level 6.
  const first = all.find((c) => c.form.paletteFirst);
  if (first && !top.includes(first)) top.push(first);
  return top.map(({ form, filtered, total }) => ({ form, filtered, total }));
}

// --------------------------------------------- Hand-written DEFLATE encoder --
// A lazy-matching parser in the manner of zopfli: pass one parses with
// fixed-Huffman costs and short chains, pass two re-parses with the
// Huffman lengths built from pass one's frequencies and long chains.
// The optimal-parse passes (see parseOptimal) then re-parse by dynamic
// programming over bit costs. Each parse is encoded under several
// block-split schemes, fixed and dynamic blocks, and the shortest is
// kept. Anything that fails here falls back to zlib: the caller always
// compares against zlib level 9 and keeps the smallest.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const FIXED_LIT_LEN: Uint8Array = (() => {
  const a = new Uint8Array(288);
  for (let i = 0; i < 144; i++) a[i] = 8;
  for (let i = 144; i < 256; i++) a[i] = 9;
  for (let i = 256; i < 280; i++) a[i] = 7;
  for (let i = 280; i < 288; i++) a[i] = 8;
  return a;
})();
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);

function lenCodeOf(len: number): number {
  for (let c = 28; c >= 0; c--) if (len >= LEN_BASE[c]) return c;
  return 0;
}
function distCodeOf(dist: number): number {
  for (let c = 29; c >= 0; c--) if (dist >= DIST_BASE[c]) return c;
  return 0;
}

// Build Huffman code lengths from frequencies, capped at maxBits, with the
// overflow rebalancing zlib uses. Ties break by symbol number so the result
// is deterministic. A single symbol gets length 1.
function buildLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  let symbols = 0;
  let only = -1;
  for (let i = 0; i < n; i++) {
    if (freq[i] > 0) {
      symbols++;
      only = i;
    }
  }
  if (symbols === 0) return lengths;
  if (symbols === 1) {
    lengths[only] = 1;
    return lengths;
  }
  // Heap of tree nodes ordered by (frequency, creation order). Leaves are
  // the symbols; internal nodes are created in merge order.
  const nodeFreq: number[] = [];
  const nodeOrder: number[] = [];
  const nodeLeft: number[] = [];
  const nodeRight: number[] = [];
  const nodeSym: number[] = [];
  const parent: number[] = [];
  const leafNode = new Int32Array(n).fill(-1);
  let created = 0;
  const heap: number[] = [];
  const less = (a: number, b: number): boolean =>
    nodeFreq[a] !== nodeFreq[b] ? nodeFreq[a] < nodeFreq[b] : nodeOrder[a] < nodeOrder[b];
  const heapPush = (v: number): void => {
    heap.push(v);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        const t = heap[i];
        heap[i] = heap[m];
        heap[m] = t;
        i = m;
      }
    }
    return top;
  };
  for (let s = 0; s < n; s++) {
    if (freq[s] === 0) continue;
    nodeFreq.push(freq[s]);
    nodeOrder.push(created);
    nodeLeft.push(-1);
    nodeRight.push(-1);
    nodeSym.push(s);
    parent.push(-1);
    leafNode[s] = created;
    heapPush(created);
    created++;
  }
  while (heap.length > 1) {
    const a = heapPop();
    const b = heapPop();
    nodeFreq.push(nodeFreq[a] + nodeFreq[b]);
    nodeOrder.push(created);
    nodeLeft.push(a);
    nodeRight.push(b);
    nodeSym.push(-1);
    parent.push(-1);
    parent[a] = created;
    parent[b] = created;
    heapPush(created);
    created++;
  }
  const root = heap[0];
  // Depth of each leaf, walking up through parents.
  const depth = new Int32Array(created);
  const blCount = new Int32Array(maxBits + 1);
  let overflow = 0;
  for (let s = 0; s < n; s++) {
    if (freq[s] === 0) continue;
    let d = 0;
    let cur = leafNode[s];
    while (cur !== root) {
      cur = parent[cur];
      d++;
    }
    depth[s] = d;
    if (d > maxBits) {
      overflow++;
      d = maxBits;
    }
    blCount[d]++;
  }
  // Rebalance the overflow the way zlib does, but iterate until the exact
  // Kraft sum reaches 1: the classic overflow/2 iteration count only
  // suffices when every overflowed depth is exactly maxBits+1. With deeper
  // trees (large blocks, many rare symbols) it under-corrects and leaves
  // an oversubscribed (INVALID) code — exposed by greedy-merged blocks.
  // Each step removes one maxBits code, i.e. one unit of 2^-maxBits.
  let kraft = 0;
  for (let b = 1; b <= maxBits; b++) kraft += blCount[b] * (1 << (maxBits - b));
  while (kraft > 1 << maxBits) {
    let bits = maxBits - 1;
    while (bits > 0 && blCount[bits] === 0) bits--;
    if (bits === 0 || blCount[maxBits] === 0) break;
    blCount[bits]--;
    blCount[bits + 1] += 2;
    blCount[maxBits]--;
    kraft -= 1;
  }
  void overflow;
  // Hand the lengths to symbols in decreasing frequency order.
  const order = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) order.push(s);
  order.sort((a, b) => (freq[b] !== freq[a] ? freq[b] - freq[a] : a - b));
  let at = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    for (let k = 0; k < blCount[bits]; k++) lengths[order[at++]] = bits;
  }
  return lengths;
}

// Canonical DEFLATE codes from lengths, with bits reversed for writing.
function canonicalCodes(lengths: Uint8Array): { code: Uint32Array; len: Uint8Array } {
  const n = lengths.length;
  const code = new Uint32Array(n);
  const blCount = new Int32Array(16);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const next = new Int32Array(16);
  let running = 0;
  for (let bits = 1; bits < 16; bits++) {
    running = (running + blCount[bits - 1]) << 1;
    next[bits] = running;
  }
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l === 0) continue;
    let c = next[l]++;
    let rev = 0;
    for (let k = 0; k < l; k++) {
      rev = (rev << 1) | (c & 1);
      c >>= 1;
    }
    code[i] = rev;
  }
  return { code, len: lengths };
}

// A bit writer that accumulates bits low-first, as DEFLATE writes them.
class BitWriter {
  bytes: number[] = [];
  buf = 0;
  cnt = 0;
  write(value: number, count: number): void {
    this.buf |= (value & ((1 << count) - 1)) << this.cnt;
    this.cnt += count;
    while (this.cnt >= 8) {
      this.bytes.push(this.buf & 0xff);
      this.buf >>>= 8;
      this.cnt -= 8;
    }
  }
  // Append another writer's bits to this one (blocks are bit-packed, not
  // byte-aligned, so a block encoded on the side is spliced in bit by bit).
  append(other: BitWriter): void {
    for (const byte of other.bytes) this.write(byte, 8);
    if (other.cnt > 0) this.write(other.buf, other.cnt);
  }
  finish(): Buffer {
    if (this.cnt > 0) this.bytes.push(this.buf & 0xff);
    this.buf = 0;
    this.cnt = 0;
    return Buffer.from(this.bytes);
  }
}

interface Tokens {
  // 0 = literal (value in a), 1 = match (length in a, distance in b).
  kind: Uint8Array;
  a: Int32Array;
  b: Int32Array;
  count: number;
  litFreq: Uint32Array;
  distFreq: Uint32Array;
}

// Three-byte hash: ((b0 * 131 + b1) * 131 + b2), low 16 bits.
function hash3(data: Uint8Array, pos: number): number {
  return (((data[pos] * 131 + data[pos + 1]) * 131 + data[pos + 2]) & 0xffff) >>> 0;
}

// Iter 9: four-byte hash into 2^17 buckets. Chains hold only positions
// sharing the first four bytes, so they are far shorter than hash3 chains
// on repetitive screenshot data; a position sharing only three bytes can
// only give a length-3 match, and those are recovered by the hash3 walk
// whenever no length-4 match exists.
function hash4(data: Uint8Array, pos: number): number {
  return ((((data[pos] * 131 + data[pos + 1]) * 131 + data[pos + 2]) * 131 + data[pos + 3]) & 0x1ffff) >>> 0;
}

interface Match {
  len: number;
  dist: number;
}

class Matcher {
  head: Int32Array;
  prev: Int32Array;
  // Iter 9: parallel four-byte chains (see hash4).
  head4: Int32Array;
  prev4: Int32Array;
  data: Uint8Array;
  inserted = 0;
  constructor(data: Uint8Array) {
    this.data = data;
    this.head = new Int32Array(65536).fill(-1);
    this.prev = new Int32Array(data.length).fill(-1);
    this.head4 = new Int32Array(131072).fill(-1);
    this.prev4 = new Int32Array(data.length).fill(-1);
  }
  reset(): void {
    this.head.fill(-1);
    this.head4.fill(-1);
    this.inserted = 0;
  }
  // Insert every position below pos into the chains, so the head of a
  // bucket is always the newest candidate strictly before pos.
  insertUpTo(pos: number): void {
    const data = this.data;
    const end = Math.min(pos, data.length - 2);
    for (let i = this.inserted; i < end; i++) {
      const h = hash3(data, i);
      this.prev[i] = this.head[h];
      this.head[h] = i;
      if (i + 3 < data.length) {
        const h4 = hash4(data, i);
        this.prev4[i] = this.head4[h4];
        this.head4[h4] = i;
      }
    }
    if (pos > this.inserted) this.inserted = pos;
  }
  best(pos: number, maxChain: number): Match | null {
    const data = this.data;
    const n = data.length;
    if (pos + 3 > n) return null;
    this.insertUpTo(pos);
    let cand = this.head[hash3(data, pos)];
    let bestLen = 2;
    let bestDist = 0;
    let chain = 0;
    const maxLen = Math.min(258, n - pos);
    while (cand >= 0 && chain < maxChain) {
      const dist = pos - cand;
      if (dist > 32768) break;
      chain++;
      // Quick reject: the byte at the current best length must match.
      if (data[cand + bestLen] === data[pos + bestLen]) {
        let len = 0;
        while (len < maxLen && data[cand + len] === data[pos + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = dist;
          if (len === 258) break;
        }
      }
      cand = this.prev[cand];
    }
    return bestLen >= 3 ? { len: bestLen, dist: bestDist } : null;
  }

  // Longest match plus, for each length, the smallest distance of a match
  // reaching at least that length. Candidates are walked newest-first
  // (smallest distance first), so the first candidate to reach a length
  // is the cheapest distance for it; when a candidate extends the best
  // length, the newly reached lengths are recorded at its distance.
  // Fills sublen[3..len]; returns null when no match of length >= 3.
  // EXP-5: also records in this.pareto[0..paretoCount) the successive
  // bestLen values (the largest length for each distinct distance) so the
  // DP can iterate breakpoints instead of scanning all 256 lengths.
  pareto = new Int32Array(259);
  paretoCount = 0;
  // Iter 9: walk one candidate chain, filling sublen/pareto with the
  // longest match plus, for each length, the smallest distance of a match
  // reaching at least that length. Candidates are walked newest-first
  // (smallest distance first), so the first candidate to reach a length
  // is the cheapest distance for it. Two bounded shortcuts, both OFF by
  // default (caps 0): stagCap breaks after that many consecutive
  // non-improving candidates; earlyCap breaks once the best length
  // reaches the threshold. parseOptimal enables them only for the
  // all-candidates pass (see there): the seed/plus-8 optimal passes must
  // reproduce the lazy seed's deep-chain matches — capping them collapses
  // the DP to literals (measured: optimal stream 49.9K -> 245K).
  walkChain(cand: number, pos: number, maxChain: number, sublen: Int32Array, prevArr: Int32Array, stagCap = 0, earlyCap = 0): [number, number] {
    const data = this.data;
    const n = data.length;
    let bestLen = 2;
    let bestDist = 0;
    let chain = 0;
    let since = 0;
    const maxLen = Math.min(258, n - pos);
    while (cand >= 0 && chain < maxChain) {
      const dist = pos - cand;
      if (dist > 32768) break;
      chain++;
      let improved = false;
      // Quick reject: the byte at the current best length must match.
      if (data[cand + bestLen] === data[pos + bestLen]) {
        let len = 0;
        while (len < maxLen && data[cand + len] === data[pos + len]) len++;
        if (len > bestLen) {
          for (let l = bestLen + 1; l <= len; l++) sublen[l] = dist;
          bestLen = len;
          bestDist = dist;
          this.pareto[this.paretoCount++] = len;
          improved = true;
          if (len === 258) break;
          if (earlyCap > 0 && bestLen >= earlyCap) break;
        }
      }
      if (improved) since = 0;
      else if (stagCap > 0 && ++since >= stagCap) break;
      cand = prevArr[cand];
    }
    return [bestLen, bestDist];
  }
  bestSublen(pos: number, maxChain: number, sublen: Int32Array, stagCap = 0, earlyCap = 0): Match | null {
    const data = this.data;
    const n = data.length;
    if (pos + 3 > n) return null;
    this.insertUpTo(pos);
    this.paretoCount = 0;
    // Four-byte chain first: every candidate there shares four bytes, so
    // any improvement is a length-4 (or longer) match. When one is found
    // the three-byte walk is skipped — a position sharing only three bytes
    // can only give a length-3 match, and the DP's length-3 edge is
    // already served by the four-byte candidate's distance (sublen[3]
    // is filled by the improvement loop below). When no length-4 match
    // exists, fall through to the three-byte chain for length-3 matches.
    if (pos + 3 < n) {
      const [l4, d4] = this.walkChain(this.head4[hash4(data, pos)], pos, maxChain, sublen, this.prev4, stagCap, earlyCap);
      if (l4 >= 4) return { len: l4, dist: d4 };
    }
    const [bestLen, bestDist] = this.walkChain(this.head[hash3(data, pos)], pos, maxChain, sublen, this.prev, stagCap, earlyCap);
    return bestLen >= 3 ? { len: bestLen, dist: bestDist } : null;
  }
}

// Bit cost of a match of length len at distance dist under the given
// Huffman lengths: the length symbol's code, its extra bits, the distance
// symbol's code and its extra bits. EXP-5: code lookups are precomputed
// tables (lenCodeOf/distCodeOf scan up to 29/30 entries per call, which
// dominated the DP inner loop at every-position candidate mode).
const LEN_CODE_TABLE: Uint8Array = (() => {
  const t = new Uint8Array(259);
  for (let l = 3; l <= 258; l++) t[l] = lenCodeOf(l);
  return t;
})();
const DIST_CODE_TABLE: Uint8Array = (() => {
  const t = new Uint8Array(32769);
  for (let d = 1; d <= 32768; d++) t[d] = distCodeOf(d);
  return t;
})();
function matchCost(len: number, dist: number, litLen: Uint8Array, distLen: Uint8Array): number {
  const lc = LEN_CODE_TABLE[len];
  const dc = DIST_CODE_TABLE[dist];
  return litLen[257 + lc] + LEN_EXTRA[lc] + distLen[dc] + DIST_EXTRA[dc];
}

// Lazy matching parse: at each position, defer a match when the next
// position's match is better than this one. With useCost false the rule
// compares lengths (zlib's rule: a longer match next door is worth one
// literal now). With useCost true it compares bit costs under the given
// Huffman lengths: one literal now plus the next match against this
// match now. The cost rule is what skips short matches at far distances
// (a 3-byte match at distance 10000 costs ~21 bits, its bytes as literals
// ~1 bit each), but it needs accurate lengths to work: the first pass
// always uses the length rule, and later passes use the cost rule with
// the lengths re-estimated from the previous parse, iterating toward
// the true costs the way zopfli's repeated optimal parsing does.
function parseData(
  data: Uint8Array,
  matcher: Matcher,
  litLen: Uint8Array,
  distLen: Uint8Array,
  maxChain: number,
  useCost = false,
): Tokens {
  const n = data.length;
  const kind: number[] = [];
  const a: number[] = [];
  const b: number[] = [];
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  matcher.reset();
  let pos = 0;
  while (pos < n) {
    const m = matcher.best(pos, maxChain);
    if (!m) {
      kind.push(0);
      a.push(data[pos]);
      b.push(0);
      litFreq[data[pos]]++;
      pos++;
      continue;
    }
    const next = m.len < 258 && pos + 1 < n ? matcher.best(pos + 1, maxChain) : null;
    const defer =
      next &&
      (useCost
        ? litLen[data[pos]] + matchCost(next.len, next.dist, litLen, distLen) <
          matchCost(m.len, m.dist, litLen, distLen)
        : next.len > m.len);
    if (defer) {
      kind.push(0);
      a.push(data[pos]);
      b.push(0);
      litFreq[data[pos]]++;
      pos++;
      continue;
    }
    kind.push(1);
    a.push(m.len);
    b.push(m.dist);
    litFreq[257 + lenCodeOf(m.len)]++;
    distFreq[distCodeOf(m.dist)]++;
    pos += m.len;
  }
  litFreq[256]++;
  return {
    kind: Uint8Array.from(kind),
    a: Int32Array.from(a),
    b: Int32Array.from(b),
    count: kind.length,
    litFreq,
    distFreq,
  };
}

// Optimal parsing (shortest path) restricted to candidate match starts:
// a lazy parse is cheap but chooses matches greedily, so it takes short
// matches at far distances whose distance code costs more than the
// literals they replace, and it can miss a better match one byte later.
// This parse fixes both by dynamic programming over bit costs: every
// position may emit a literal, and positions where the seed parse found
// a token (plus the next two positions, for one- and two-byte deferrals)
// may start a match, with the match's cost taken from the given Huffman
// lengths and its distance from the cheapest distance for that length.
// Trying every length would cost O(n * 258); instead only the two ends
// of each length-code bucket are tried, because inside one bucket every
// length costs the same bits (the largest reaches furthest at that cost,
// the smallest may sit at a much nearer distance).
// The result is the cheapest token stream under the given costs, which
// is what a full optimal parse (zopfli's LZ77Optimal) computes, at a
// fraction of its price: match search runs only at candidate positions.
function parseOptimal(
  data: Uint8Array,
  matcher: Matcher,
  litLen: Uint8Array,
  distLen: Uint8Array,
  maxChain: number,
  seed: Tokens,
  candOverride?: string,
): Tokens {

  const n = data.length;
  // EXP-5: candidate match starts, mode from PNGSQ_CAND:
  //  seed2 = seed token boundaries +1/+2 (baseline);
  //  plusK = seed2 plus K positions after each long (>=16) match token;
  //  all   = every position is a candidate.
  //  strideS = seed2 plus every S-th position (FIX-1938: cheap stand-in
  //  for 'all' — DP restarts land within S-1 bytes of the optimum).
  const candMode = candOverride ?? 'seed2';
  const cand = new Uint8Array(n + 1);
  if (candMode === 'all') {
    cand.fill(1);
  } else {
    let covered = 0;
    const extra = candMode.startsWith('plus') ? Number(candMode.slice(4)) || 0 : 0;
    for (let i = 0; i < seed.count; i++) {
      cand[covered] = 1;
      if (covered + 1 <= n) cand[covered + 1] = 1;
      if (covered + 2 <= n) cand[covered + 2] = 1;
      if (extra > 0 && seed.kind[i] === 1 && seed.a[i] >= 16) {
        for (let k = 3; k <= extra && covered + k <= n; k++) cand[covered + k] = 1;
      }
      covered += seed.kind[i] === 0 ? 1 : seed.a[i];
    }
    if (candMode.startsWith('stride')) {
      const s = Number(candMode.slice(6)) || 16;
      for (let i = 0; i <= n; i += s) cand[i] = 1;
    }
  }
  const costs = new Float64Array(n + 1).fill(Infinity);
  const choice = new Int32Array(n + 1); // 0 = literal, else match length
  const choiceDist = new Int32Array(n + 1);
  costs[0] = 0;
  // Iter 9: chain-walk shortcuts apply ONLY to the all-candidates pass.
  // There every position is a candidate, so a match missed at one
  // position is usually found one byte later; the seed/plus-8 passes run
  // uncapped (their deep-chain matches are the lazy seed's tokens — see
  // walkChain). Stagnation cap 32 measured: all-pass ~2x faster for
  // -0.52 total-score points on practice (see NOTES iter 9).
  // Iter 10: stagnation cap 32 -> 20 (the all-pass was ~10s of the
  // iter-9 local run; a tighter cap trades a few hundred bytes for
  // the wall time the slower grader needs).
  const stagCap = candMode === 'all' ? 20 : 0;
  const earlyCap = 0;
  // Iter 9: precomputed per-length / per-distance bit costs, inlining
  // matchCost (its table lookups plus a call per DP edge) out of the
  // inner loop.
  const lcBits = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const lc = LEN_CODE_TABLE[l];
    lcBits[l] = litLen[257 + lc] + LEN_EXTRA[lc];
  }
  const dcBits = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const dc = DIST_CODE_TABLE[d];
    dcBits[d] = distLen[dc] + DIST_EXTRA[dc];
  }
  const sublen = new Int32Array(259);
  matcher.reset();
  for (let i = 0; i < n; i++) {
    const ci = costs[i];
    if (ci === Infinity) continue;
    // Literal edge: always available.
    const lc = ci + litLen[data[i]];
    if (lc < costs[i + 1]) {
      costs[i + 1] = lc;
      choice[i + 1] = 0;
    }
    if (!cand[i] || i + 3 > n) continue;
    const m = matcher.bestSublen(i, maxChain, sublen, stagCap, earlyCap);
    if (!m) continue;
    // Pareto lengths: for each distinct distance the largest length
    // reaching it, plus each length-code bucket's two ends. Inside one
    // bucket every length costs the same length bits, so a longer length
    // at the same distance is free coverage; but a shorter length may
    // sit at a much nearer distance (a cheaper distance code), and the
    // landing position matters, so all of these are tried. sublen is
    // non-decreasing in length, so scanning from the longest down, a
    // length is the largest for its distance exactly when its distance
    // has not been seen yet at any longer length.
    for (let k = 0; k < matcher.paretoCount; k++) {
      const l = matcher.pareto[k];
      const d = sublen[l];
      const c = ci + lcBits[l] + dcBits[d];
      if (c < costs[i + l]) {
        costs[i + l] = c;
        choice[i + l] = l;
        choiceDist[i + l] = d;
      }
    }
    for (let b = 0; b < 29; b++) {
      const base = LEN_BASE[b];
      if (base > m.len) break;
      const hi = b + 1 < 29 ? LEN_BASE[b + 1] - 1 : 258;
      const lenHi = Math.min(m.len, hi);
      const dHi = sublen[lenHi];
      const cHi = ci + lcBits[lenHi] + dcBits[dHi];
      if (cHi < costs[i + lenHi]) {
        costs[i + lenHi] = cHi;
        choice[i + lenHi] = lenHi;
        choiceDist[i + lenHi] = dHi;
      }
      if (base >= 3 && base !== lenHi) {
        const dLo = sublen[base];
        const cLo = ci + lcBits[base] + dcBits[dLo];
        if (cLo < costs[i + base]) {
          costs[i + base] = cLo;
          choice[i + base] = base;
          choiceDist[i + base] = dLo;
        }
      }
    }
  }
  // Backtrack from the end, rebuilding the token stream.
  const kind: number[] = [];
  const a: number[] = [];
  const b: number[] = [];
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  let i = n;
  while (i > 0) {
    const len = choice[i];
    if (len === 0) {
      kind.push(0);
      a.push(data[i - 1]);
      b.push(0);
      litFreq[data[i - 1]]++;
      i--;
    } else {
      kind.push(1);
      a.push(len);
      b.push(choiceDist[i]);
      litFreq[257 + lenCodeOf(len)]++;
      distFreq[distCodeOf(choiceDist[i])]++;
      i -= len;
    }
  }
  kind.reverse();
  a.reverse();
  b.reverse();
  litFreq[256]++;
  return {
    kind: Uint8Array.from(kind),
    a: Int32Array.from(a),
    b: Int32Array.from(b),
    count: kind.length,
    litFreq,
    distFreq,
  };
}

// Encode tokens [start, end) as one fixed-Huffman block into w.
function encodeFixedInto(w: BitWriter, tokens: Tokens, start: number, end: number, last: boolean): void {
  w.write(last ? 1 : 0, 1);
  w.write(1, 2);
  const lit = canonicalCodes(FIXED_LIT_LEN);
  const dist = canonicalCodes(FIXED_DIST_LEN);
  for (let i = start; i < end; i++) {
    if (tokens.kind[i] === 0) {
      const v = tokens.a[i];
      w.write(lit.code[v], lit.len[v]);
    } else {
      const len = tokens.a[i];
      const d = tokens.b[i];
      const lc = lenCodeOf(len);
      const dc = distCodeOf(d);
      w.write(lit.code[257 + lc], lit.len[257 + lc]);
      if (LEN_EXTRA[lc] > 0) w.write(len - LEN_BASE[lc], LEN_EXTRA[lc]);
      w.write(dist.code[dc], dist.len[dc]);
      if (DIST_EXTRA[dc] > 0) w.write(d - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  w.write(lit.code[256], lit.len[256]);
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Encode tokens [start, end) as one dynamic-Huffman block into w.
// Returns false when the block cannot be planned (for example too many
// literal codes); the caller then uses the fixed block instead.
function encodeDynamicInto(w: BitWriter, tokens: Tokens, start: number, end: number, last: boolean): boolean {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (let i = start; i < end; i++) {
    if (tokens.kind[i] === 0) litFreq[tokens.a[i]]++;
    else {
      litFreq[257 + lenCodeOf(tokens.a[i])]++;
      distFreq[distCodeOf(tokens.b[i])]++;
    }
  }
  litFreq[256]++;
  const litLen = buildLengths(litFreq, 15);
  const distLen = buildLengths(distFreq, 15);
  let litCount = 257;
  for (let i = 287; i >= 257; i--) if (litLen[i] > 0) { litCount = i + 1; break; }
  let distCount = 1;
  for (let i = 29; i >= 0; i--) if (distLen[i] > 0) { distCount = i + 1; break; }
  if (litCount > 286) return false;
  if (distFreq.every((v) => v === 0)) {
    distLen[0] = 1;
    distCount = 1;
  }
  // Run-length encode the combined code lengths.
  const combined: number[] = [];
  for (let i = 0; i < litCount; i++) combined.push(litLen[i]);
  for (let i = 0; i < distCount; i++) combined.push(distLen[i]);
  const rleSym: number[] = [];
  const rleExtra: number[] = [];
  const rleExtraBits: number[] = [];
  let i = 0;
  while (i < combined.length) {
    const v = combined[i];
    let run = 1;
    while (i + run < combined.length && combined[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(138, left);
        rleSym.push(18);
        rleExtra.push(take - 11);
        rleExtraBits.push(7);
        left -= take;
      }
      if (left >= 3) {
        rleSym.push(17);
        rleExtra.push(left - 3);
        rleExtraBits.push(3);
        left = 0;
      }
      while (left > 0) {
        rleSym.push(0);
        rleExtra.push(0);
        rleExtraBits.push(0);
        left--;
      }
    } else {
      rleSym.push(v);
      rleExtra.push(0);
      rleExtraBits.push(0);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(6, left);
        rleSym.push(16);
        rleExtra.push(take - 3);
        rleExtraBits.push(2);
        left -= take;
      }
      while (left > 0) {
        rleSym.push(v);
        rleExtra.push(0);
        rleExtraBits.push(0);
        left--;
      }
    }
    i += run;
  }
  const clFreq = new Uint32Array(19);
  for (const s of rleSym) clFreq[s]++;
  const clLen = buildLengths(clFreq, 7);
  let hclen = 4;
  for (let k = CL_ORDER.length - 1; k >= 0; k--) {
    if (clLen[CL_ORDER[k]] > 0) {
      hclen = Math.max(4, k + 1);
      break;
    }
  }
  const lit = canonicalCodes(litLen);
  const dist = canonicalCodes(distLen);
  const cl = canonicalCodes(clLen);
  w.write(last ? 1 : 0, 1);
  w.write(2, 2);
  w.write(litCount - 257, 5);
  w.write(distCount - 1, 5);
  w.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.write(clLen[CL_ORDER[k]], 3);
  for (let k = 0; k < rleSym.length; k++) {
    w.write(cl.code[rleSym[k]], cl.len[rleSym[k]]);
    if (rleExtraBits[k] > 0) w.write(rleExtra[k], rleExtraBits[k]);
  }
  for (let t = start; t < end; t++) {
    if (tokens.kind[t] === 0) {
      const v = tokens.a[t];
      w.write(lit.code[v], lit.len[v]);
    } else {
      const len = tokens.a[t];
      const d = tokens.b[t];
      const lc = lenCodeOf(len);
      const dc = distCodeOf(d);
      w.write(lit.code[257 + lc], lit.len[257 + lc]);
      if (LEN_EXTRA[lc] > 0) w.write(len - LEN_BASE[lc], LEN_EXTRA[lc]);
      w.write(dist.code[dc], dist.len[dc]);
      if (DIST_EXTRA[dc] > 0) w.write(d - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  w.write(lit.code[256], lit.len[256]);
  return true;
}

// Bit length of a writer's content so far (complete bytes plus the
// partial byte still in the buffer).
function bitLength(w: BitWriter): number {
  return w.bytes.length * 8 + w.cnt;
}

// Encode one token range as DEFLATE blocks: each cut range becomes one
// block, written with fixed Huffman codes or dynamic Huffman codes,
// whichever is shorter for that block. Returns the raw DEFLATE bytes.
function encodeTokens(tokens: Tokens, cuts: [number, number][]): Buffer {
  const multi = new BitWriter();
  for (let b = 0; b < cuts.length; b++) {
    const [s, e] = cuts[b];
    const last = b === cuts.length - 1;
    const f = new BitWriter();
    encodeFixedInto(f, tokens, s, e, last);
    const d = new BitWriter();
    const ok = encodeDynamicInto(d, tokens, s, e, last);
    multi.append(ok && bitLength(d) < bitLength(f) ? d : f);
  }
  return multi.finish();
}

// Cut a token stream into blocks at the given byte boundaries: a cut falls
// just after the token that first reaches or passes the boundary byte.
function cutsAtBytes(tokens: Tokens, boundaries: number[]): [number, number][] {
  const cuts: [number, number][] = [];
  let start = 0;
  let covered = 0;
  let bi = 0;
  for (let i = 0; i < tokens.count; i++) {
    covered += tokens.kind[i] === 0 ? 1 : tokens.a[i];
    while (bi < boundaries.length && covered >= boundaries[bi]) {
      cuts.push([start, i + 1]);
      start = i + 1;
      bi++;
    }
  }
  cuts.push([start, tokens.count]);
  return cuts;
}

// Candidate block-split schemes for a token stream over `data` bytes:
// the historical single cut at 256 KiB, row-aligned splits (the filtered
// stream is 720 rows long, so content regions change at row boundaries),
// and equal token-count splits. Each scheme is encoded in full and the
// shortest raw stream wins; a scheme's per-block Huffman tables adapt to
// the data inside the block, which is where a single-table encoder loses
// on a stream whose regions differ (title bar, text, photo patch).
function splitSchemes(tokens: Tokens, data: Buffer): [number, number][][] {
  const schemes: [number, number][][] = [];
  // Historical behaviour: one block per 256 KiB of covered bytes.
  const base: [number, number][] = [];
  let start = 0;
  let covered = 0;
  for (let i = 0; i < tokens.count; i++) {
    covered += tokens.kind[i] === 0 ? 1 : tokens.a[i];
    if (covered >= 262144 && i + 1 < tokens.count) {
      base.push([start, i + 1]);
      start = i + 1;
      covered = 0;
    }
  }
  base.push([start, tokens.count]);
  schemes.push(base);
  // Row-aligned splits: K blocks split at row boundaries.
  const rowLen = data.length / 720;
  for (const k of [6, 8]) {
    const boundaries: number[] = [];
    for (let r = 1; r < k; r++) boundaries.push(Math.round((r * 720) / k) * rowLen);
    schemes.push(cutsAtBytes(tokens, boundaries));
  }
  // Equal token-count splits.
  for (const k of [4]) {
    const cuts: [number, number][] = [];
    for (let r = 0; r < k; r++) {
      const s = Math.floor((r * tokens.count) / k);
      const e = r + 1 === k ? tokens.count : Math.floor(((r + 1) * tokens.count) / k);
      cuts.push([s, e]);
    }
    schemes.push(cuts);
  }
  return schemes;
}

// Iter 6: big streams (screened total > 40000) get an extra all-candidates
// optimal pass (chain 256); small streams get plus-8 candidates on the last
// optimal pass. Block splits are greedy-merged from the base / row-8 schemes.
// The full custom DEFLATE: lazy-matching passes that re-estimate the
// Huffman costs from each pass's frequencies, then the last parse encoded
// under the best of four block-split schemes, wrapped as a zlib stream. Splitting
// lets each block carry Huffman tables fitted to its own data, which is
// where a single-table encoder loses to zlib on large streams.
// Bit cost of encoding tokens[start,end) as ONE block (min fixed/dynamic).
function blockCostBits(tokens: Tokens, start: number, end: number, last: boolean): number {
  const f = new BitWriter();
  encodeFixedInto(f, tokens, start, end, last);
  const d = new BitWriter();
  const ok = encodeDynamicInto(d, tokens, start, end, last);
  return Math.min(bitLength(f), ok ? bitLength(d) : Infinity);
}

// Greedy block-split improvement: starting from `cuts`, repeatedly merge
// the adjacent pair whose merge most reduces total encoded bits, until no
// merge helps. Merging can only help or leave the cost unchanged, so the
// result never loses to its starting scheme.
function greedyMergeCuts(tokens: Tokens, startCuts: [number, number][]): [number, number][] {
  // Cache block costs: each round re-evaluated every adjacent pair from
  // scratch (~2-3x the merge time). A merged block's cost is exactly the
  // pair cost computed in an earlier round, so cache by (start, end, last).
  const cache = new Map<string, number>();
  const cost = (s: number, e: number, last: boolean): number => {
    const k = s + ',' + e + ',' + (last ? 1 : 0);
    let v = cache.get(k);
    if (v === undefined) {
      v = blockCostBits(tokens, s, e, last);
      cache.set(k, v);
    }
    return v;
  };
  let cuts: [number, number][] = startCuts.map((c) => [c[0], c[1]] as [number, number]);
  const totalBits = (cs: [number, number][]): number => {
    let bits = 0;
    for (let b = 0; b < cs.length; b++) bits += cost(cs[b][0], cs[b][1], b === cs.length - 1);
    return bits;
  };
  let bits = totalBits(cuts);
  while (cuts.length > 1) {
    let bestGain = 0;
    let bestIdx = -1;
    for (let i = 0; i < cuts.length - 1; i++) {
      const m = cost(cuts[i][0], cuts[i + 1][1], i + 1 === cuts.length - 1);
      const cur = cost(cuts[i][0], cuts[i][1], false) + cost(cuts[i + 1][0], cuts[i + 1][1], i + 1 === cuts.length - 1);
      if (cur - m > bestGain) {
        bestGain = cur - m;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    cuts.splice(bestIdx, 2, [cuts[bestIdx][0], cuts[bestIdx + 1][1]] as [number, number]);
    bits -= bestGain;
  }
  return cuts;
}

// Encode one token set under the two fixed schemes (256 KiB blocks,
// row-8 splits). The row-6 / token-4 schemes are dropped: greedy merge
// from {base, row8} matched greedy from all four schemes on every
// practice stream.
function encodeFixed(tokens: Tokens, data: Buffer): { buf: Buffer; cuts: [number, number][] } {
  const schemes = splitSchemes(tokens, data);
  const starts = [schemes[0], schemes[2]];
  let best: Buffer | null = null;
  let bestCuts: [number, number][] = starts[0];
  for (const cuts of starts) {
    const enc = encodeTokens(tokens, cuts);
    if (!best || enc.length < best.length) {
      best = enc;
      bestCuts = cuts;
    }
  }
  return { buf: best!, cuts: bestCuts };
}

// Iter 8: EXACT frequency-based block cost. blockCostBits is exactly
// reproducible from the token range's symbol frequencies alone (fixed cost
// from FIXED lengths, dynamic cost from buildLengths + the code-length
// table, both exact) — verified 0 bits of error on every merged practice
// block — but costs O(288) instead of O(tokens). Prefix frequencies per
// row boundary (+delta adjustment for non-row block starts) make every
// candidate split cost O(288); entropy (Shannon, K=0) ranks all 719 rows
// and the top-40 are verified with the exact cost. Recovers ~all of the
// exhaustive-split gain (probeF: +303B over the cheap split) in ~0.9s
// total instead of ~4.2s.
function costFromFreqs(litFreq: Uint32Array, distFreq: Uint32Array, extraBits: number): number {
  let fixed = 3 + extraBits;
  for (let s = 0; s < 288; s++) fixed += litFreq[s] * FIXED_LIT_LEN[s];
  for (let s = 0; s < 30; s++) fixed += distFreq[s] * 5;
  const litLen = buildLengths(litFreq, 15);
  const distLen = buildLengths(distFreq, 15);
  let litCount = 257;
  for (let i = 287; i >= 257; i--) if (litLen[i] > 0) { litCount = i + 1; break; }
  let distCount = 1;
  for (let i = 29; i >= 0; i--) if (distLen[i] > 0) { distCount = i + 1; break; }
  if (litCount > 286) return fixed;
  let noDist = true;
  for (let s = 0; s < 30; s++) if (distFreq[s] > 0) { noDist = false; break; }
  if (noDist) { distLen[0] = 1; distCount = 1; }
  const combined: number[] = [];
  for (let i = 0; i < litCount; i++) combined.push(litLen[i]);
  for (let i = 0; i < distCount; i++) combined.push(distLen[i]);
  const rleSym: number[] = [];
  const rleExtraBits: number[] = [];
  let i = 0;
  while (i < combined.length) {
    const v = combined[i];
    let run = 1;
    while (i + run < combined.length && combined[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) { const take = Math.min(138, left); rleSym.push(18); rleExtraBits.push(7); left -= take; }
      if (left >= 3) { rleSym.push(17); rleExtraBits.push(3); left = 0; }
      while (left > 0) { rleSym.push(0); rleExtraBits.push(0); left--; }
    } else {
      rleSym.push(v); rleExtraBits.push(0);
      let left = run - 1;
      while (left >= 3) { const take = Math.min(6, left); rleSym.push(16); rleExtraBits.push(2); left -= take; }
      while (left > 0) { rleSym.push(v); rleExtraBits.push(0); left--; }
    }
    i += run;
  }
  const clFreq = new Uint32Array(19);
  for (const sym of rleSym) clFreq[sym]++;
  const clLen = buildLengths(clFreq, 7);
  let hclen = 4;
  for (let k = CL_ORDER.length - 1; k >= 0; k--) if (clLen[CL_ORDER[k]] > 0) { hclen = Math.max(4, k + 1); break; }
  let table = 3 + 14 + 3 * hclen;
  for (let k = 0; k < rleSym.length; k++) table += clLen[rleSym[k]] + rleExtraBits[k];
  let data = extraBits;
  for (let s = 0; s < 288; s++) data += litFreq[s] * litLen[s];
  for (let s = 0; s < 30; s++) data += distFreq[s] * distLen[s];
  return Math.min(fixed, table + data);
}

interface SplitModel {
  rowTok: number[];
  rangeStats: (s: number, e: number) => { lit: Uint32Array; dist: Uint32Array; ex: number; ent: number; fixed: number };
}

function buildSplitModel(tokens: Tokens, data: Buffer): SplitModel {
  const l2 = new Float64Array(tokens.count + 2);
  for (let f = 1; f < l2.length; f++) l2[f] = f * Math.log2(f);
  const rowLen = data.length / 720;
  const rowTok: number[] = new Array(721).fill(-1);
  {
    let covered = 0;
    let r = 1;
    for (let i = 0; i < tokens.count && r < 720; i++) {
      covered += tokens.kind[i] === 0 ? 1 : tokens.a[i];
      while (r < 720 && covered >= Math.round(r * rowLen)) { rowTok[r] = i + 1; r++; }
    }
  }
  rowTok[0] = 0;
  rowTok[720] = tokens.count;
  const n = tokens.count;
  const litSym = new Uint16Array(n);
  const distSym = new Int16Array(n).fill(-1);
  const exLit = new Uint8Array(n);
  const exDist = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (tokens.kind[i] === 0) litSym[i] = tokens.a[i];
    else {
      const lc = LEN_CODE_TABLE[tokens.a[i]];
      litSym[i] = 257 + lc;
      exLit[i] = LEN_EXTRA[lc];
      const dc = DIST_CODE_TABLE[tokens.b[i]];
      distSym[i] = dc;
      exDist[i] = DIST_EXTRA[dc];
    }
  }
  const prefLit: Uint32Array[] = [];
  const prefDist: Uint32Array[] = [];
  const prefEx = new Float64Array(721);
  const prefMatch = new Uint32Array(721);
  let curL = new Uint32Array(288);
  let curD = new Uint32Array(30);
  let curEx = 0;
  let curM = 0;
  const snapAt = new Map<number, number>();
  for (let r = 0; r <= 720; r++) snapAt.set(rowTok[r], r);
  prefLit[0] = curL.slice();
  prefDist[0] = curD.slice();
  for (let i = 0; i < n; i++) {
    curL[litSym[i]]++;
    curEx += exLit[i] + exDist[i];
    if (distSym[i] >= 0) { curD[distSym[i]]++; curM++; }
    const r = snapAt.get(i + 1);
    if (r !== undefined && r > 0) { prefLit[r] = curL.slice(); prefDist[r] = curD.slice(); prefEx[r] = curEx; prefMatch[r] = curM; }
  }
  for (let r = 1; r <= 720; r++) {
    if (!prefLit[r]) { prefLit[r] = prefLit[r - 1]; prefDist[r] = prefDist[r - 1]; prefEx[r] = prefEx[r - 1]; prefMatch[r] = prefMatch[r - 1]; }
  }
  const cache = new Map<number, { lit: Uint32Array; dist: Uint32Array; ex: number; match: number }>();
  const freqAt = (t: number): { lit: Uint32Array; dist: Uint32Array; ex: number; match: number } => {
    const hit = cache.get(t);
    if (hit) return hit;
    let lo = 0;
    let hi = 720;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rowTok[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const r = lo;
    const lit = prefLit[r].slice();
    const dist = prefDist[r].slice();
    let ex = prefEx[r];
    let match = prefMatch[r];
    for (let i = rowTok[r]; i < t; i++) {
      lit[litSym[i]]++;
      ex += exLit[i] + exDist[i];
      if (distSym[i] >= 0) { dist[distSym[i]]++; match++; }
    }
    const v = { lit, dist, ex, match };
    cache.set(t, v);
    return v;
  };
  const rangeStats = (s: number, e: number): { lit: Uint32Array; dist: Uint32Array; ex: number; ent: number; fixed: number } => {
    const A = freqAt(s);
    const B = freqAt(e);
    const lit = new Uint32Array(288);
    const dist = new Uint32Array(30);
    for (let k = 0; k < 288; k++) lit[k] = B.lit[k] - A.lit[k];
    lit[256]++;
    for (let k = 0; k < 30; k++) dist[k] = B.dist[k] - A.dist[k];
    const ex = B.ex - A.ex;
    const nLit = e - s + 1;
    let sumFL = 0;
    let fixedL = 0;
    for (let k = 0; k < 288; k++) {
      const f = lit[k];
      if (f) { sumFL += l2[f]; fixedL += f * FIXED_LIT_LEN[k]; }
    }
    const entL = nLit * Math.log2(nLit) - sumFL;
    const nDist = B.match - A.match;
    let sumFD = 0;
    let fixedD = 0;
    if (nDist > 0) {
      for (let k = 0; k < 30; k++) {
        const f = dist[k];
        if (f) { sumFD += l2[f]; fixedD += f * 5; }
      }
    }
    const entD = nDist > 0 ? nDist * Math.log2(nDist) - sumFD : 0;
    return { lit, dist, ex, ent: entL + entD + ex, fixed: fixedL + fixedD + ex };
  };
  return { rowTok, rangeStats };
}

// Entropy-ranked greedy SPLIT (iter 8): rank every row boundary by Shannon
// entropy gain (K=0 — over-proposing is harmless, verification is exact),
// verify the top-40 with the exact frequency cost, accept the best
// verified gain. Returns the cuts and how many splits were accepted.
function greedyEntropySplitCuts(tokens: Tokens, startCuts: [number, number][], data: Buffer, prebuilt?: SplitModel): [[number, number][], number] {
  const m = prebuilt ?? buildSplitModel(tokens, data);
  const estCost = (s: number, e: number): number => {
    const st = m.rangeStats(s, e);
    return Math.min(st.fixed + 3, st.ent + 3);
  };
  const exactCost = (s: number, e: number): number => {
    const st = m.rangeStats(s, e);
    return costFromFreqs(st.lit, st.dist, st.ex);
  };
  let cur: [number, number][] = startCuts.map((c) => [c[0], c[1]] as [number, number]);
  let accepted = 0;
  for (let round = 0; round < 40; round++) {
    const scored: [number, number, number][] = [];
    for (let b = 0; b < cur.length; b++) {
      const [s, e] = cur[b];
      const curEst = estCost(s, e);
      for (let r = 1; r < 720; r++) {
        const t = m.rowTok[r];
        if (t <= s || t >= e) continue;
        const g = curEst - (estCost(s, t) + estCost(t, e));
        if (g > 0) scored.push([g, b, t]);
      }
    }
    if (!scored.length) break;
    scored.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
    let bestGain = 0;
    let bestB = -1;
    let bestT = -1;
    for (let k = 0; k < Math.min(40, scored.length); k++) {
      const [, b, t] = scored[k];
      const [s, e] = cur[b];
      const gain = exactCost(s, e) - (exactCost(s, t) + exactCost(t, e));
      if (gain > bestGain) { bestGain = gain; bestB = b; bestT = t; }
    }
    if (bestGain <= 0) break;
    const [s, e] = cur[bestB];
    cur.splice(bestB, 1, [s, bestT], [bestT, e]);
    accepted++;
  }
  return [cur, accepted];
}

// Iter 8b: greedy-merge with the EXACT frequency cost. blockCostBits
// depends on `last` only through the 1-bit BFINAL value, never its count,
// so cost(s,e) == costFromFreqs(rangeStats(s,e)) exactly (0 bits of error
// on every checked block) and merge decisions are identical to the
// token-iterating version at ~1/10th the cost.
function greedyMergeCutsFast(tokens: Tokens, startCuts: [number, number][], model: SplitModel): [number, number][] {
  const cache = new Map<string, number>();
  const cost = (s: number, e: number): number => {
    const k = s + ',' + e;
    let v = cache.get(k);
    if (v === undefined) {
      const st = model.rangeStats(s, e);
      v = costFromFreqs(st.lit, st.dist, st.ex);
      cache.set(k, v);
    }
    return v;
  };
  let cuts: [number, number][] = startCuts.map((c) => [c[0], c[1]] as [number, number]);
  const totalBits = (cs: [number, number][]): number => {
    let bits = 0;
    for (let b = 0; b < cs.length; b++) bits += cost(cs[b][0], cs[b][1]);
    return bits;
  };
  let bits = totalBits(cuts);
  while (cuts.length > 1) {
    let bestGain = 0;
    let bestIdx = -1;
    for (let i = 0; i < cuts.length - 1; i++) {
      const m = cost(cuts[i][0], cuts[i + 1][1]);
      const cur = cost(cuts[i][0], cuts[i][1]) + cost(cuts[i + 1][0], cuts[i + 1][1]);
      if (cur - m > bestGain) {
        bestGain = cur - m;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    cuts.splice(bestIdx, 2, [cuts[bestIdx][0], cuts[bestIdx + 1][1]] as [number, number]);
    bits -= bestGain;
  }
  return cuts;
}

// Encode the winning token set with greedy-merge improvement from its best
// scheme and from row-8. Merging runs only on the winner: running it on
// every candidate token set cost ~10s for no extra gain (the losers never
// win after merging either, in practice).
function encodeBest(tokens: Tokens, data: Buffer, allowSplit = true): Buffer {
  const { buf, cuts } = encodeFixed(tokens, data);
  let best = buf;
  let bestCuts = cuts;
  const schemes = splitSchemes(tokens, data);
  const model = buildSplitModel(tokens, data);
  for (const start of [cuts, schemes[2]]) {
    const merged = greedyMergeCutsFast(tokens, start, model);
    const enc = encodeTokens(tokens, merged);
    if (enc.length < best.length) {
      best = enc;
      bestCuts = merged;
    }
  }
  if (allowSplit) {
    const [split, accepted] = greedyEntropySplitCuts(tokens, bestCuts, data, model);
    const enc = encodeTokens(tokens, split);
    if (enc.length < best.length) {
      best = enc;
      bestCuts = split;
    }
    // Fallback: when the entropy model finds nothing (tiny streams), the
    // coarse grid split still finds a few bytes (i001: -7B).
    if (accepted === 0) {
      const cheap = greedySplitCuts(tokens, bestCuts, data);
      const enc2 = encodeTokens(tokens, cheap);
      if (enc2.length < best.length) best = enc2;
    }
  }
  return best;
}

// Iter 7: cheap greedy SPLIT after merge. A merged block can span regions
// whose symbol distributions differ; splitting it at a row boundary lets
// each half carry Huffman tables fitted to its own data. Candidate split
// points are row boundaries on a coarse grid (every 12 rows), refined
// around the best row; each accepted split strictly reduces total bits.
// Measured on practice fi=0 streams: -1835B total for ~4.2s at 12 rounds
// (vs -2443B for the exhaustive all-rows split at ~50s). Skipped for huge streams,
// where a 5th parse pass buys far more per second.
// The full custom DEFLATE (iter 9): one lazy parse, then one or two
// optimal parses — plus, per stream size class, either an extra
// all-candidates optimal pass (screened total > 70000, where mid-match
// positions win thousands of bytes) or plus-8 candidates on the last
// optimal pass (smaller streams: gains everywhere, cheap; i007 even beats
// its all-pass with plus-8). Every candidate token set is encoded with
// greedy-merge block splits and the smallest raw stream wins, so each
// extra pass can only help.
function greedySplitCuts(tokens: Tokens, startCuts: [number, number][], data: Buffer): [number, number][] {
  const STEP = 12;
  const ROUNDS = 12;
  const cache = new Map<string, number>();
  const cost = (s: number, e: number, last: boolean): number => {
    const k = s + ',' + e + ',' + (last ? 1 : 0);
    let v = cache.get(k);
    if (v === undefined) {
      v = blockCostBits(tokens, s, e, last);
      cache.set(k, v);
    }
    return v;
  };
  const totalBits = (cs: [number, number][]): number => {
    let bits = 0;
    for (let b = 0; b < cs.length; b++) bits += cost(cs[b][0], cs[b][1], b === cs.length - 1);
    return bits;
  };
  // Token index just after each row boundary.
  const rowLen = data.length / 720;
  const rowTok: number[] = new Array(720).fill(-1);
  {
    let covered = 0;
    let r = 1;
    for (let i = 0; i < tokens.count && r < 720; i++) {
      covered += tokens.kind[i] === 0 ? 1 : tokens.a[i];
      while (r < 720 && covered >= Math.round(r * rowLen)) {
        rowTok[r] = i + 1;
        r++;
      }
    }
  }
  let cur: [number, number][] = startCuts.map((c) => [c[0], c[1]] as [number, number]);
  let bits = totalBits(cur);
  let focus = -1;
  for (let round = 0; round < ROUNDS; round++) {
    const candRows: number[] = [];
    if (focus < 0) {
      for (let r = STEP; r < 720; r += STEP) candRows.push(r);
    } else {
      for (let r = Math.max(1, focus - STEP + 1); r <= Math.min(719, focus + STEP - 1); r++) candRows.push(r);
    }
    let bestGain = 0;
    let bestBlock = -1;
    let bestTok = -1;
    let bestRow = -1;
    for (let b = 0; b < cur.length; b++) {
      const [s, e] = cur[b];
      const lastB = b === cur.length - 1;
      const curCost = cost(s, e, lastB);
      for (const r of candRows) {
        const t = rowTok[r];
        if (t < 0 || t <= s || t >= e) continue;
        const gain = curCost - (cost(s, t, false) + cost(t, e, lastB));
        if (gain > bestGain) {
          bestGain = gain;
          bestBlock = b;
          bestTok = t;
          bestRow = r;
        }
      }
    }
    if (bestGain <= 0) {
      if (focus >= 0) {
        focus = -1;
        continue;
      }
      break;
    }
    const [s, e] = cur[bestBlock];
    cur.splice(bestBlock, 1, [s, bestTok], [bestTok, e]);
    bits -= bestGain;
    focus = bestRow;
  }
  return cur;
}
// Iter 8: all-pass chain is a parameter (0 = no all-pass, plus-8 on the
// last optimal pass instead). Chain by screened total + colour type, see
// main(): small streams plus-8; mid rich/grey streams a deeper chain;
// alpha (colour type 6) streams keep the short chain / plus-8 — their
// matches fragment on alpha bytes and long chains buy little (probeC/H).
function customDeflate(data: Buffer, allChain: number, huge = false): Buffer | null {
  if (data.length < 64) return null;
  try {
    const matcher = new Matcher(data);
    let litLen: Uint8Array = FIXED_LIT_LEN;
    let distLen: Uint8Array = FIXED_DIST_LEN;
    let tokens: Tokens | null = null;
    let lazyTokens: Tokens | null = null;
    // Iter 9: ONE lazy pass (chain 1024) then the optimal passes
    // (passes-2 of them: 1 normally, 2 for huge streams). The second lazy
    // pass was redundant: with a single chain-1024 lazy pass the final
    // tokens are byte-identical on 4 of 5 big practice streams and +16B
    // on the fifth (probe iter 9), for ~2.2s saved across the set.
    const passes = huge ? 4 : 3;
    const nOpt = passes - 2;
    // Iter 8b: seed optimal passes at chain 1024 when an all-pass follows
    // (probeL: -495B and -4.4s on the four big streams — the all-pass
    // re-explores from the seed, so a shorter seed chain wins); plus-8
    // streams keep 4096 (probeM: seed1024 costs +337..+1242B there).
    // Iter 10: seed chains cut (1024 -> 512 ahead of an all-pass,
    // 4096 -> 1024 for plus-8 streams). The grader's CPU is >=1.55x
    // slower than this machine and iter-9 (30s local) timed out there;
    // the plus-8 pass at chain 4096 alone cost ~6.6s of the local run.
    const seedChain = allChain > 0 ? 512 : 1024;
    tokens = parseData(data, matcher, litLen, distLen, 1024, false);
    lazyTokens = tokens;
    litLen = buildLengths(tokens.litFreq, 15);
    distLen = buildLengths(tokens.distFreq, 15);
    for (let q = 0; q < nOpt; q++) {
      tokens = parseOptimal(data, matcher, litLen, distLen, seedChain, tokens!, allChain === 0 && q === nOpt - 1 ? 'plus8' : undefined);
      litLen = buildLengths(tokens.litFreq, 15);
      distLen = buildLengths(tokens.distFreq, 15);
    }
    const t = tokens!;
    const cands: Tokens[] = [t, lazyTokens!];
    if (allChain > 0) {
      const allTokens = parseOptimal(data, matcher, litLen, distLen, allChain, t, 'all');
      cands.push(allTokens);
    }
    let raw: Buffer | null = null;
    let winTokens: Tokens | null = null;
    for (const cand of cands) {
      const enc = encodeFixed(cand, data);
      if (!raw || enc.buf.length < raw.length) {
        raw = enc.buf;
        winTokens = cand;
      }
    }
    // Iter 8: the entropy split is cheap (~0.1s/stream), so huge streams
    // get it too (i006: -254B) — the old "skip split when huge" rule was
    // priced for the slow grid split.
    const merged = encodeBest(winTokens!, data, true);
    if (merged.length < raw!.length) raw = merged;
    const out = Buffer.alloc(raw!.length + 6);
    out[0] = 0x78;
    out[1] = 0x01;
    raw!.copy(out, 2);
    out.writeUInt32BE(adler32(data), 2 + raw!.length);
    return out;
  } catch {
    return null;
  }
}

// Cheap custom DEFLATE for the second finalist: the two lazy passes only
// (short chain, then long chain with re-estimated Huffman lengths),
// encoded under the split schemes. Much faster than the optimal-parse
// version, and a safety net for sets where the second finalist wins.
function customDeflateCheap(data: Buffer): Buffer | null {
  if (data.length < 64) return null;
  try {
    const matcher = new Matcher(data);
    let litLen: Uint8Array = FIXED_LIT_LEN;
    let distLen: Uint8Array = FIXED_DIST_LEN;
    let tokens: Tokens | null = null;
    for (let p = 0; p < 2; p++) {
      tokens = parseData(data, matcher, litLen, distLen, p === 0 ? 32 : 4096, false);
      litLen = buildLengths(tokens.litFreq, 15);
      distLen = buildLengths(tokens.distFreq, 15);
    }
    const t = tokens!;
    const raw = encodeBest(t, data);
    const out = Buffer.alloc(raw.length + 6);
    out[0] = 0x78;
    out[1] = 0x01;
    raw.copy(out, 2);
    out.writeUInt32BE(adler32(data), 2 + raw!.length);
    return out;
  } catch {
    return null;
  }
}

// Final compression: zlib level 9 in two flavours plus, for the best
// finalist, the hand-written optimal-parse DEFLATE, and for a close second
// finalist the cheap lazy-only DEFLATE. The smallest zlib stream wins.
function finalCompress(filtered: Buffer, mode: number, screenedTotal: number, allChain: number): Buffer {
  // Iter 7: Z_FILTERED dropped for mode-0 finalists — on practice it never
  // wins a finalist comparison (fi=0 custom wins by >=864B everywhere; the
  // largest filtered win on a trailing finalist is -4569B on a stream
  // 13k behind) and costs ~2.8s of level-9 runs. Only zlib level 9 remains.
  if (mode === 2) {
    const custom = customDeflate(filtered, allChain, screenedTotal > 150000);
    if (custom) {
      // Iter 8b: on big streams the custom DEFLATE beats zlib-9 by
      // >=2340B on practice, so skip the level-9 comparison (saves
      // ~1.1s). Small streams keep the comparison (min advantage 661B),
      // and a null custom still falls back to zlib-9.
      if (screenedTotal > 40000) return custom;
      const z = deflateSync(filtered, { level: 9 });
      return z.length < custom.length ? z : custom;
    }
    return deflateSync(filtered, { level: 9 });
  }
  return deflateSync(filtered, { level: 9 });
}

// ------------------------------------------------------------ PNG writing --
// Output chunks, in order: IHDR, PLTE when the form is a palette, tRNS
// when present, a single IDAT holding the whole zlib stream, IEND. Nothing
// else is written.
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crc = crc32(out, 4, 8 + data.length);
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function writePng(form: Form, zlibStream: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = form.colourType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const parts: Buffer[] = [Buffer.from(PNG_SIG), chunk('IHDR', ihdr)];
  if (form.plte) parts.push(chunk('PLTE', form.plte));
  if (form.trns) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', zlibStream));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------- main --
// One run answers every instance directory found in the input directory.
// Work is a fixed amount per instance, never cut off by the clock, so two
// runs on the same set produce byte-identical output. The expensive
// optimal-parse DEFLATE runs only on the best-screened finalist; the rest
// get zlib level 9 only. That keeps the whole set inside the 60-second
// wall budget on one CPU.
// Iter 9: screen and compress one instance at a time (see main()).
// FIX-1938: the chain-1024 cap is retired; chains are smaller across the
// board (128/512/512) so the worst-case wall time stays bounded; the
// assignment is a pure function of the screened totals, so runs stay
// byte-identical.
function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const ids = readdirSync(inputDir).sort();
  const chainFor = (total: number, ct: number): number => {
    // FIX-1938: i006 512->128, i003 256->128 (restored from 64: brute-gate
    // savings fund it), i002 1024->512, i004 stays 512 (chain-1024 cap
    // retired — see NOTES-FIX-20261127-1938).
    if (total > 150000) return 128;
    if (total > 70000) return ct !== 6 ? 512 : 128;
    if (total > 40000) return ct === 6 ? 0 : 512; // ct6 stays plus8 (i007: all-pass costs ~9s for ~273B)
    return 0;
  };
  // Iter 9: screen and compress one instance at a time, then drop its
  // buffers before the next instance. The old two-phase layout (screen
  // all eight, then compress) held every instance's filtered streams and
  // forms at once and peaked near 470 MB RSS on this machine — close to
  // the grader's 512 MB. Per-instance decisions depend only on that
  // instance, so interleaving is byte-identical and cuts peak RSS to
  // roughly one instance's working set.
  for (const id of ids) {
    const inFile = join(inputDir, id, 'image.png');
    const decoded = decodePng(readFileSync(inFile));
    if (decoded.width !== W || decoded.height !== H) fail(id + ': unexpected size');
    const an = analyse(decoded.rgba);
    const forms = candidateForms(decoded.rgba, an);
    const finalists = pickFinalists(forms);
    let png: Buffer | null = null;
    let winType = -1;
    const f0total = finalists[0].total;
    for (let fi = 0; fi < finalists.length; fi++) {
      const cand = finalists[fi];
      // Iter 8: skip trailing finalists (screened lag > 500). On practice
      // their zlib-9 can never beat the fi=0 custom (smallest margin
      // 813B); keeping only the close ones saves ~2.0s.
      if (fi > 0 && cand.total - f0total > 500) continue;
      // Iter 6: only fi=0 gets the custom DEFLATE; the cheap fi=1 custom
      // was dropped (6.7s, never won in practice) to fund the all-pass.
      const mode = fi === 0 ? 2 : 0;
      const stream = finalCompress(
        cand.filtered,
        mode,
        cand.total,
        fi === 0 ? chainFor(cand.total, cand.form.colourType) : 0,
      );
      const out = writePng(cand.form, stream);
      if (!png || out.length < png.length) {
        png = out;
        winType = cand.form.colourType;
      }
    }
    const outDir = join(outputDir, id);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'image.png'), png!);
    process.stderr.write(
      `${id}: type=${winType} bytes=${png!.length} ` +
        `(colours=${an.colours ? an.colours.length : '>256'} grey=${an.isGrey} opaque=${an.allOpaque})\n`,
    );
  }
}

main();
