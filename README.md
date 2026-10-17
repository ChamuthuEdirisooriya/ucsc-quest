# Scavenger Hunt

A QR-code scavenger hunt platform. Teams register by scanning a shared start QR, get assigned their own path of milestones, and all paths end at the same final destination. Organisers write the clues, print the QR codes, and follow every team live from an admin dashboard.

## How it works

- **Start QR** — the first scan on a phone registers a team (team name only) and assigns a path. Teams are spread across paths, so with as many paths as teams every team gets a different one.
- **Paths** — every path has exactly the same number of milestones (set per hunt), followed by the shared **final destination** QR.
- **Per-path clues** — a checkpoint can belong to several paths. When it's scanned, the clue shown depends on the team's path, so the same QR can send different teams to different next locations.
- **Partly shared checkpoints** — a checkpoint can be on some paths and skipped by others, so some teams use it and others never see it. The path generator spreads checkpoints evenly across paths, so most checkpoints end up on some paths but not all. The checkpoint overview lists which paths use each one and which skip it.
- **Decoy cards** — each checkpoint has a set of identical-looking QR cards placed together, by default 1 real + 4 decoys. Only one card is real at a time. The real QR moves to a random other card at a random time every 5–10 minutes (you can change the range), and straight after anyone scans it. That way a team can't just watch which card the team before them scanned. A decoy card shows a message such as "Not this one! Keep looking" and never moves a team forward. The finish can have decoy cards too.
- **Standalone decoys** — single fake QR codes, each with its own message, that you can put anywhere.
- **Team identity** — the phone that registers keeps a cookie that identifies the team, so the team should scan with the same phone the whole way. Each team also gets a 6-character team code that can link a second phone if needed.
- **Scan rules** — scanning the next milestone moves the team forward. Re-scanning a milestone they already found shows its clue again. Any other QR (another path's checkpoint, or skipping ahead) shows "not your next stop" and is logged. The finish QR only completes the hunt after all milestones are found.

## Admin dashboard

`/admin/` (password from `ADMIN_PASSWORD`):

- **Live tracking** — leaderboard with progress bars, where each team is heading next, time since their last scan, wrong-scan and decoy counts, a race board per path, and a live activity feed (updates instantly through Server-Sent Events). Click a team to see its route and timeline, rename it, move it to another path, correct its progress, or delete it.
- **Paths & clues** — generate any number of paths from your checkpoint pool (checkpoints are spread evenly, with a different first stop for each path where possible), or build paths by hand. Choose the checkpoint for each milestone and write the clue that QR shows for that path. A checkpoint overview shows which QRs are shared and which are exclusive. Validation blocks going live until every path is complete.
- **QR codes** — add checkpoints (one location per line) with their decoy cards, and add standalone decoys. Change the number of cards at any location, see which card is real at the moment (this updates live), shuffle by hand, and print cut-out cards on A4. Optional placement notes ("Fountain · card 2 of 5") show organisers which cards go together.
- **Settings** — welcome, finish and decoy-card messages, milestone count, decoys per new checkpoint, shuffle timing, and the public base URL encoded in the QR codes.

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
2. **QR codes** tab: add your checkpoint locations. Each one gets 1 real card plus decoy cards.
3. **Paths & clues** tab: generate one path per team you expect, then write the starting clue and the clue for each milestone. Each clue points to that path's next location.
4. **Settings**: set the public URL. Then print the QR cards and put each location's cards together at that spot.
5. Click **Go live**, and watch the **Live tracking** tab.

## Development

```bash
npm run dev
```

```bash
npm test
```

Code layout: `src/game.js` (all game rules), `src/server.js` (routes and API), `src/views.js` (player pages and print sheet), `src/db.js` (schema), `public/admin/` (dashboard), `public/play.css` (player styles).
