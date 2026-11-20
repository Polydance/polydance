# Reporting a security problem

Polydance carries recordings of people's rooms, voices and calls, so a way to reach someone else's
recordings, threads, photos or tokens is the most serious bug it can have.

Please report it privately to **privacy@polydance.net**, not in a public issue. Say what you did, what you
reached, and which version (the headset app's version, or the receiver's `/v1/health`). You will get an
answer within a few days, and a fix to the hosted receiver at capture.polydance.net comes before anything
is made public.

Please do not test against other people's data on the hosted receiver. Run your own: `polycap serve`
([docs/HOSTED.md](docs/HOSTED.md)) and the end-to-end tests in `tests/` start one on your machine.

What is in scope: the receiver (`src/server/`), `polycap`, and the official builds of the headset, Mac and
iPhone apps. Who can reach what today is written up in
[docs/HOSTED.md](docs/HOSTED.md#who-can-reach-whose-recordings-auth-audit-2026-11-12).
