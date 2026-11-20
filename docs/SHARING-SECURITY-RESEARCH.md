# Sharing and access: how other apps do it

Research date: 12 November 2026, at Robin's request after the auth audit ([HOSTED.md](HOSTED.md#who-can-reach-whose-recordings-auth-audit-2026-11-12)),
to check Polydance's threads, invitations, recordings and tokens against what established products do.
Every source was read that day on public pages; nothing was signed into. First-party (FP) means the vendor's own
documentation or specification; third-party (TP) is marked. Researched by a Claude subagent; written up and
compared with the code by Claude. This is a comparison and a list of proposals, not a statement of what is built:
what is built is in [THREADS.md](THREADS.md) and the roadmap.

## What Polydance does, against the patterns

| Area | Polydance (2026-11-12) | Most products | Verdict |
| --- | --- | --- | --- |
| People added later | See only what came after (`POLYCAP_NEW_MEMBER_HISTORY`, default `hidden`), receiver-wide | Split: work chat shows everything, encrypted messengers nothing; a setting per conversation or a choice per add | In line with the stricter half |
| Changing that setting | Applies at once to all past messages | Matrix fixes each message's visibility by the setting when it was sent, so loosening later exposes nothing | **Differs**: turning `visible` on reveals history to everyone already added |
| Removed people | Lose the whole thread at once | Matrix and Teams: keep what they saw, nothing after; Google Chat: lose it all | Stricter than most; fine |
| Files and media | Photos, models and video are reached only through a thread they may read, per message | Zulip and Slack gate files like messages; Matrix only requires a login | In line with the best |
| Invitation by email | The email carries no credential; access needs the address confirmed in-app, one confirmed address one person (since 2026-11-12) | GitHub: accept only with the invited address verified; Notion: one address one account; Figma: link not tied to an account | In line with the strongest (GitHub, Notion) |
| Invitation lifetime | An invited address stays invited until taken out | GitHub invitations expire after 7 days; Drive visitor access 7 days | **Differs** |
| Sharing a recording outside a thread | Not possible: no public links | Loom and Frame.io default to anyone with the link; restricted modes need sign-in with the named email | Stricter; keep it |
| Tokens | Scopes, project limits, optional thread scope, only hashes kept; no expiry | GitHub: per-resource, per-permission, expiry required (form) or 30 days; GitLab: 365 days default | **Differs**: no expiry, and thread scope is opt-in |
| Hidden things | The same 404 as a thing that does not exist | GitHub does the same; OWASP: deny by default, check every object | In line |
| Revocation | Membership changes at once; a blocked Meta tester only at the next restart | ASVS 8.3.2: permission changes take effect immediately | **Differs** for Meta blocks |

## Proposals, most useful first

Robin chose 1 and 2 the same day, then 3; all three built and live that day (receiver `40c7304` and since; THREADS.md,
HOSTED.md Tokens). 4 to 7 wait for his choice.

