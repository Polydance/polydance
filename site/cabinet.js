/**
 * The homepage's cabinet (Robin chose mockup A, "Cabinet", on 2026-11-10): the wood behind the page and the deck's
 * motion. The wood is the headset app's WoodDrawable (Surfaces.kt) ported line for line, with java.util.Random
 * seeded 1966, as the Mac and the iPhone port it (RetroLook.swift), so the boards are the app's boards. Without
 * JavaScript the page keeps plain boards from site.css and a still deck. tests/design.test.ts checks this file's
 * colours against design/tokens.json and its Random against the JVM's.
 */

const WOOD = { light: '#E0C294', mid: '#D2B07E', grain: '#966A3E', seam: '#704C2C' };
const BOARD = 150;

/** java.util.Random, exactly: the 48-bit LCG, next(bits), nextInt(), nextInt(bound) and nextFloat(). */
export class JavaRandom {
  static MASK = (1n << 48n) - 1n;
  constructor(seed) { this.seed = (BigInt(seed) ^ 0x5DEECE66Dn) & JavaRandom.MASK; }
  next(bits) {
    this.seed = (this.seed * 0x5DEECE66Dn + 0xBn) & JavaRandom.MASK;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }
  nextInt(bound) {
    if (bound === undefined) return this.next(32);
    let r = this.next(31);
    const m = bound - 1;
    if ((bound & m) === 0) return Number((BigInt(bound) * BigInt(r)) >> 31n);
    for (let u = r; ((u - (r = u % bound) + m) | 0) < 0; u = this.next(31));
    return r;
  }
  nextFloat() { return this.next(24) / (1 << 24); }
}

/** The boards and grain lines of the first `boards` boards, in the order the app draws them. */
export function woodBoards(boards) {
  const random = new JavaRandom(1966);
  const out = [];
  for (let index = 0; index < boards; index++) {
    const top = index * BOARD;
    const shift = random.nextInt(9) - 4;
    const lines = 10 + random.nextInt(6);
    const grain = [];
    for (let k = 0; k < lines; k++) {
      const y0 = top + (k + random.nextFloat()) * BOARD / lines;
      const amp = 1 + random.nextFloat() * 4;
      const wave = 220 + random.nextFloat() * 420;
      const drift = (random.nextFloat() - 0.5) * 10;
      const phase = random.nextFloat() * 6.283;
      grain.push({ y0, amp, wave, drift, phase, alpha: (26 + random.nextInt(64)) / 255, width: 0.6 + random.nextFloat() * 1.5 });
    }
    out.push({ top, tone: index % 2 === 0 ? WOOD.light : WOOD.mid, shift, grain });
  }
  return out;
}

const shifted = (hex, shift) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${((n >> 16) & 255) + shift},${((n >> 8) & 255) + shift},${(n & 255) + shift})`;
};

/** Paints ten boards `width` CSS pixels wide and returns them as an image to repeat down the page. */
function woodTile(width, boards = 10) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const height = boards * BOARD;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(height * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const all = woodBoards(boards);
  for (const board of all) { g.fillStyle = shifted(board.tone, board.shift); g.fillRect(0, board.top, width, BOARD); }
  g.strokeStyle = WOOD.grain;
  for (const board of all) {
    for (const line of board.grain) {
      g.beginPath();
      let x = 0;
      g.moveTo(x, line.y0 + line.amp * Math.sin(line.phase));
      while (x < width) { x += 10; g.lineTo(x, line.y0 + line.amp * Math.sin(line.phase + x / line.wave * 6.283) + line.drift * x / width); }
      g.globalAlpha = line.alpha; g.lineWidth = line.width; g.stroke();
    }
  }
  g.globalAlpha = 1;
  // A seam above every board but the first, and one at the foot so the repeat reads as the next board.
  for (let y = BOARD; y <= height; y += BOARD) {
    g.fillStyle = WOOD.seam; g.fillRect(0, y - 1, width, 2);
    g.fillStyle = 'rgba(255,240,214,0.353)'; g.fillRect(0, y + 1.1, width, 1);
  }
  return { url: canvas.toDataURL('image/jpeg', 0.9), width, height };
}

/** Puts the wood behind the page, repainted when the window grows past the width painted. */
export function wood(el = document.body) {
  let painted = 0;
  const paint = () => {
    const width = Math.max(1440, Math.ceil(window.innerWidth / 160) * 160);
    if (width <= painted) return;
    painted = width;
    const tile = woodTile(width);
    el.style.backgroundImage = `url(${tile.url})`;
    el.style.backgroundSize = `${tile.width}px ${tile.height}px`;
  };
  paint();
  let timer;
  addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(paint, 200); });
}

/** Runs the deck: the counter counts and the needles move with a voice. The reels turn in CSS. Still under reduced motion. */
export function runDeck(root = document) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const counter = root.querySelector('.deck .counter');
  let seconds = 42;
  setInterval(() => {
    seconds += 1;
    if (counter) counter.textContent = `${String(Math.floor(seconds / 60) % 100).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }, 1000);
  // Each meter's needle swings on its own: the deck has MIC and APP.
  for (const needle of root.querySelectorAll('.deck .needle')) {
    const swing = () => {
      needle.style.transform = `rotate(${(-38 + Math.random() * 62).toFixed(1)}deg)`;
      setTimeout(swing, 120 + Math.random() * 260);
    };
    swing();
  }
}

// Only the hero's deck: the deck in How it works is story.js's.
if (typeof document !== 'undefined') { wood(); runDeck(document.querySelector('.hero-deck') ?? document); }
