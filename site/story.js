/**
 * How it works, played (Robin chose the story of three mockups on 2026-11-12, with a printer for the storyboard): a
 * 75-second recording in the headset, its words coming up as they are said while the deck records, a moment of
 * PROCESSING, then the printer feeding the storyboard out on tractor-feed paper, line by line. The page's markup is
 * the end of the story (the storyboard printed), so without JavaScript, or under reduced motion, that is what shows.
 * It plays only while on screen and starts from the beginning the first time it comes into view.
 * tests/design.test.ts checks this file's colours against design/tokens.json; tests/site.test.ts its timeline.
 */

const LENGTH = 75; // seconds of the pretend recording
const RECORD = 8.5; // seconds of the story it takes
const PROCESS = 1.6;
const PRINT = 5;
const HOLD = 3;
const TEAR = 1;
export const LOOP = RECORD + PROCESS + PRINT + HOLD + TEAR;
const ROW = 13; // the printer feeds a row at a time

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
const noise = (i) => { const v = Math.sin(i * 12.9898 + 4.1) * 43758.5453; return v - Math.floor(v); };
export const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Where the story is at t seconds into its loop: the phase, the recording's second, and how much is printed (0 to 1). */
export function storyAt(t) {
  t = ((t % LOOP) + LOOP) % LOOP;
  if (t < RECORD) return { phase: 'recording', second: (t / RECORD) * LENGTH, printed: 0 };
  if (t < RECORD + PROCESS) return { phase: 'processing', second: LENGTH, printed: 0 };
  if (t < RECORD + PROCESS + PRINT) return { phase: 'printing', second: LENGTH, printed: (t - RECORD - PROCESS) / PRINT };
  if (t < LOOP - TEAR) return { phase: 'ready', second: LENGTH, printed: 1 };
  return { phase: 'torn', second: LENGTH, printed: 1, torn: (t - (LOOP - TEAR)) / TEAR };
}

/** The headset's picture at a second of the recording: the hand's ray, the menu, the pressed button, the ring. */
export function sceneAt(s) {
  const st = { slide: 0, menu: false, press: false, ring: null, ptr: [78 + 18 * Math.sin(s * 0.9), 52 + 8 * Math.cos(s * 0.7)] };
  const toward = (target, k) => { st.ptr = [st.ptr[0] + (target[0] - st.ptr[0]) * k, st.ptr[1] + (target[1] - st.ptr[1]) * k]; };
  if (s >= 15 && s < 30) { st.menu = true; toward([18, 26], ease((s - 15) / 3)); if (s > 19 && s < 25) st.ring = [18, 26]; }
  if (s >= 34 && s < 55) { toward([80, 46], ease((s - 34) / 4)); if (s > 42 && s < 48) { st.ring = [80, 46]; st.press = true; } }
  if (s >= 55) { st.slide = 70 * (1 - ease((s - 56) / 6)); st.ptr = [112, 40]; if (s > 63 && s < 69) st.ring = [112, 40]; }
  return st;
}

// How loud the voice and the app are at a second: the voice only while a line is being said.
const levels = (s, said) => {
  const i = Math.floor(s * 6);
  const line = said.find((at) => s >= at && s <= at + 5);
  const mic = line === undefined ? 0.05 * noise(i) : 0.35 + 0.65 * noise(i) * Math.sin((Math.PI * (s - line)) / 5) ** 0.4;
  const app = 0.14 + 0.22 * noise(i + 99) + (Math.abs(s - 43) < 0.8 ? 0.4 : 0);
  return [mic, app];
};

export function runStory(root = document.querySelector('.story')) {
  if (!root || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const $ = (id) => root.querySelector(`#story-${id}`);
  const bubbles = [...root.querySelectorAll('.bubble')];
  const said = bubbles.map((b) => Number(b.dataset.at));
  const paper = $('paper');
  const height = Number(paper.dataset.height), slot = Number(paper.dataset.slot);
  const lamps = { rec: 'recording', processing: 'processing', ready: 'ready' };

  const draw = (t) => {
    const at = storyAt(t);
    const s = at.second;
    root.classList.toggle('recording', at.phase === 'recording');
    bubbles.forEach((b, i) => b.classList.toggle('said', at.phase !== 'torn' && s >= said[i]));

    const st = sceneAt(s);
    $('menu').setAttribute('opacity', st.menu ? 1 : 0);
    $('press').setAttribute('opacity', st.press ? 1 : 0);
    $('gallery').setAttribute('transform', `translate(${(48 + st.slide).toFixed(1)} 12)`);
    $('ray').setAttribute('d', `M 118 92 L ${st.ptr[0].toFixed(1)} ${st.ptr[1].toFixed(1)}`);
    $('dot').setAttribute('cx', st.ptr[0].toFixed(1));
    $('dot').setAttribute('cy', st.ptr[1].toFixed(1));
    $('ring').setAttribute('opacity', st.ring ? 1 : 0);
    if (st.ring) { $('ring').setAttribute('cx', st.ring[0]); $('ring').setAttribute('cy', st.ring[1]); }

    // The deck: its lamps, counter and meters.
    for (const [lamp, phase] of Object.entries(lamps)) {
      const on = at.phase === phase || (phase === 'ready' && (at.phase === 'printing' || at.phase === 'torn'));
      const blink = phase === 'recording' && Math.floor(t / 0.8) % 2 === 1;
      $(lamp).setAttribute('fill-opacity', on ? (blink ? 0.45 : 1) : 0.16);
      $(`${lamp}-glow`).setAttribute('opacity', on && !blink ? 1 : 0);
      $(`${lamp}-word`).setAttribute('fill', on ? '#EFE6D2' : '#807666');
    }
    $('counter').textContent = clock(s);
    const [mic, app] = at.phase === 'recording' ? levels(s, said) : [0, 0];
    $('needle-mic').style.transform = `rotate(${(-40 + mic * 70).toFixed(1)}deg)`;
    $('needle-app').style.transform = `rotate(${(-40 + app * 70).toFixed(1)}deg)`;

    // The printer: the paper fed a row at a time, the head running across, then the page torn off.
    const rows = at.printed * height / ROW;
    const fed = Math.min(height, (Math.floor(rows) + ease((rows % 1) * 3)) * ROW);
    const lift = at.torn ? ease(at.torn) * 120 : 0;
    paper.setAttribute('transform', `translate(0 ${(slot - fed - lift).toFixed(1)})`);
    paper.setAttribute('opacity', at.torn ? (1 - ease(at.torn)).toFixed(2) : 1);
    const printing = at.phase === 'printing';
    $('head').setAttribute('transform', `translate(${printing ? (40 + 230 * (0.5 - 0.5 * Math.cos(t * 9))).toFixed(1) : 160} 0)`);
    $('printing').setAttribute('fill-opacity', printing ? 1 : 0.16);
    $('idle').setAttribute('fill-opacity', printing ? 0.16 : 1);
  };

  // Plays only while on screen, from the start the first time it is seen.
  root.classList.add('playing');
  draw(0);
  let t = 0, last = null, frame = 0;
  const step = (now) => {
    if (last !== null) t = (t + Math.min(0.1, (now - last) / 1000)) % LOOP;
    last = now;
    draw(t);
    frame = requestAnimationFrame(step);
  };
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !frame) { last = null; frame = requestAnimationFrame(step); }
    if (!entry.isIntersecting && frame) { cancelAnimationFrame(frame); frame = 0; }
  }, { threshold: 0.25 }).observe(root);
}

if (typeof document !== 'undefined') runStory();
