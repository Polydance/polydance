/**
 * Counting visits to polydance.net with Google Analytics (Robin, 2026-11-12), only once the visitor says yes. Until
 * they choose, the bar at the foot of index.html asks, and nothing is fetched from Google; Allow and No thanks are the
 * same key, so neither is the easy one. The answer is kept in this browser's localStorage, not a cookie, and the
 * footer's Cookies button asks again. Saying no after yes stops the counting and removes Google's cookies. Without
 * JavaScript the bar never shows and nothing is counted. tests/site.test.ts runs this against a pretend page.
 */

export const MEASUREMENT_ID = 'G-E4566ST899'; // the Polydance property's polydance.net stream
export const KEY = 'polydance-analytics';
export const TAG = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;

/** What a stored answer means: count this visit, leave it alone, or ask. */
export const decide = (stored) => (stored === 'yes' ? 'count' : stored === 'no' ? 'none' : 'ask');

/** Loads Google's tag once, or lets it count again after a no. */
function count(win, doc) {
  win[`ga-disable-${MEASUREMENT_ID}`] = false;
  if (win.gtag) return;
  win.dataLayer = win.dataLayer || [];
  // gtag.js reads each call as an arguments object, the way Google's own snippet pushes it.
  win.gtag = function gtag() { win.dataLayer.push(arguments); };
  win.gtag('js', new Date());
  win.gtag('config', MEASUREMENT_ID);
  const script = doc.createElement('script');
  script.async = true;
  script.src = TAG;
  doc.head.append(script);
}

/** Stops the tag and removes the cookies it set (_ga and _ga_<stream>, on this host or the site's own domain). */
function stop(win, doc) {
  win[`ga-disable-${MEASUREMENT_ID}`] = true;
  const host = win.location.hostname;
  const names = doc.cookie.split(';').map((c) => c.trim().split('=')[0]).filter((n) => n === '_ga' || n.startsWith('_ga_'));
  for (const name of names) {
    for (const domain of ['', `; domain=${host}`, `; domain=.${host.replace(/^www\./, '')}`]) doc.cookie = `${name}=; max-age=0; path=/${domain}`;
  }
}

export function runConsent(win = window, doc = document) {
  const bar = doc.getElementById('consent');
  const again = doc.getElementById('consent-again');
  if (!bar) return;
  // Some browsers refuse storage; then the bar asks on each visit.
  let storage = null;
  try { storage = win.localStorage; } catch { /* asked again next visit */ }
  const stored = (() => { try { return storage?.getItem(KEY) ?? null; } catch { return null; } })();

  bar.addEventListener('click', (event) => {
    const answer = event.target.closest?.('[data-consent]')?.dataset.consent;
    if (answer !== 'yes' && answer !== 'no') return;
    try { storage?.setItem(KEY, answer); } catch { /* kept for this page only */ }
    bar.hidden = true;
    if (answer === 'yes') count(win, doc); else stop(win, doc);
  });
  if (again) {
    again.hidden = false;
    again.addEventListener('click', () => { bar.hidden = false; bar.querySelector('[data-consent]')?.focus(); });
  }

  const now = decide(stored);
  if (now === 'count') count(win, doc);
  if (now === 'ask') bar.hidden = false;
}

if (typeof document !== 'undefined') runConsent();
