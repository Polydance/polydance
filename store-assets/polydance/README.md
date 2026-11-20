# Polydance — Meta store artwork

Created 2026-10-08 for Polydance's first Meta app record (1593561244982561, made under the wrong team and
removed); the same files are for app **1300818073125870** since 2026-10-12. Public name: **Polydance**.
Open **PREVIEW.jpg** to see the set. Upload only the individual PNGs inside **upload/**.

Redrawn 2026-11-11 with the ballerina and the accents in the deck's orange (the `logo` token in
`design/tokens.json`) instead of pink, by `python3 -I design/logo.py`. Uploaded the same day to app
1300818073125870's draft submission (App Metadata → Assets: landscape, square, portrait, hero, icon and logo) and
saved, not submitted for review. Screenshots and the spatialized tile are still empty.

The icon, the logo's tile and the spatial pair were redrawn later on 2026-11-11 as the app icon every platform has,
the Mac's dock icon (Robin: "Can we ensure that style of icon is used across every platform"). `build.py` imports
`design/icons.py` for them, and `python3 -I design/icons.py` runs `build.py` after drawing the other platforms'
icons. The covers are unchanged. The new icon and logo were uploaded to the draft that evening the same way and
saved, not submitted for review. So was the spatialized tile, after `build.py` gained the 512 px pair the dashboard
asks for before the 180 px one (`private/docs/STORE.md`).

## Upload mapping

In the existing **draft** submission: **App Metadata → Assets**. Choose the matching file for each
field and save changes. Do not submit/publish the app. Not all optional slots need filling.

| Meta field | File in upload/ | Dimensions | Mode |
| --- | --- | --- | --- |
| Icon | icon-512x512.png | 512 × 512 | RGB |
| Hero cover | hero-cover-3000x900.png | 3000 × 900 | RGB |
| Cover landscape | cover-landscape-2560x1440.png | 2560 × 1440 | RGB |
| Cover square | cover-square-1440x1440.png | 1440 × 1440 | RGB |
| Cover portrait | cover-portrait-1008x1440.png | 1008 × 1440 | RGB |
| Mini landscape | mini-landscape-1080x360.png | 1080 × 360 | RGB |
| Logo, transparent (optional) | logo-transparent-3200x800.png | 3200 × 800 | RGBA |
| Spatialized tile 512 × 512, background (optional) | spatial-background-512x512.png | 512 × 512 | RGB |
| Spatialized tile 512 × 512, foreground (optional) | spatial-foreground-512x512.png | 512 × 512 | RGBA |
| Spatialized tile 180 × 180, background (optional) | spatial-background-180x180.png | 180 × 180 | RGB |
| Spatialized tile 180 × 180, foreground (optional) | spatial-foreground-180x180.png | 180 × 180 | RGBA |

The icon has square canvas corners and no transparency. The spatialized tile's 512 pair goes in first; the
dashboard takes the 180 pair only after it. Each foreground keeps the dancer inside the dashboard's safe area
(392 px of 512, 138 px of 180), with transparency and no painted shadow. Foreground/background form a pair, not two
store icons.

**These are illustrated marketing covers, NOT screenshots of the app.** The illustration uses the
app's wood, cream faceplate, tape reels, meters, record key and dancer motif; its layout is an original
cover composition, not an exact reproduction of Android UI. No private recordings, room/passthrough
imagery, team messages or third-party screenshots are included.

## Still needed: genuine screenshots

Do not put the covers or PREVIEW.jpg in screenshot fields. Meta's current guide asks for **five
unique actual in-experience screenshots**, 2560 × 1440 RGB PNG, without added titles/marketing text.
These are deliberately not fabricated here. Capture approved, non-private scenes after the store
build is usable, without exposing account details, team messages or passthrough rooms. Trailer/360
preview are also not supplied. Their availability/requirements should be checked in the dashboard.

## Design and source

- Warm charcoal background, cream Avenir Next wordmark, wood-framed recorder and restrained orange
  accent (the logo's colour; pink until 2026-11-11). Title is exactly **Polydance** on all covers. No prices, badges, endorsements or Meta logos.
- `source/polydance-mark.png` is copied from this repository's existing Android logo; its alpha is
  reused as a monochrome dancer in the reel label. Original raster is 256px, so this is not a newly
  recovered vector original. No rights provenance beyond the pre-existing project asset was audited.
- `build.py` is the editable procedural source for layouts and illustration. It uses **Python 3,
  Pillow 10.0.1** and macOS **Avenir Next/Avenir Next Condensed** installed fonts. Fonts are not
  bundled or redistributed. Do not substitute fonts silently if reproducing exact files.
- `manifest.json` records each PNG's dimensions, mode and SHA-256 plus the source mark hash.
- `PREVIEW.jpg` is a contact sheet for reviewing, **not for uploading**.

Rebuild from any working directory:

```sh
python3 /absolute/path/to/this/folder/build.py
```

This writes the known generated outputs inside this folder. No network, server, headset or credential
access is involved. Generation validates dimensions/modes. Final composition was visually inspected;
check Meta's own crop preview/safe-area overlays before saving. Local checks do not certify Meta
approval.

References checked 2026-10-08:
- https://developers.meta.com/horizon/resources/asset-guidelines/
- https://developers.meta.com/horizon/resources/publish-app-metadata/

## App naming

The next local app version is **Polydance 0.14.1 (15)**: launcher label, deck lettering, notifications,
consent and privacy wording use Polydance. Package **net.polydance.capture**, Meta ID, consent version,
keys, CLI/data paths and existing session data remain unchanged. The already uploaded **0.14.0 (14)**
still has its previous label until replaced by a later upload. No build was uploaded or installed by
creating this folder.
