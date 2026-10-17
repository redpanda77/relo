// A QR code for a short text (a sign-in link), drawn in the terminal so a phone can scan it. Byte mode, error
// correction level M, versions 1 to 10 (up to 213 bytes), the mask with the lowest penalty: ISO/IEC 18004, after
// Project Nayuki's reference encoder (MIT). No dependencies; nothing here touches the network.

// Per version (index 1..10) at level M: error correction codewords per block, and the number of blocks.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGNMENT = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const FORMAT_BITS_M = 0; // level M's two format bits

function rawModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;
    result -= (25 * count - 10) * count - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version) => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function divisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function remainder(data, generator) {
  const result = new Array(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    generator.forEach((coefficient, index) => { result[index] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

/** The final codeword sequence: data split into blocks, each with its error correction, interleaved. */
function codewords(data, version) {
  const blocks = BLOCKS[version];
  const ecc = ECC_PER_BLOCK[version];
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const generator = divisor(ecc);
  const out = [];
  for (let i = 0, k = 0; i < blocks; i += 1) {
    const length = shortLength - ecc + (i < shortBlocks ? 0 : 1);
    const chunk = data.slice(k, k + length);
    k += length;
    const block = [...chunk, ...(i < shortBlocks ? [0] : []), ...remainder(chunk, generator)];
    out.push(block);
  }
  const result = [];
  for (let i = 0; i < out[0].length; i += 1) {
    out.forEach((block, j) => { if (i !== shortLength - ecc || j >= shortBlocks) result.push(block[i]); });
  }
  return result;
}

class Matrix {
  constructor(version) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(x, y, dark) { this.dark[y][x] = dark; this.fixed[y][x] = true; }
}

function drawFunctionPatterns(matrix, version) {
  const { size } = matrix;
  for (let i = 0; i < size; i += 1) { matrix.set(6, i, i % 2 === 0); matrix.set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) matrix.set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }
  const positions = ALIGNMENT[version];
  positions.forEach((x, i) => positions.forEach((y, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) matrix.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  drawFormat(matrix, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      matrix.set(a, b, dark);
      matrix.set(b, a, dark);
    }
  }
}

function drawFormat(matrix, mask) {
  const { size } = matrix;
  const data = (FORMAT_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) matrix.set(8, i, bit(i));
  matrix.set(8, 7, bit(6));
  matrix.set(8, 8, bit(7));
  matrix.set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) matrix.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) matrix.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) matrix.set(8, size - 15 + i, bit(i));
  matrix.set(8, size - 8, true);
}

function drawCodewords(matrix, data) {
  const { size } = matrix;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!matrix.fixed[y][x] && i < data.length * 8) {
          matrix.dark[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i += 1;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(matrix, mask) {
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) if (!matrix.fixed[y][x] && MASKS[mask](x, y)) matrix.dark[y][x] = !matrix.dark[y][x];
  }
}

function penalty(matrix) {
  const { size, dark } = matrix;
  let result = 0;
  const line = (get) => {
    let score = 0;
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && get(i) === get(i - 1)) { run += 1; continue; }
      if (run >= 5) score += run - 2;
      run = 1;
    }
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= size; i += 1) {
      if (!pattern.every((value, k) => get(i + k) === value)) continue;
      const before = [1, 2, 3, 4].every((k) => i - k < 0 || !get(i - k));
      const after = [7, 8, 9, 10].every((k) => i + k >= size || !get(i + k));
      if (before || after) score += 40;
    }
    return score;
  };
  for (let y = 0; y < size; y += 1) result += line((x) => dark[y][x]);
  for (let x = 0; x < size; x += 1) result += line((y) => dark[y][x]);
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const c = dark[y][x];
      if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) result += 3;
    }
  }
  const total = dark.flat().filter(Boolean).length;
  result += Math.floor(Math.abs(total * 20 - size * size * 10) / (size * size)) * 10;
  return result;
}

/** The QR code's modules for `text` (rows of booleans, true is dark), or undefined when it is too long. */
export function qrModules(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  const version = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((v) => 4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v) * 8);
  if (version === undefined) return undefined;
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  const all = codewords(data, version);
  let best;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = new Matrix(version);
    drawFunctionPatterns(matrix, version);
    drawCodewords(matrix, all);
    applyMask(matrix, mask);
    drawFormat(matrix, mask);
    const score = penalty(matrix);
    if (!best || score < best.score) best = { score, matrix };
  }
  return best.matrix.dark;
}

/**
 * `text` as a QR code for a terminal: two module rows per line with half blocks, dark modules drawn in the
 * terminal's background colour on a light quiet zone, so it scans on dark and light themes alike.
 */
export function qrText(text, { quiet = 2 } = {}) {
  const modules = qrModules(text);
  if (!modules) return undefined;
  const size = modules.length + quiet * 2;
  const dark = (x, y) => {
    const mx = x - quiet;
    const my = y - quiet;
    return mx >= 0 && my >= 0 && mx < modules.length && my < modules.length && modules[my][mx];
  };
  const lines = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    for (let x = 0; x < size; x += 1) {
      const top = !dark(x, y);
      const bottom = y + 1 < size ? !dark(x, y + 1) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