1. **Make thread scope the default for anyone outside the team** (the audit's open choice). GitHub and OWASP both say least
   privilege by default. `polycap token new` could refuse to make a token without `--member` unless told it is the team's
   own (`--team`), so the safe kind is what you get by forgetting a flag.
2. **Record the history choice when someone is added, not when the thread is read.** Then changing the receiver's setting
   later would not reveal earlier messages to people already added (Matrix's rule), and the team could choose per add, as
   Teams does (none, the last N days, all) and WhatsApp does (send the last 25 to 100 messages). Today's rule reads the
   setting at every request; it would keep its meaning for entries without a recorded choice.
3. **Expire tokens.** An optional `expiresAt` on each grant, refused when past, and `polycap token new` setting one by
   default (GitHub suggests 30 days, GitLab 365). Robin's own device tokens could be made without one on purpose.
4. **Revoke a blocked tester at once**, without a restart (ASVS 8.3.2), by re-reading the block list or by a team route.
5. **One confirmed address, one person, for Google sign-in too**, before Google sign-in goes live: the address Google
   verifies is set on the person without asking whether someone else has confirmed it (`google-testers.ts`). Notion keeps
   each address to one account.
6. **Expire invitations that were never taken up**, for example after 30 days, as GitHub (7 days) and Drive do.
7. **Members inviting** (the audit's other open choice) matters less now: someone a tester adds sees only what follows.
   Slack lets any member of a private channel add people; Google Chat lets the organisation decide. Keeping it is in
   line with them.

## 1. What people added later can see

- **Matrix** (FP, spec.matrix.org, "Room History Visibility"): four settings: `world_readable`, `shared` (all history),
  `invited` (from the invitation), `joined` (from joining). The setting in force when each event was sent decides, so
  loosening it later reveals nothing earlier. Someone who leaves keeps what they could see then, nothing after. The
  default is `shared`, kept for backwards compatibility, and the spec warns that it exposes all history. Media: since
  v1.11 a download needs a logged-in user, but not membership of the room.
- **Microsoft Teams** (FP, support.microsoft.com, group chat overview and removing someone): the person adding someone
  to a group chat chooses how much history they get; the options (none, the past N days, all) are described in
  Microsoft Q&A answers (TP). Someone removed keeps what they could already see and gets nothing new.
- **Telegram** (FP, core.telegram.org `channels.togglePreHistoryHidden`, and its UI strings): a group setting, visible
  or hidden for new members, changed by admins; it cannot be hidden in public groups. The default was not found first-party.
- **Zulip** (FP, zulip.com/help on channel permissions): private channels have protected history (new subscribers see
  only what follows) or shared history; the organisation sets the default. Uploaded files are served only to logged-in
  users who received them.
- **Slack** (FP, slack.com/help and docs.slack.dev): no history setting; new members of a channel see its history.
  Only members add people to a private channel. File links need a token with `files:read`.
- **Discord** (FP, docs.discord.com): "Read Message History" is a per-channel permission; without it, only messages that
  arrive while you are there.
- **Google Chat** (FP, support.google.com/chat 7664687, 7653881): with history on, people added see earlier messages;
  with it off, they do not. Removed members lose the space's history and files.
- **WhatsApp** (FP, blog.whatsapp.com, 2026-02-19): new members see nothing earlier; since February 2026 whoever adds them
  may choose to send 25 to 100 recent messages, and the group is told.
- **Signal**: no first-party statement found (support.signal.org refuses automated reading); its design implies new
  members see only what follows.

## 2. Invitations by email, and taking over accounts

- **GitHub** (FP, docs.github.com, inviting users to an organization): an invitation can be accepted only by an account
  with the invited address verified; invitations expire after 7 days.
- **Notion** (FP, notion.com/help on sharing and secondary emails): each address belongs to one account; extra
  addresses are verified by a code.
- **Google Drive** (FP, support.google.com/drive 9195194): someone without a Google account gets a code at the invited
  address, and access for 7 days after.
- **Figma** (FP, help.figma.com, accepting invitations): email invitations are not tied to an account, so users are told
  to accept while signed into the right one. The weaker model.
- **Loom** (FP, support.atlassian.com/loom privacy settings): a restricted video plays only for someone signed in with
  an address it was shared with.
- **Pre-hijacked accounts** (FP, Sudhodanan and Paverd, USENIX Security 2022, arXiv 2205.10174): at least 35 of 75 popular
  services let an attacker who knows only someone's address set up an account before them. The root cause is using an
  address before its owner has proved it; the defences include ending other sessions on a password reset, merging
  accounts only after proving control of both, short-lived address-change links, deleting unverified accounts sooner,
  and telling users about security changes. Polydance has no passwords or merges; the classes that apply are using an
  unverified address (it never grants access; verified only by a link or by Google) and a stale address-change link
  (a link confirms only the address the person still has, and a newer one replaces it).

## 3. Sharing recordings

- **Loom** (FP): public by default unless the workspace changes it; also open to the workspace, or restricted to named
  addresses; enterprise plans can expire public links. Settings are per video.
- **Frame.io** (FP, help.frame.io, Shares and Secure Sharing): public shares by default; secure shares (enterprise) limit
  a share to named people, with passphrases, expiry and a download switch; admins can make secure shares the default. A
  share shows only what is in it.

## 4. Tokens

- **GitHub fine-grained tokens** (FP, docs.github.com, managing personal access tokens): one owner per token, chosen
  repositories, each permission read or write; the form requires an expiry and links that fill it in suggest 30 days;
  an organization may require approval and cap lifetimes; tokens unused for a year are removed.
- **Slack** (FP, docs.slack.dev, Tokens and token rotation): ask only for the scopes needed; rotation (12-hour access
  tokens) is opt-in and cannot be turned off again.
- **GitLab** (FP, docs.gitlab.com): new tokens expire by default (365 days) under an admin cap; its developer docs record
  tokens stored as SHA-256 hashes, as Polydance stores them.

## 5. General guidance

- **OWASP Authorization Cheat Sheet** (FP): least privilege, deny by default, check every request and every object,
  unguessable ids are not authorization, enforce on files too, fail safely, log authorization events.
- **OWASP ASVS 5.0, V8** (FP, github.com/OWASP/ASVS): 8.2.2 a permission for each data item (IDOR); 8.3.2 permission
  changes take effect immediately (level 3); 8.4.1 tenants kept apart.
- **404 or 403** (FP, docs.github.com REST troubleshooting): GitHub answers 404 for private things so as not to confirm
  they exist.

## Sources that did not answer

support.discord.com and support.signal.org refuse automated reading (403); faq.whatsapp.com rendered empty; telegram.org/faq
and the current Slack Connect page say nothing on history; the older Teams "add someone to a group chat" page is gone (404).
Teams' preselected option, Telegram's default and Signal's rule were not found first-party.
