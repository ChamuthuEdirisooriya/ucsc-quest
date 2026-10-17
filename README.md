# Scavenger Hunt

A QR-code scavenger hunt platform. Teams register by scanning a shared start QR, get assigned their own path of milestones, and all paths end at the same final destination. Organisers write the clues, print the QR codes, and follow every team live from an admin dashboard.

## How it works

- **Start QR** — the first scan on a phone registers a team (team name only) and assigns a path. Teams are spread across paths, so with as many paths as teams every team gets a different one.
- **Paths** — every path has exactly the same number of milestones (set per hunt), followed by the shared **final destination** QR.
- **Per-path clues** — a checkpoint QR can belong to several paths. When it's scanned, the clue shown depends on the team's path, so the same QR can send different teams to different next locations. A checkpoint used by only one path is exclusive to it.
- **Decoys** — extra QR codes that only show a message (e.g. "Nice try!"). They never move a team forward. Printed cards look the same as real ones.
- **Team identity** — the phone that registers keeps a cookie that identifies the team, so the team should scan with the same phone the whole way. Each team also gets a 6-character team code that can link a second phone if needed.
- **Scan rules** — scanning the next milestone moves the team forward. Re-scanning a milestone they already found shows its clue again. Any other QR (another path's checkpoint, or skipping ahead) shows "not your next stop" and is logged. The finish QR only completes the hunt after all milestones are found.

## Admin dashboard

`/admin/` (password from `ADMIN_PASSWORD`):

- **Live tracking** — leaderboard with progress bars, where each team is heading next, time since their last scan, wrong-scan and decoy counts, a race board per path, and a live activity feed (updates instantly through Server-Sent Events). Click a team to see its route and timeline, rename it, move it to another path, correct its progress, or delete it.
- **Paths & clues** — generate any number of paths from your checkpoint pool (checkpoints are spread evenly, with a different first stop for each path where possible), or build paths by hand. Choose the checkpoint for each milestone and write the clue that QR shows for that path. A checkpoint overview shows which QRs are shared and which are exclusive. Validation blocks going live until every path is complete.
- **QR codes** — add checkpoints (one location per line) and decoys (with their message), preview or copy any QR, and print cut-out cards on A4. Placement notes for organisers can be added to the cards.
- **Settings** — welcome and finish messages, milestone count, and the public base URL encoded in the QR codes.

Hunts move from **draft → live → ended**. Players can't play a draft hunt, but a signed-in admin can ("Test as player").

## Running it

Requires Node.js 22.13+ (uses the built-in `node:sqlite`, so there are no native dependencies).

```bash
npm install
```

```bash
ADMIN_PASSWORD=choose-something npm start
```

Open http://localhost:3000/admin/.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `admin` | Dashboard password. **Set this for a real event.** |
| `PORT` | `3000` | HTTP port |
| `DATABASE_FILE` | `data/hunt.db` | SQLite database file |
| `PUBLIC_URL` | (request host) | Base URL encoded in QR codes; it can also be set from the Settings tab |
| `NODE_ENV` | | Set to `production` behind HTTPS to mark cookies `Secure` |

**Before printing QR codes**, make sure their base URL can be reached from players' phones. `localhost` won't work. For a local event, use the machine's Wi-Fi address (the Settings tab suggests it). For a real event, deploy behind HTTPS and set `PUBLIC_URL`.

## Typical setup

1. Create a hunt and choose how many milestones each team visits.
2. **QR codes** tab: add your checkpoint locations, plus a few decoys.
3. **Paths & clues** tab: generate one path per team you expect, then write the starting clue and the clue for each milestone. Each clue points to that path's next location.
4. **Settings**: set the public URL. Then print the QR cards and plant them.
5. Click **Go live**, and watch the **Live tracking** tab.

## Development

```bash
npm run dev
```

```bash
npm test
```

Code layout: `src/game.js` (all game rules), `src/server.js` (routes and API), `src/views.js` (player pages and print sheet), `src/db.js` (schema), `public/admin/` (dashboard), `public/play.css` (player styles).
