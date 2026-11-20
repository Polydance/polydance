# One look on every platform

Polydance looks the same wherever it runs (Robin, 2026-11-06: "standardise this as much as possible across
platforms"). The look is the headset app's, worked out over ten design passes in October 2026
([app/README.md](../app/README.md#the-screen)): a vintage tape recorder in a dark room. The Mac app took it
on 2026-11-06; until then it had a neutral dark look of its own, from the mockups in [MAC.md](MAC.md#the-mvp).

The name is **Polydance** and the logo is the ballerina ([CLAUDE.md](../CLAUDE.md), "Name, logo and look").

## Where the look is kept

[`design/tokens.json`](../design/tokens.json) holds every colour any platform paints with, by name: the
casing, plates, print, wood, lamps, the logo's colour, the avatar colours in order, and the colours inside
the drawn parts (screws, meters, the counter, the record key). It also says what the type is and how the
wood is generated.

`tests/design.test.ts`, part of `npm run check`, fails when a platform drifts from it:

- the headset app's palette (`Retro.kt`) has no colour that is not a token, and each is the token's value;
  its avatar colours (`Avatar.PALETTE` in `InboxViews.kt`) are the tokens', in order;
- the one Swift palette, which the Mac, the iPhone and the Vision Pro share (`mac/Sources/PolydanceShared/Palette.swift`,
  since 2026-11-07), is the tokens exactly; every `Color(hex:)` in the shared parts, the Mac's views, the
  iPhone's screens (`ios/App/Sources/`) and the Vision Pro's panel (`visionos/App/Sources/`) is a token; no Swift view writes a colour as numbers, and no file but
  the shared one declares a palette;
- the receiver's pages (`src/server/privacy.ts`, `start.ts`) use token colours;
- the polydance.net homepage (`site/index.html`, `site.css`, `cabinet.js`) uses only token colours, the parts'
  included.

A new colour goes into the tokens first, then into each platform.

The logo, the ballerina, is drawn in `logo`: the deck's orange, the reels' labels' colour, since 2026-11-11 (Robin:
it had been pink, `#D64F80`). There is one file of it, the headset's
`app/android/app/src/main/res/drawable-nodpi/polydance_mark.png`, and `python3 -I design/logo.py` recolours it from
the token, keeping its facets' light and shade, then redraws everything made from it: the copies for the store
art and the homepage (which the design test holds to the mark byte for byte), every platform's app icon
(`design/icons.py`, below), the store art (`store-assets/polydance/build.py`) and the homepage's link preview. On the
deck's own reel the dancer stays printed in the deck's ink.

### One app icon

Every platform's app icon is the Mac's dock icon (Robin, 2026-11-11: "I like the mac dock icon we've made. Can we
ensure that style of icon is used across every platform"): the dancer in `logo`, 72% of the tile's height and centred
on her outline, over a faint glow of her own colour, on the store art's charcoal, lighter towards the middle.
`python3 -I design/icons.py` draws it in each platform's shape, then runs the store art, which imports it:

| Where | File | Shape |
| --- | --- | --- |
| Mac | `mac/App/Resources/AppIcon.icns` | macOS's icon grid: the rounded square, 824 px of 1024, with a soft shadow |
| iPhone | `ios/App/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png` | the square at 1024 px, opaque; iOS rounds it |
| Vision Pro | `visionos/App/Resources/Assets.xcassets/AppIcon.solidimagestack/{Front,Back}.solidimagestacklayer/Content.imageset/{Front,Back}.png` | visionOS's two 1024 px layers: the charcoal behind, the dancer and her glow in front; visionOS cuts the circle and moves the layers apart as it is looked at |
| Quest and Android XR | `res/mipmap-anydpi/ic_launcher.xml` over `drawable-nodpi/launcher_{background,foreground,monochrome}.png` | an adaptive icon: 108 dp layers, the dancer 52 dp tall inside the 66 dp safe zone; each launcher cuts its own shape, and the white silhouette is Android 13's themed icon |
| Meta store | `store-assets/polydance/upload/icon-512x512.png`, the spatial pair, the logo's tile | the square at 512 px; the spatial pair is the charcoal behind and the dancer in front; the logo has the rounded tile |
| Google Play | none given yet | the same 512 px square is the one to give |
| polydance.net | `site/assets/icon-512.png`, `site/assets/favicon.png` | the square for home screens, which round it; the rounded tile at 64 px in a browser tab |

`design/icons.json` records each file's sha256, and the design test fails when a committed icon differs from it or a
platform stops pointing at its icon. Not app icons, so not in this style: the logo the deck and the pages print (the
bare mark), the Mac's menu-bar dancer (a silhouette macOS tints, also drawn by `icons.py`) and the headset's
notification glyphs (Android's own).

## The look

| | What | Tokens |
| --- | --- | --- |
| Cabinet | Light wooden boards behind everything, two tones, wavy grain, a dark seam with a highlight between boards | `woodLight`, `woodMid`, `woodGrain`, `woodSeam` |
| Plates | Dark faceplates screwed to the cabinet at each corner: a 2 pt edge, square-ish corners | `panel`, `edge`, `screwFace`, `screwRim` |
| Top plate | Brushed cream metal, lettered in brown print | `plateLight`, `plateDark`, `plateEdge`, `print` |
| Casing | The ground of keys, fields and pages | `casing`, `surface`, `edge` |
| Print | Cream for what is read, tan for what is secondary, white print for what is new, burnt brown for lettering on the wood | `cream`, `tan`, `whitePrint`, `burnt`, `hint` |
| Lamps and states | Green ready, red recording or wrong, amber waiting or to try, cyan processing, LED orange uploading | `green`, `red`, `amber`, `processing`, `led` |
| Type | Condensed sans: bold capitals spaced out for printed labels (0.14 em; lamps 0.24, keys 0.12), regular for text; bold typewriter digits on the counter | `type` |

The parts, and where each platform draws them:

| Part | Headset (`app/android/.../capture/`) | Shared Swift (`mac/Sources/PolydanceShared/`) | Where the Mac shows it | Where the iPhone shows it (`ios/App/Sources/`) |
| --- | --- | --- | --- | --- |
| Wood | `WoodDrawable` in `Surfaces.kt` | `Wood` in `Cabinet.swift`, from `RetroLook.wood` | behind the menu, the window and settings | behind every screen (`DeckScreen`, `ThreadScreen`, `RecordingsScreen`, `SettingsScreen`) |
| Plate and screws | `PlateDrawable`, `Screws` | `PlateBackground`, `Screw`, `.plate()` | the control panel, the window's panels, settings | the control panel, the thread's title and messages, Recordings' cards, settings, pop-ups |
| Cream top plate | `DeckView` (with the reels) | `CreamPlateBackground`; `TopPlate` in `TopPlate.swift` adds the reels, POLYDANCE round the left one, the ballerina on the right one's label, the tape's readout and list key, the bug key and the gear | the menu's header (no reels) | the deck's top (`DeckScreen`), the reels turning while recording |
| Lamp | `Lamp` in `DeckViews.kt` | `Lamp` in `Deck.swift` | READY, PROCESSING, REC | UPLOAD, PROCESSING, REC, READY (`PhonePanel`) |
| Record key (REC, STOP, busy, unavailable) | `RecordKey` | `RecordKey` (`word:` prints another, such as FULL) | the control panel | the deck and the REC screen's foot (`PhonePanel`, `RecordingScreen`) |
| Rolling counter | `RollingCounter` (minutes and seconds) | `RollingCounter` (adds an hours drum past an hour) | the control panel | the deck and the REC screen |
| Needle meter | `VuMeter` in `RetroViews.kt`, with the track switch | `NeedleMeter`, with the track's name on the strip, or (given a `toggle`, since 2026-11-12) the headset's bat-handle OFF/ON switch on a taller strip, its metal in the `switch…` parts | MIC and ARC while recording | MIC, with the input's kind on the strip, on the deck and the REC screen |
| Key | `Retro.button` | `KeyStyle` | everywhere | FLIP, Cancel, Send now, Retry, Delete, the pop-ups' keys |
| Tag (TO TRY) | `tag` in `InboxPane.kt` | `Tag` | rows, pages | rows, messages, Recordings' states |
| Chip | `chip` (and as a switch: a launch's Mic and App sound, amber with a tick when on) | `ChipView`, `LaterTag` in `Pieces.swift` | the menu's Calls and Threads tabs (the window's are folder tabs rising out of its column's panel, `FolderTab` in `MainWindow.swift`, Robin's pick D, 2026-11-16), LATER; as a switch, a launch's Mic and Mac sound (`SoundSwitch` in `ThreadPage.swift`) | LATER in settings |
| Pill (Reply, New thread) | `pill`, the compose key | `PillStyle` (`cream` for the one cream key), `Pill` | Reply, Share, Open Polydance; New thread, the cream key with the red camera at the foot of the window's column (2026-11-16) | Reply (`ThreadScreen`); New thread is the headset's cream compose key with the red camera (`InboxView`) |
| Project list (New thread's IN) | `projectRow`, `newProjectRow` in `InboxPane.kt`, under an amber selector | `ProjectList.swift` in `ios/App/Sources` (built by the Vision Pro too) | chips on New thread's cream plate, + New project last as a dashed chip that becomes a name field with Make (`WindowPlates.swift`, Robin's pick D, 2026-11-16) | in New thread's plate; on the Vision Pro, dropped from the draft's amber selector. One list, each project marked YOURS or TEAM, the chosen one ticked amber, ending in "+ New project", which becomes a name field with Make: the fourth of four mockups, Robin's pick on 2026-11-13 |
| Label (Connect your agent, 2026-11-20) | `labelPlate`, `creamKey` in `InboxPane.kt`: the top plate's cream with the reels' orange along its top, lettered in `print` and `burnt`, its keys cream, the one to press edged orange; the code in the counter's type | (not shared: `LabelPlate`, `CreamKeyStyle` in `visionos/App/Sources/AgentsPage.swift`) | (none) | (none); on the headsets, the card at the top of the inbox, the card in the Welcome's answer and the Agents page ([THREADS.md](THREADS.md#the-headsets-built-2026-11-20), Robin's picks D and C) |
| Avatar and stack | `Avatar`, `AvatarStack` in `InboxViews.kt` | `Avatar`, `AvatarStack` | rows, messages | rows, messages |
| Thread row | `threadRow` | `ThreadRowView` in `Pieces.swift` | the menu and the window's column | the inbox (`InboxView`) |
| Transfer strip (an upload on its way) | `LedStrip` in `InboxViews.kt`: twenty segments, `uploading` lit, cyan while processing | (not shared: `TransferStrip` in `ios/App/Sources/UploadViews.swift`, twenty segments in `led`, dimmed to 40% once nothing has moved for 20 s) | (none) | under the thread's row and on its message, a row of its own at the top of the inbox for a take with no row, and Recordings' cards (Robin's pick, 2026-11-14) |
| Icons | `Glyph` in `Icons.kt`, `GearIcon`, `BugIcon` in `RetroViews.kt` | `Glyph`, `IconKey`, `GearIcon`, `BugIcon` in `Glyphs.swift` | `BugIcon` on the column's Report key and the report's plate, `Glyph(.camera)` on New thread (2026-11-16); system symbols elsewhere still | the search bar, the drawer, a thread's top bar and Reply, the top plate |
| Control panel | the black panel in `MainActivity.kt` | (not shared: each platform arranges its own) | `ControlPanel.swift` in `mac/Sources/PolydanceCapture/Views/` | `PhonePanel.swift` |
| Pop-up | `AlertDialog`, `plateDialog` | (not shared) | system alerts | `PlateDialog.swift`: the report (B1), Cancel, Delete |

Three things are computed, so the Mac and the iPhone compute them exactly as the headset does (`RetroLook` in
`mac/Sources/PolydanceShared/`, tested by `PolydanceSharedTests`): the wood, from `java.util.Random(1966)` ported bit for bit; a
person's colour when they have none of their own, `avatars[(String.hashCode(name) & 0x7fffffff) % 6]`; and
a thread row's time, `14:06` today, `5 Nov` this year, `5 Nov 2025` before.

## On each platform

- **Headset (Quest and Android XR):** the source of the look. `Retro.kt` names the colours and type,
  `Surfaces.kt`, `DeckViews.kt`, `RetroViews.kt`, `InboxViews.kt` and `Icons.kt` draw the parts. A change
  here is shared code: build, test and lint both flavours ([app/PLATFORMS.md](../app/PLATFORMS.md)).
- **Shared Swift (`PolydanceShared` in `mac/Package.swift`, macOS 15 and iOS 26, since 2026-11-07):**
  `Palette.swift` (the tokens), `Theme.swift` (what each colour is for, and the fonts: the system font at
  condensed width, Courier New for the counter, monospace only for paths and ids), `Cabinet.swift`,
  `Deck.swift`, `Pieces.swift` (labels, chips, keys, cards, the thread row, how times are written),
  `RetroLook.swift`, and the thread models. Nothing in it uses `Process`, AppKit or UIKit. The iPhone app
  depends on it through `ios/project.yml`; `swift build` on the Mac builds it with the rest of the package.
- **Mac:** the shared parts, plus its own `ControlPanel.swift` (Mark, Discard and the hot keys) and
  `Logo.swift` (the menu-bar icons and the logo as an NSImage). The menu is the deck: the cream top plate with the logo, the control
  panel (READY and PROCESSING lamps, the counter, the REC lamp, MIC and ARC meters while recording, the red
  key with Mark and Discard), then calls and threads on a black panel behind two chips. The main window is
  the headset's one panel: a black column of calls and threads and the page on a black panel, set into
  the wood, with no title bar or toolbar. The cabinet runs to the window's top edge: the traffic lights sit on
  the wood with the column's header (logo, name, Refresh) beside them in their row, which moves the window,
  and the page's panel starts 10 points down. The column opens 390 points
  wide; dragging the wood between the panels changes it (320 to 560, kept) and a double-click puts it
  back. Keys, pills, chips and tags never wrap or shrink: the text beside them gives way. Settings are two black panels
  on the wood. `./build.sh snapshots <dir>` draws all of it into
  PNGs without hardware.
- **Vision Pro (since 2026-11-12, [VISIONOS.md](VISIONOS.md)):** the headset's own panel, drawn from the shared parts:
  the deck 420 points wide on the left (the top plate, and the black panel with the MIC and APP meters carrying their
  switches, the lamps and counter, the red key), the threads and the open thread beside it, all on the wood in a plain
  window with rounded corners. The same parts as the iPhone, at the headset's sizes; nothing is drawn only for it.
- **iPhone (since 2026-11-07, [IPHONE.md](IPHONE.md)):** only the shared parts and `Palette`; the design
  test refuses a palette of its own. The screen is the headset's deck shrunk to the top of a phone (Robin,
  2026-11-06): the cream top plate with the reels, the bug key and the gear, the black control panel, and the
  inbox under it on a black panel, its search bar and section line on the wood. REC fills the screen with
  the camera and puts the counter, the meter, FLIP, STOP and Cancel on a black strip along the foot. A
  thread, Recordings and the settings open over the deck on the wood, with their keys printed in burnt brown
  as the cabinet's lettering is. `npm run ios -- snapshots <dir>` draws every screen in the Simulator from
  samples.
- **Receiver pages:** the privacy page uses the tokens: print on the cream plate by day, cream on the
  casing at night. Its text stays in `system-ui`, which reads better at length than a condensed face.
- **polydance.net (`site/`, Robin's pick of 2026-11-10, `private/docs/SITE.md`):** the page is
  the cabinet. The app's wood is behind everything, painted by `cabinet.js` from the same
  `java.util.Random(1966)` as `WoodDrawable`, with plain boards in CSS without JavaScript. Each section is a
  dark plate with a screw in each corner. The hero is the deck, drawn in SVG from the parts' tokens in the shape of
  a TEAC A-3340S reel-to-reel (from Robin's photo; Robin chose the cream look of four styles on 2026-11-12, the others
  being brushed steel, a dark transport and a line drawing): the cream top plate as the transport between walnut
  cheeks of the cabinet's darker wood, two clear five-spoke reels with the orange label rising above it (the
  ballerina on the right one), the tape over two guides and the heads, POLYDANCE on the head cover, the counter, and
  three toggles for what a recording becomes (VOICE, FRAMES, MARKS); below, the dark control panel with the MIC
  and APP meters, the REC, READY and PROCESSING lamps, a level knob and the transport keys, play down and REC lit.
  While the page is open the reels turn, the REC lamp blinks, the needles move and the counter counts, all still
  under reduced motion. The lamps are the three
  steps of "How it works", and the record key is the call to action. Above those steps the story is played
  (`story.js`, Robin's pick of three on 2026-11-12, with a printer): the headset's picture on a dark plate with what
  you say coming up beside it on cream plaques, the same deck recording it smaller, and a dot-matrix printer in the
  transport's cream, joined by a cable, feeding the storyboard out on tractor-feed paper (sprocket holes, faint
  green bars, markers in red as from a two-colour ribbon). The page's markup is its end, the storyboard printed. Nothing is printed straight on the wood (Robin,
  2026-11-11): the headline, the lede and the calls to action sit on a plate of the cream top plate's metal, small
  labels on plaques of it, and the footer is a plate like the header. The cookie bar for Google Analytics (`analytics.js`, 2026-11-12) is a dark plate held at the foot of the window, Allow and No thanks both the dark key so neither is the easy one. That plate and the deck stand the same
  height: between the transport and the panel a strip of the transport's plate grows to it (`.deck-fill`, its
  cheeks drawn stretched and its brushed lines in CSS). The calls to action are the deck's keys, the red record key and a dark one (casing to panel,
  cream print), with the tokens' key spacing. The type is the condensed
  sans the visitor's system has (`type.fonts.site`): a page read at length, but short, and printed like the
  deck's labels.
  "Where it runs" shows each platform's device as a line drawing on a key (a headset, glasses, a laptop, a
  phone), not the makers' logos, whose owners restrict their use (Robin chose the drawings, 2026-11-11).
- **Store art** (`store-assets/polydance/build.py`): an illustration of the deck with its own charcoal
  and cream; the ballerina is the same file, and its accents are the `logo` token. Its other colours are not
  checked against the tokens.

## Where the Mac still differs, and why

- **Sizes:** the headset's sizes are read across a room; the Mac's are about two thirds, read at arm's
  length.
- **No reels in the menu:** a menu has no room for the deck's top plate, so the cream plate carries only
  the logo, the name and the gear.
- **Meters have no OFF/ON switch:** the Mac chooses its tracks by itself; the strip names the track.
- **Native controls keep macOS's shapes:** switches (tinted amber), pickers and text fields. The headset's
  bat-handle toggles are not drawn on the Mac.
- **A long title takes a second line in the window's column**, where the headset's row keeps one: at the
  column's usual width a one-line title was cut after a dozen letters (Robin, 2026-11-07). The menu, a
  fixed width, keeps one line as the headset does.
- **The sidebar's rows are buttons** that light the open row in the surface colour as the headset does,
  rather than a list selection drawn in the system's accent colour; arrow keys no longer move through
  them.

## Where the iPhone differs, and why

- **Sizes** are the Mac's, near enough: the phone is read at arm's length too. The top plate is shorter than
  the headset's (146 points), so the reels are smaller, and the bug key and gear sit in its corner clear of
  the right reel and the screw.
- **The top plate's screws are the dark ones** of the shared cream plate, where the headset's deck has
  lighter ones; one cream plate on the Mac and the iPhone.
- **The control panel is laid out for a phone's width:** the four lamps and the counter in one row, the MIC
  meter beside the red key, and Cancel on the REC screen only, beside STOP, since a take is recorded there.
- **Native controls keep iOS's shapes** where they are iOS's own: the search field's caret and keyboard,
  scrolling, and the system back gesture where iOS gives it.

## Verified

- 2026-11-12, How it works played (`site/story.js`, live on polydance.net the same day, `private/docs/SITE.md`): `npm run check` passed 589 tests, with
  `tests/site.test.ts` checking the story's phases and that the page without the script shows it printed. In the
  desktop app's browser pane at 1440 and 1000 px the three columns stood side by side with the cable reaching the
  printer, and at 375 px they stacked with the cable hidden and nothing wider than the screen; it played recording,
  PROCESSING and printing with the console empty. A copy of the page without its scripts, drawn by headless Chrome,
  showed the storyboard printed. Not seen on a real phone, or in Safari or Firefox.

- 2026-11-12, the homepage's TEAC-shaped deck (`site/`, live on polydance.net the same day, `private/docs/SITE.md`): `npm run check` passed 588 tests, among them the
  design test reading every colour in the deck as a token. Measured in the desktop app's browser pane: the
  words' plate and the deck the same height at 1440, 1200, 1000 and 880 px wide (515, 515, 579 and 589 px; the
  growing strip 18 px at the widest, 209 px at 880), stacked at 375 px with nothing wider than the screen; the two
  needles swing apart. Drawn by headless Chrome at 1440 and 1000 px, where the strip's cheeks meet the drawn ones
  without a step. Not seen on a real phone, or in Safari or Firefox.

- 2026-11-11, the homepage (`site/`, not deployed): `npm run check` passed 546 tests, among them the design
  test's check of the site's colours and `tests/site.test.ts` (nothing fetched from elsewhere, links only where
  its README says, and `JavaRandom` gives `Random(42)`'s published `nextInt()` and `nextFloat()`). Drawn by
  headless Chrome at 1440 px wide, at 375 px in a frame, and without its script (plain boards, a still deck);
  shown in the desktop app's browser pane, where its content security policy refused nothing and the
  console was empty. Live on polydance.net the same day and drawn there by headless Chrome. Not seen on a real
  phone, or in Safari or Firefox.

- 2026-11-07, the iPhone's screens (in the Simulator, iPhone 17 on iOS 26.3.1; not yet on the phone):
  `npm run ios -- snapshots` drew the deck with samples and as it is, REC, a thread, Recordings, the
  settings, the report pop-up, the drawer and the New thread note, and they were compared by eye with the
  Mac's pictures and with the headset's drawing code (`DeckView`, `Glyph`, `GearIcon`, `BugIcon`), not with
  pictures of a headset. The design test reads the iPhone's sources: every colour in
  them is a token and none declares a palette. The Mac's five pictures still had 0 differing pixels after
  `TopPlate`, `Glyphs` and the reels' tokens were added to the shared target.

- 2026-11-07, phase I1 ([IPHONE.md](IPHONE.md)): the look moved from the Mac app into `PolydanceShared`.
  `npm run mac -- snapshots` drew the same five pictures before and after with 0 differing pixels (the
  snapshots are drawn at a fixed moment, `lookTime`, so the pulsing lamps and the recording key's glow match
  between runs; two runs before the move also gave 0). `npm run mac -- test` passed 151 tests (5 snapshot
  tests skipped without `POLYDANCE_SNAPSHOTS`); `npm run check` passed 505 tests with the design test reading
  the shared palette; `xcodebuild` compiled `PolydanceShared` for iOS and the iOS Simulator, and
  `npm run ios -- check` compiled the iPhone app with it.

- 2026-11-06: `npm run check` with `tests/design.test.ts` (5 tests): `Retro.kt`'s 25 colours and 6 avatar
  colours match the tokens; `Palette.swift` matches exactly; every colour in the Mac's views is a token;
  the privacy page's are. `swift test`: `RetroLookTests` give `java.util.Random(42)`'s published
  `nextInt()` (-1170105035) and `nextFloat()` (0.7275637), and `"hello".hashCode()` (99162322). The Mac's
  parts, control panel, menu, thread rows and window were drawn by `./build.sh snapshots` and compared by
  eye with frames of the headset app 0.19.0 (Android XR, recordings of 2026-11-05). Not compared on a
  Quest; the Mac app's own windows were not seen on screen from this session (only through the snapshots).
