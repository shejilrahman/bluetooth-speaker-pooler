/* Minimal QR code encoder (byte mode, EC level M, versions 1-10). No dependencies.
 * window.QR.encode(text) -> { size, modules (size x size booleans), version, mask }
 * window.QR.toSvg(text, px)  -> SVG markup string
 */
(function (global) {
  'use strict';

  // Per version (index = version), EC level M: [ecPerBlock, blocks...] where blocks is
  // a list of data codeword counts for each block.
  const EC_M = {
    1: { ec: 10, blocks: [16] },
    2: { ec: 16, blocks: [28] },
    3: { ec: 26, blocks: [44] },
    4: { ec: 18, blocks: [32, 32] },
    5: { ec: 24, blocks: [43, 43] },
    6: { ec: 16, blocks: [27, 27, 27, 27] },
    7: { ec: 18, blocks: [31, 31, 31, 31] },
    8: { ec: 22, blocks: [38, 38, 39, 39] },
    9: { ec: 22, blocks: [36, 36, 36, 37, 37] },
    10: { ec: 26, blocks: [43, 43, 43, 43, 44] },
  };
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
  const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

  // ---- GF(256) ----
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  function rsGenerator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }

  function rsEncode(data, n) {
    const gen = rsGenerator(n);
    const res = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ res[0];
      res.shift(); res.push(0);
      if (f) for (let j = 0; j < n; j++) res[j] ^= mul(gen[j + 1], f);
    }
    return res;
  }

  // ---- bit buffer ----
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, len) { for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1); };

  function utf8(text) { return Array.from(new TextEncoder().encode(text)); }

  function chooseVersion(nBytes) {
    for (let v = 1; v <= 10; v++) {
      const cap = EC_M[v].blocks.reduce((a, b) => a + b, 0);
      const headBits = 4 + (v < 10 ? 8 : 16);
      if (headBits + nBytes * 8 <= cap * 8) return v;
    }
    throw new Error('Text too long for QR (max ~200 chars)');
  }

  function buildCodewords(bytes, v) {
    const info = EC_M[v];
    const totalData = info.blocks.reduce((a, b) => a + b, 0);
    const bb = new BitBuf();
    bb.put(0b0100, 4);
    bb.put(bytes.length, v < 10 ? 8 : 16);
    for (const b of bytes) bb.put(b, 8);
    const capBits = totalData * 8;
    bb.put(0, Math.min(4, capBits - bb.bits.length));
    while (bb.bits.length % 8) bb.bits.push(0);
    const data = [];
    for (let i = 0; i < bb.bits.length; i += 8) data.push(parseInt(bb.bits.slice(i, i + 8).join(''), 2));
    for (let p = 0; data.length < totalData; p++) data.push(p % 2 ? 0x11 : 0xec);

    // split into blocks, compute EC, interleave
    const blocks = [], ecs = [];
    let off = 0;
    for (const len of info.blocks) { const d = data.slice(off, off + len); off += len; blocks.push(d); ecs.push(rsEncode(d, info.ec)); }
    const out = [];
    const maxLen = Math.max(...info.blocks);
    for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < info.ec; i++) for (const e of ecs) out.push(e[i]);
    return out;
  }

  // ---- matrix ----
  function makeMatrix(v) {
    const size = v * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(null)); // null = unset data area
    const fn = Array.from({ length: size }, () => new Array(size).fill(false)); // function module?
    const set = (r, c, val) => { m[r][c] = val; fn[r][c] = true; };

    // finders + separators
    const finder = (r0, c0) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inF = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inF && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, dark);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // timing
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

    // alignment
    const al = ALIGN[v];
    const last = al.length - 1;
    for (let a = 0; a < al.length; a++) for (let b = 0; b < al.length; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue; // finder corners
      const r = al[a], c = al[b];
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }

    // reserve format info
    for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); }
    for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }

    // dark module (after reservation so it is not cleared)
    set(size - 8, 8, true);

    // reserve version info
    if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { set(i, size - 11 + j, false); set(size - 11 + j, i, false); }

    return { size, m, fn };
  }

  function placeData(mx, codewords) {
    const { size, m, fn } = mx;
    const bits = [];
    for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (fn[r][c]) continue;
          m[r][c] = bi < bits.length ? bits[bi] === 1 : false;
          bi++;
        }
      }
    }
  }

  const MASKS = [
    (i, j) => (i + j) % 2 === 0,
    (i) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
  ];

  function applyMask(mx, mask) {
    const { size, m, fn } = mx;
    const out = m.map((row) => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && MASKS[mask](r, c)) out[r][c] = !out[r][c];
    return out;
  }

  function bch(data, poly, bits) {
    let v = data << (bits - 1 - Math.floor(Math.log2(poly)) + 1 - 1);
    // generic: shift data left by degree(poly)
    const deg = Math.floor(Math.log2(poly));
    v = data << deg;
    for (let i = Math.floor(Math.log2(v)); i >= deg; i--) if ((v >> i) & 1) v ^= poly << (i - deg);
    return (data << deg) | v;
  }

  function writeFormat(grid, size, mask) {
    const data = (0b00 << 3) | mask; // EC level M = 00
    const f = bch(data, 0x537, 15) ^ 0x5412;
    for (let i = 0; i < 15; i++) {
      const bit = ((f >> i) & 1) === 1;
      // first copy: down the column right of the top-left finder, then along row 8
      if (i < 6) grid[i][8] = bit;
      else if (i === 6) grid[7][8] = bit;
      else if (i === 7) grid[8][8] = bit;
      else if (i === 8) grid[8][7] = bit;
      else grid[8][14 - i] = bit;
      // second copy: row 8 under the top-right finder, column 8 left of the bottom-left finder
      if (i < 8) grid[8][size - 1 - i] = bit;
      else grid[size - 15 + i][8] = bit;
    }
  }

  function writeVersion(grid, size, v) {
    if (v < 7) return;
    const info = VERSION_INFO[v];
    for (let i = 0; i < 18; i++) {
      const bit = ((info >> i) & 1) === 1;
      const a = Math.floor(i / 3), b = (i % 3) + size - 11;
      grid[a][b] = bit;
      grid[b][a] = bit;
    }
  }

  function penalty(grid, size) {
    let score = 0;
    // rule 1: runs
    for (let r = 0; r < size; r++) {
      let runR = 1, runC = 1;
      for (let c = 1; c < size; c++) {
        if (grid[r][c] === grid[r][c - 1]) { runR++; if (runR === 5) score += 3; else if (runR > 5) score++; } else runR = 1;
        if (grid[c][r] === grid[c - 1][r]) { runC++; if (runC === 5) score += 3; else if (runC > 5) score++; } else runC = 1;
      }
    }
    // rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
    // rule 3: finder-like patterns
    const pat = [true, false, true, true, true, false, true];
    const check = (get) => {
      for (let i = 0; i < size - 6; i++) {
        let ok = true;
        for (let k = 0; k < 7; k++) if (get(i + k) !== pat[k]) { ok = false; break; }
        if (!ok) continue;
        const before = i >= 4 && [1, 2, 3, 4].every((k) => get(i - k) === false);
        const after = i + 10 < size && [7, 8, 9, 10].every((k) => get(i + k) === false);
        if (before || after) score += 40;
      }
    };
    for (let r = 0; r < size; r++) { check((k) => grid[r][k]); check((k) => grid[k][r]); }
    // rule 4: dark proportion
    let dark = 0;
    for (const row of grid) for (const v of row) if (v) dark++;
    const pct = (dark * 100) / (size * size);
    const k = Math.floor(Math.abs(pct - 50) / 5);
    score += k * 10;
    return score;
  }

  function encode(text, forceMask) {
    const bytes = utf8(text);
    const v = chooseVersion(bytes.length);
    const cw = buildCodewords(bytes, v);
    const mx = makeMatrix(v);
    placeData(mx, cw);
    let best = null;
    const masks = forceMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask];
    for (const mask of masks) {
      const grid = applyMask(mx, mask);
      writeFormat(grid, mx.size, mask);
      writeVersion(grid, mx.size, v);
      const p = penalty(grid, mx.size);
      if (!best || p < best.p) best = { p, grid, mask };
    }
    return { size: mx.size, modules: best.grid, version: v, mask: best.mask };
  }

  function toSvg(text, px) {
    const q = encode(text);
    const quiet = 4, dim = q.size + quiet * 2;
    let d = '';
    for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) if (q.modules[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${px || 200}" height="${px || 200}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  global.QR = { encode, toSvg };
})(typeof window !== 'undefined' ? window : globalThis);
