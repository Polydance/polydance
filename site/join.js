/**
 * The homepage's form asking to join the trial (Robin, 2026-11-11). It posts to the receiver's /join
 * (src/server/join.ts), which emails the team. Before it goes, the browser does about a second's work: it finds a
 * nonce for which sha256("polydance-join:v1:<stamp>:<email>:<nonce>") starts with `bits` zero bits, so each
 * request costs its sender the same whether a person or a script sends it. It also notes when the page loaded,
 * since a person takes longer than three seconds. Nothing is fetched; tests/site.test.ts checks this file finds
 * nonces the receiver accepts.
 */

const BATCH = 256;

/** Leading zero bits of a digest. */
function zeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) { bits += 8; continue; }
    return bits + Math.clz32(b) - 24;
  }
  return bits;
}

/** The first nonce, counting in base 36 from 0, whose digest with `prefix` has at least `bits` zero bits. */
export async function solve(prefix, bits, subtle = globalThis.crypto.subtle) {
  const encode = (s) => new TextEncoder().encode(s);
  for (let n = 0; ; n += BATCH) {
    const tries = [];
    for (let i = n; i < n + BATCH; i++) tries.push(subtle.digest('SHA-256', encode(prefix + i.toString(36))));
    const digests = await Promise.all(tries);
    for (let k = 0; k < digests.length; k++) if (zeroBits(new Uint8Array(digests[k])) >= bits) return (n + k).toString(36);
  }
}

/** What the browser sends to be hashed: the same text join.ts hashes, from the address trimmed and lower-cased. */
export const workPrefix = (stamp, email) => `polydance-join:v1:${stamp}:${email.trim().toLowerCase()}:`;

function wire(form) {
  const field = (name) => form.elements.namedItem(name);
  field('started').value = String(Date.now());
  const status = form.querySelector('.join-status');
  const button = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async (event) => {
    if (form.dataset.ready === '1') return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    button.disabled = true;
    status.textContent = 'Checking this is a person…';
    const stamp = Date.now();
    field('stamp').value = String(stamp);
    field('nonce').value = await solve(workPrefix(stamp, field('email').value), Number(form.dataset.bits || 18));
    form.dataset.ready = '1';
    status.textContent = 'Sending…';
    form.submit();
  });
  // Back from the result page: the form can be sent again.
  addEventListener('pageshow', () => { form.dataset.ready = ''; button.disabled = false; status.textContent = ''; });
}

if (typeof document !== 'undefined') {
  const form = document.querySelector('#join-form');
  if (form) wire(form);
}
