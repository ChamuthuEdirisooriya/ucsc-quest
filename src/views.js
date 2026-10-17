// Server-rendered pages for players (opened by scanning a QR with a phone camera)
// and the printable QR sheet for organisers.

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout({ title, body, huntName = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f3ecdf">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/play.css">
</head>
<body>
<main class="sheet">
  ${huntName ? `<p class="eyebrow">${esc(huntName)}</p>` : ''}
  ${body}
</main>
</body>
</html>`;
}

function progressTrack(progress, total, finished) {
  const dots = Array.from({ length: total }, (_, i) => {
    const state = i < progress ? 'done' : i === progress && !finished ? 'next' : '';
    return `<li class="${state}"><span>${i + 1}</span></li>`;
  }).join('');
  return `<ol class="track" aria-label="${progress} of ${total} milestones found">
    ${dots}<li class="flag ${finished ? 'done' : progress >= total ? 'next' : ''}"><span>★</span></li>
  </ol>`;
}

const FLASH = {
  found: (q) => ({ tone: 'good', title: `Milestone ${q.n} found!`, text: 'Here is your next clue.' }),
  again: (q) => ({ tone: 'info', title: `You already found milestone ${q.n}.`, text: 'Your current clue is below.' }),
  nope: () => ({ tone: 'bad', title: 'Not your next stop.', text: 'This QR is not what your clue is pointing to. Read it again.' }),
  early: (q) => ({ tone: 'info', title: 'Not so fast…', text: `You have found ${q.n} of ${q.t} milestones. Come back once you have all of them.` }),
  welcome: () => ({ tone: 'good', title: 'Your team is registered!', text: 'Keep using this phone for every QR you scan.' }),
  rejoined: () => ({ tone: 'good', title: 'Phone linked to your team.', text: 'Scans from this phone now count for your team.' }),
};

export function teamPage(view, query = {}) {
  const { hunt, team, total, progress, clue, finished, rank } = view;
  const flash = FLASH[query.s]?.(query);
  const flashHtml = flash
    ? `<div class="flash ${flash.tone}" role="status"><strong>${esc(flash.title)}</strong><span>${esc(flash.text)}</span></div>`
    : '';

  let main;
  if (finished) {
    main = `
      <section class="finish">
        <div class="medal">${rank ? ordinal(rank) : '★'}</div>
        <h1>You made it!</h1>
        <p class="prose">${esc(hunt.finish_message)}</p>
        <dl class="facts">
          <div><dt>Finished</dt><dd>${rank ? `${ordinal(rank)} place` : '—'}</dd></div>
          <div><dt>Time</dt><dd>${esc(duration(team.started_at, team.finished_at))}</dd></div>
        </dl>
      </section>`;
  } else {
    const heading = progress >= total ? 'Find the final destination' : `Find milestone ${progress + 1} of ${total}`;
    main = `
      <section class="clue">
        <p class="label">${esc(heading)}</p>
        <blockquote>${esc(clue) || '<em>Your clue is being written. Ask an organiser.</em>'}</blockquote>
      </section>`;
  }

  const body = `
    ${flashHtml}
    <header class="team-head">
      <h2>${esc(team.name)}</h2>
      <p class="meta">${progress} / ${total} milestones${finished ? ' · finished' : ''}</p>
    </header>
    ${progressTrack(progress, total, finished)}
    ${main}
    ${hunt.status === 'ended' && !finished ? '<p class="note">This hunt has ended. Thanks for playing!</p>' : ''}
    <details class="help">
      <summary>Using another phone?</summary>
      <p>Your team code is <code class="joincode">${esc(team.join_code)}</code>. Scan the starting QR on the other phone and choose “Join an existing team”.</p>
      <p>Only scan with phones linked to your team, or your scans will not count.</p>
    </details>`;
  return layout({ title: `${team.name} · ${hunt.name}`, huntName: hunt.name, body });
}

export function joinPage(hunt, code, { error = '', name = '', joinError = '', joinCode = '' } = {}) {
  const body = `
    <h1 class="title">Ready to hunt?</h1>
    <p class="prose">${esc(hunt.welcome)}</p>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <form method="post" action="/q/${esc(code.token)}/join" class="stack">
      <label for="name">Team name</label>
      <input id="name" name="name" maxlength="40" autocomplete="off" required value="${esc(name)}" placeholder="e.g. The Map Readers">
      <button type="submit">Start the hunt</button>
    </form>
    ${rejoinForm(hunt, { joinError, joinCode, open: Boolean(joinError) })}`;
  return layout({ title: hunt.name, huntName: hunt.name, body });
}

function rejoinForm(hunt, { joinError = '', joinCode = '', open = false } = {}) {
  return `
    <details class="help" ${open ? 'open' : ''}>
      <summary>Join an existing team</summary>
      <p>Already registered on another phone? Enter the team code shown on that phone.</p>
      ${joinError ? `<p class="error" role="alert">${esc(joinError)}</p>` : ''}
      <form method="post" action="/h/${hunt.id}/rejoin" class="stack">
        <label for="code">Team code</label>
        <input id="code" name="code" maxlength="6" autocomplete="off" autocapitalize="characters" required value="${esc(joinCode)}" placeholder="ABC123">
        <button type="submit" class="secondary">Link this phone</button>
      </form>
    </details>`;
}

export function noTeamPage(hunt, opts = {}) {
  const body = `
    <h1 class="title">Start at the beginning</h1>
    <p class="prose">This phone is not linked to a team yet. Head to the starting point and scan the first QR code to register your team.</p>
    ${rejoinForm(hunt, { ...opts, open: true })}`;
  return layout({ title: hunt.name, huntName: hunt.name, body });
}

export function decoyPage(hunt, message, team) {
  const body = `
    <section class="clue decoy">
      <p class="label">A message</p>
      <blockquote>${esc(message) || 'Nothing to see here…'}</blockquote>
    </section>
    ${team ? `<p class="center"><a class="button secondary" href="/play/${hunt.id}">Back to your clue</a></p>` : ''}`;
  return layout({ title: hunt.name, huntName: hunt.name, body });
}

export function messagePage(title, text, { huntName = '', link = null } = {}) {
  const body = `
    <h1 class="title">${esc(title)}</h1>
    <p class="prose">${esc(text)}</p>
    ${link ? `<p class="center"><a class="button secondary" href="${esc(link.href)}">${esc(link.label)}</a></p>` : ''}`;
  return layout({ title, huntName, body });
}

const KIND_LABEL = { start: 'Start', checkpoint: 'Checkpoint', decoy: 'Decoy', finish: 'Finish' };

/** Printable sheet of QR cards. `cards` = [{ code, svg, url, usage }] */
export function printPage(hunt, cards, { labels }) {
  const items = cards.map(({ code, svg, usage }) => `
    <figure class="card">
      <figcaption class="top">${esc(hunt.name)}</figcaption>
      <div class="qr">${svg}</div>
      <p class="scan">Scan me</p>
      <p class="token">${esc(code.token)}</p>
      ${labels ? `<p class="placement"><b>${KIND_LABEL[code.kind]}</b> · ${esc(code.label || 'unlabelled')}${usage ? `<br>${esc(usage)}` : ''}</p>` : ''}
    </figure>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>QR codes · ${esc(hunt.name)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1917; background: #e7e5e4; }
  .bar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 12px 20px; background: #1c1917; color: #fafaf9; font-size: 14px; }
  .bar button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 0; background: #f97316; color: #fff; cursor: pointer; }
  .bar span { opacity: .75; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10mm; width: 190mm; margin: 10mm auto; }
  .card { margin: 0; padding: 6mm 5mm 5mm; background: #fff; border: 1px dashed #a8a29e; text-align: center; break-inside: avoid; }
  .top { font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; color: #57534e; }
  .qr svg { width: 100%; height: auto; display: block; margin: 3mm 0 1mm; }
  .scan { margin: 0; font-weight: 700; font-size: 13pt; }
  .token { margin: 1mm 0 0; font: 8pt ui-monospace, Menlo, monospace; color: #78716c; letter-spacing: .1em; }
  .placement { margin: 3mm 0 0; padding-top: 2mm; border-top: 1px dotted #d6d3d1; font-size: 8pt; color: #44403c; line-height: 1.35; }
  @media print {
    body { background: #fff; }
    .bar { display: none; }
    .grid { margin: 0 auto; }
    @page { size: A4; margin: 10mm; }
  }
</style></head>
<body>
  <div class="bar"><button onclick="print()">Print</button><span>${cards.length} QR codes · cut along the dashed lines${labels ? ' · placement notes are for organisers, cut them off or fold them under' : ''}</span></div>
  <div class="grid">${items}</div>
</body></html>`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function duration(from, to) {
  const ms = new Date(to) - new Date(from);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m ${Math.floor((ms % 60000) / 1000)}s`;
}
