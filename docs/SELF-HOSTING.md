# Running your own receiver

**Untested by anyone outside the team (written 2026-11-20).** The receiver below is the same code and the same
Docker image that runs capture.polydance.net, which has served real recordings since 2026-10-01. But no one has yet
followed these steps on a server of their own, so expect rough edges, and please report them.

The receiver is `polycap serve`: it takes uploads from the headset app, builds each recording into a bundle (the
transcript, frames and storyboard a coding agent reads), keeps threads between people and agents, and lets
`polycap sync` bring bundles down to your machine. [HOSTED.md](HOSTED.md) describes it in full, and
[THREADS.md](THREADS.md) describes threads.

## Do you need one?

- **Just you, with developer mode on your headset:** no server at all. `polycap pull` copies recordings over adb and
  builds the bundles on your machine, with whisper.cpp for the words ([README](../README.md#install)).
- **You and testers, without running anything:** the hosted service at capture.polydance.net, which the official Quest
  build talks to. Ask to join at polydance.net.
- **Your own server, your own models, your data on your machine:** read on.

## What works with your own receiver today

| Client | With your receiver | How |
| --- | --- | --- |
| `polycap` (sync, threads, upload, the skill) | Yes | `POLYCAP_REMOTE_URL` and a token, below |
| Quest or Android XR, a build you make yourself | Yes, with developer mode | Build from source, install over adb, `npm run app -- configure` |
| Quest, the official store build | **No** | It talks only to capture.polydance.net, refuses a new address from adb, and its Meta sign-in works only with the receiver that holds Polydance's app secret |
| iPhone, built yourself | Yes | `npm run ios -- pair --server URL` shows a QR code ([IPHONE.md](IPHONE.md)) |
| Mac app | Yes | It runs your `polycap` |

So a tester without developer mode cannot use your receiver yet. Pairing the official builds with any receiver, by
typing an address and a one-time code on the headset, is planned and not built.

## 1. The server

You need a Linux host with Docker, a domain name pointing at it, and nginx (or another proxy) for TLS. The headset's
release builds speak HTTPS only; a debug build may use plain HTTP to a 192.168, 10 or 172.16 address on your network,
which is how the receiver was first tested.

Build the image from the repository's root:

```sh
docker build -f deploy/receiver/Dockerfile -t polycap-receiver .
```

The image runs `polycap serve` on port 8790, keeps everything under `/data`, and sets `TZ=Europe/London`, because
session ids are local time; set `TZ` to your own zone in the env file.

## 2. The env file

Keep it on the host, owned by you, mode 600. Every setting, its default and what it sends where is in
[.env.example](../.env.example). The smallest useful one:

```sh
TZ=Europe/Paris
# none: no transcript; gladia: the narration goes to Gladia with your key. The image has no whisper.cpp.
POLYCAP_TRANSCRIBER=gladia
GLADIA_API_KEY=your-gladia-key
# Threads need at least one project.
POLYCAP_PROJECTS=[{"key":"APP","name":"My app"}]
POLYCAP_USERS=[{"id":"me","name":"Me","colour":"#d93a2b"}]
# Filled in by step 3.
POLYCAP_SERVER_TOKENS=[]
```

Off unless you set them, and each sends something to a third party, so read its line in `.env.example` first:
summaries and pointing (`POLYCAP_SUMMARIZER=claude`, `POLYCAP_POINTING=claude`, with your Anthropic key), email
invitations (`POLYCAP_MAIL`), the Welcome thread for newcomers (`POLYCAP_WELCOME`), Meta and Google sign-in (which
only work with app records of your own, and an app built with them).

## 3. Tokens

Each device and agent has its own token. On your own machine, with this repository:

```sh
npm install
npm run polycap -- token new --id quest --team --scope upload --user me --expires never
npm run polycap -- token new --id laptop --team --scope read --scope post --user me
```

Each prints the token once, and a JSON entry. Put the entries, never the tokens, into `POLYCAP_SERVER_TOKENS` as a
JSON list. Keep each token in a file of its own, mode 600. A token for someone outside your team is made with
`--member --user ID` and sees only the threads they are added to ([HOSTED.md, Tokens](HOSTED.md#tokens)).
`deploy/receiver/add-token.py` adds an entry to an env file on the host.

## 4. Run it

```sh
docker run -d --name polycap-receiver --restart unless-stopped \
  --env-file /path/to/receiver.env -v polycap-data:/data -p 127.0.0.1:8790:8790 polycap-receiver
```

Then put nginx in front of it: [deploy/receiver/nginx-site.conf.example](../deploy/receiver/nginx-site.conf.example) is
the site capture.polydance.net runs, with its routes, upload limits and the ACME webroot for certificates. Change
the `server_name` to yours. Check it with `curl https://your-host/v1/health`; every other `/v1` route answers 401
without a token.

Storage: a recording is about 64 MB per minute at the default picture quality. Each upload token has an allowance
(8 GB unless `POLYCAP_ALLOWANCE_BYTES` says otherwise), and past a high mark the oldest finished recordings are
deleted ([HOSTED.md, Storage](HOSTED.md#storage)). Size the volume for that.

## 5. The headset

The official store build cannot be pointed at your receiver, so build your own. It needs JDK 17, the Android SDK, a
Quest in developer mode and adb ([app/PLATFORMS.md](../app/PLATFORMS.md)).

```sh
npm run app -- keystore
```

```sh
npm run app -- build --platform quest
```

```sh
npm run app -- install --platform quest --launch
```

```sh
npm run app -- configure --server https://your-host --token-file ~/path/to/quest.token
```

`keystore` makes your own signing key, which every build is signed with; back it up. Your build has the same package
id as the store's (`net.polydance.capture`) but another key, so Android will not install it over the store's copy:
uninstall that first, and its recordings with it. If you give your build to other people, change the package id and
the name ([TRADEMARKS.md](../TRADEMARKS.md)).

## 6. Your machine and your agent

In `~/.config/polycap/env` (mode 600):

```sh
POLYCAP_REMOTE_URL=https://your-host
POLYCAP_REMOTE_TOKEN=the-laptop-token
```

`polycap sync` then brings finished bundles into `~/PolydanceCapture/sessions`, and `polycap thread list` shows your
threads. [AGENT-SETUP.md](AGENT-SETUP.md) sets up a coding agent with the skill.

## Updating

Pull the repository, build the image again, and replace the container with the same env file and volume. Keep the
old container stopped until the new one answers `/v1/health`, so you can go back. Nothing in `/data` is migrated by
hand. The receiver checks its settings when it starts and stops with a message if one is malformed, so read
`docker logs` after each swap.

If you run it, tell us what broke: an issue on the repository, or the contact on your receiver's `/privacy` page
for anything about security ([SECURITY.md](../SECURITY.md)).
