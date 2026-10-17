// Server-rendered pages for players (opened by scanning a QR with a phone camera)
// and the printable QR sheet for organisers.
//
// Each screen is built from full-bleed colour "chapters" (see public/play.css):
// blue = your clue, green = found or finished, yellow = decoy or wrong stop,
// cyan = information, navy = the close.

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Loaded without blocking the first paint: on slow campus Wi-Fi the clue shows
// in the system font straight away and switches when General Sans arrives.
const FONT_CSS = 'https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap';

const THEME = { paper: '#f5f6f4', blue: '#00629b', navy: '#002855', green: '#78be20', yellow: '#ffc72c', cyan: '#00b5e2' };

function layout({ title, body, top = 'paper' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${THEME[top]}">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/brand/favicon.png">
<link rel="preconnect" href="https://api.fontshare.com">
<link rel="preconnect" href="https://cdn.fontshare.com" crossorigin>
<link rel="stylesheet" href="${FONT_CSS}" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="${FONT_CSS}"></noscript>
<link rel="stylesheet" href="/play.css">
<script>document.documentElement.classList.add('js')</script>
</head>
<body>
${body}
<script>
  // Parts of each chapter rise in as it scrolls into view (content stays visible without script).
  const io = 'IntersectionObserver' in window && new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -10% 0px' });
  document.querySelectorAll('.reveal').forEach((el) => (io ? io.observe(el) : el.classList.add('in')));
</script>
</body>
</html>`;
}

const logo = '<span class="logo" role="img" aria-label="UCSC IEEE Student Branch"></span>';

function bar(right = '') {
  return `<div class="bar">${logo}${right}</div>`;
}

/** Closing chapter: the hunt's name returns at full width, sitting on the bottom edge. */
function close(hunt, { photoCredit = false } = {}) {
  const name = hunt?.name ?? 'UCSC Quest';
  return `
  <footer class="field f-navy close">
    <div class="inner reveal">
      <div class="row">
        <p class="small">Organised by the UCSC IEEE Student Branch</p>
        ${logo}
      </div>
      ${photoCredit ? `<p class="small credit">Photograph of the UCSC building by Sameera Shaakunthala, <a href="https://commons.wikimedia.org/w/index.php?curid=50611869">CC BY-SA 3.0, via Wikimedia Commons</a>, shown in blue.</p>` : ''}
      <span class="name" style="--fit:${Math.max(4, name.length)}" aria-hidden="true">${esc(name)}</span>
    </div>
  </footer>`;
}

/* ---------------------------------------------------------------- the trace */

// The team's progress drawn in the branch emblem's language: ring pads on a
// copper trace, one per milestone, ending at a larger destination node.
function trace(progress, total, finished) {
  const W = 400;
  const H = 76;
  const y = 38;
  const r = Math.max(5, Math.min(11, 150 / total));
  const R = r + 5;
  const x0 = r + 4;
  const xEnd = W - R - 4;
  const step = (xEnd - x0) / total;
  const xs = Array.from({ length: total }, (_, i) => x0 + i * step);
  const stubs = total <= 12;

  let svg = '';
  // wire: solid up to the last found pad, faint beyond
  const reachedX = progress === 0 ? x0 : xs[progress - 1];
  const doneTo = finished ? xEnd : reachedX;
  if (doneTo > x0) svg += `<path class="wire" d="M${x0} ${y}H${doneTo}"/>`;
  svg += `<path class="wire ahead" d="M${doneTo} ${y}H${xEnd}"/>`;

  xs.forEach((x, i) => {
    const state = i < progress ? 'done' : i === progress && !finished ? 'next' : 'ahead';
    if (stubs) {
      const dir = i % 2 ? 1 : -1;
      const sx = x + step * 0.42;
      svg += `<path class="wire ${state === 'done' ? '' : 'ahead'}" d="M${x} ${y}L${sx} ${y + dir * 24}"/>`;
      svg += `<circle class="pad ${state === 'done' ? 'done' : 'ahead'}" cx="${sx}" cy="${y + dir * 24}" r="${Math.max(3, r * 0.45)}"/>`;
    }
    if (state === 'next') svg += `<circle class="ring" cx="${x}" cy="${y}" r="${r}"/>`;
    svg += `<circle class="pad ${state}" cx="${x}" cy="${y}" r="${r}"/>`;
  });
  const endState = finished ? 'done' : progress >= total ? 'next' : 'ahead';
  if (endState === 'next') svg += `<circle class="ring" cx="${xEnd}" cy="${y}" r="${R}"/>`;
  svg += `<circle class="pad ${endState}" cx="${xEnd}" cy="${y}" r="${R}"/>`;
  svg += `<circle class="pad ${finished ? 'core' : endState}" cx="${xEnd}" cy="${y}" r="${Math.max(2, R - 9)}"/>`;

  return `<svg class="trace" viewBox="0 0 ${W} ${H}" role="img" aria-label="${progress} of ${total} milestones found${finished ? ', finished' : ''}">${svg}</svg>`;
}

/* ---------------------------------------------------------------- team screen */

const FLASH = {
  found: (q) => ({ field: 'f-green', title: `Milestone ${q.n} found`, text: 'Your next clue is below.' }),
  again: (q) => ({ field: 'f-cyan', title: 'Already found', text: `You found milestone ${q.n} earlier. Your current clue is below.` }),
  nope: () => ({ field: 'f-yellow', title: 'Not your next stop', text: 'This code is not the one your clue points to. Read the clue again.' }),
  early: (q) => ({ field: 'f-yellow', title: 'Not yet', text: `This is the final destination, but you have ${q.n} of ${q.t} milestones. Come back with all of them.` }),
  welcome: () => ({ field: 'f-green', title: 'You’re in', text: 'Keep this phone for every code you scan.' }),
  rejoined: () => ({ field: 'f-cyan', title: 'Phone linked', text: 'Scans from this phone now count for your team.' }),
};

export function teamPage(view, query = {}) {
  const { hunt, team, total, progress, clue, finished, rank } = view;

  if (finished) {
    const body = `
    <main class="field f-green finish">
      <div class="inner">
        ${bar(`<span>${esc(team.name)}</span>`)}
      </div>
      <div class="inner rise">
        <p class="rank">${rank ? `${ordinal(rank)}<span class="sr-only"> place</span>` : 'Done'}</p>
        <h1 class="head">You made it</h1>
        <p class="lead" style="margin-top:18px">${esc(hunt.finish_message)}</p>
        <dl>
          <div><dt>Time</dt><dd>${esc(duration(team.started_at, team.finished_at))}</dd></div>
          <div><dt>Milestones</dt><dd>${total} of ${total}</dd></div>
        </dl>
      </div>
      <div class="inner">${trace(total, total, true)}</div>
    </main>
    ${close(hunt)}`;
    return layout({ title: `${team.name} · ${hunt.name}`, top: 'green', body });
  }

  // Only the messages defined above; never inherited keys like `constructor`.
  const flash = Object.hasOwn(FLASH, query.s) ? FLASH[query.s](query) : null;
  const seeking = progress >= total ? 'Find the final destination' : `Find milestone ${progress + 1}`;
  const flashHtml = flash ? `
    <section class="field ${flash.field}" role="status">
      <div class="inner flash rise">
        ${bar()}
        <h2 class="head">${esc(flash.title)}</h2>
        <p>${esc(flash.text)}</p>
      </div>
    </section>` : '';

  const body = `
    ${flashHtml}
    <main class="field f-blue">
      <div class="inner clue-field">
        ${flash ? '' : bar()}
        <div class="teamline"><h1>${esc(team.name)}</h1><span>${progress} of ${total} found</span></div>
        ${trace(progress, total, false)}
        <div class="rise" style="display:grid;gap:14px">
          <p class="seeking">${esc(seeking)}</p>
          <blockquote class="clue">${esc(clue) || 'Your clue is still being written. Find an organiser.'}</blockquote>
        </div>
        ${hunt.status === 'ended' ? '<p class="lead">The hunt has ended. Thanks for playing.</p>' : ''}
      </div>
    </main>
    <section class="field f-paper">
      <div class="inner code-field reveal">
        <h2 class="lead">Using another phone?</h2>
        <p class="joincode">${esc(team.join_code)}</p>
        <p class="text">That is your team code. Scan the starting code on the other phone and enter it under “Already on a team?”. Scans from phones that are not linked to your team do not count.</p>
      </div>
    </section>
    ${close(hunt)}`;
  return layout({ title: `${team.name} · ${hunt.name}`, top: flash ? flash.field.slice(2) : 'blue', body });
}

/* ---------------------------------------------------------------- join (start QR) */

function waterlineTitle(name) {
  const words = name.trim().split(/\s+/);
  let lines = [name.trim()];
  if (words.length > 1) {
    // split where the two lines come out closest in length
    let best = 1;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ').length;
      const b = words.slice(i).join(' ').length;
      const bestA = words.slice(0, best).join(' ').length;
      const bestB = words.slice(best).join(' ').length;
      if (Math.abs(a - b) < Math.abs(bestA - bestB)) best = i;
    }
    lines = [words.slice(0, best).join(' '), words.slice(best).join(' ')];
  }
  const fit = Math.max(4, ...lines.map((l) => l.length));
  const spans = lines.map((l, i) => `<span class="line"><span data-line style="--i:${i}">${esc(l)}</span></span>`).join('');
  return `<h1 class="wl-title" style="--fit:${fit}" aria-label="${esc(name)}">
      <span class="copy above lines">${spans}</span>
      <span class="copy below lines" aria-hidden="true">${spans}</span>
    </h1>`;
}

function howItWorks(hunt) {
  const stages = [
    ['Register', 'Pick a team name on this phone, then use the same phone for every code you scan. That is how the hunt knows it is your team.'],
    ['Follow your trail', `Your team gets its own trail of ${hunt.milestones} milestones. Every code you find shows the clue to your next one. Other teams get different clues from the same code, so do not follow the crowd.`],
    ['Find the real code', `Each milestone has several codes that look the same. Only one is real. It moves to another code every ${hunt.shuffle_min} to ${hunt.shuffle_max} minutes, and as soon as someone scans it.`],
    ['Reach the end', 'Every trail ends at the same final destination. Scan it after your last milestone to stop the clock.'],
  ];
  return `
  <section class="field f-paper">
    <div class="inner how">
      <div class="intro reveal">
        <h2 class="head">How it works</h2>
        <p class="text">Every team walks a different trail across campus, and every trail ends in the same place. The first team there wins.</p>
      </div>
      <figure class="photo reveal">
        <img src="/img/ucsc-building.jpg" width="1280" height="960" loading="lazy" alt="The UCSC building on Reid Avenue, Colombo, seen from under a tree">
        <figcaption>The hunt runs around the UCSC building and its grounds.</figcaption>
      </figure>
      <div class="stages reveal">
        ${stages.map(([name, text], i) => `<details class="stage" name="how" ${i === 0 ? 'open' : ''}><summary>${esc(name)}</summary><p>${esc(text)}</p></details>`).join('')}
      </div>
    </div>
  </section>`;
}

function rejoinField(hunt, { joinError = '', joinCode = '' } = {}) {
  return `
  <section class="field f-cyan" id="rejoin">
    <div class="inner code-field reveal">
      <h2 class="head">Already on a team?</h2>
      <p class="text">Enter the team code shown on your teammate’s phone to link this phone to the same team.</p>
      ${joinError ? `<p class="error" role="alert">${esc(joinError)}</p>` : ''}
      <form method="post" action="/h/${hunt.id}/rejoin" class="form">
        <label for="code">Team code</label>
        <input id="code" name="code" maxlength="6" autocomplete="off" autocapitalize="characters" required value="${esc(joinCode)}" placeholder="ABC123">
        <button type="submit">Link this phone</button>
      </form>
    </div>
  </section>`;
}

export function joinPage(hunt, card, { error = '', name = '', joinError = '', joinCode = '' } = {}) {
  const body = `
  <main class="waterline">
    <div class="wl-top"><div class="bar">${logo}<a href="#rejoin">Join a team</a></div></div>
    <div class="wl-bottom f-blue">
      <div class="below-seam rise">
        <p>${esc(hunt.welcome)}</p>
        ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
        <form method="post" action="/q/${esc(card.token)}/join" class="form">
          <label for="name">Team name</label>
          <input id="name" name="name" maxlength="40" autocomplete="off" required value="${esc(name)}" placeholder="The Debuggers">
          <button type="submit">Start the hunt</button>
        </form>
      </div>
    </div>
    ${waterlineTitle(hunt.name)}
  </main>
  ${howItWorks(hunt)}
  ${rejoinField(hunt, { joinError, joinCode })}
  ${close(hunt, { photoCredit: true })}`;
  return layout({ title: hunt.name, top: 'paper', body });
}

export function noTeamPage(hunt, opts = {}) {
  const body = `
  <main class="field f-paper state">
    <div class="inner">${bar('<a href="#rejoin">Join a team</a>')}</div>
    <div class="inner body rise">
      <h1 class="huge">Find the start</h1>
      <p class="lead">This phone is not on a team yet. Scan the starting code to register your team, or link this phone to a team you already have.</p>
    </div>
  </main>
  ${rejoinField(hunt, opts)}
  ${close(hunt)}`;
  return layout({ title: hunt.name, top: 'paper', body });
}

export function decoyPage(hunt, message, team) {
  const body = `
  <main class="field f-yellow state">
    <div class="inner">${bar(team ? `<span>${esc(team.name)}</span>` : '')}</div>
    <div class="inner body rise">
      <h1 class="huge">Not this one</h1>
      <p class="lead">${esc(message) || 'Keep looking.'}</p>
      ${team ? `<p><a class="button" href="/play/${hunt.id}">Back to your clue</a></p>` : ''}
    </div>
  </main>
  ${close(hunt)}`;
  return layout({ title: hunt.name, top: 'yellow', body });
}

export function messagePage(title, text, { huntName = '', link = null } = {}) {
  const body = `
  <main class="field f-navy state">
    <div class="inner">${bar()}</div>
    <div class="inner body rise">
      <h1 class="huge" style="font-size:clamp(2.75rem, 12vw, 6rem)">${esc(title)}</h1>
      <p class="lead">${esc(text)}</p>
      ${link ? `<p><a class="button" href="${esc(link.href)}">${esc(link.label)}</a></p>` : ''}
    </div>
  </main>
  ${close(huntName ? { name: huntName } : null)}`;
  return layout({ title: huntName ? `${title} · ${huntName}` : title, top: 'navy', body });
}

/* ---------------------------------------------------------------- print sheet */

const KIND_LABEL = { start: 'Start', checkpoint: 'Checkpoint', decoy: 'Decoy', finish: 'Finish' };

/** Printable sheet of QR cards. `cards` = [{ code, card, svg, usage }] */
export function printPage(hunt, cards, { labels }) {
  const items = cards.map(({ code, card, svg, usage }) => `
    <figure class="card">
      <img class="brand" src="/brand/logo-ink.png" alt="UCSC IEEE Student Branch">
      <div class="qr">${svg}</div>
      <figcaption>
        <b>${esc(hunt.name)}</b>
        <span>${esc(card.token)}</span>
      </figcaption>
      ${labels ? `<p class="placement"><b>${KIND_LABEL[code.kind]}</b> · ${esc(code.label || `#${code.id}`)}${code.cards.length > 1 ? ` · card ${card.slot} of ${code.cards.length}` : ''}${usage ? `<br>${esc(usage)}` : ''}</p>` : ''}
    </figure>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>QR codes · ${esc(hunt.name)}</title>
<link rel="icon" href="/brand/favicon.png">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,700&display=swap">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "General Sans", ui-sans-serif, system-ui, sans-serif; color: #0a1628; background: #e6e9ec; }
  .top { display: flex; gap: 16px; align-items: center; padding: 14px 20px; background: #00629b; color: #fff; font-size: 15px; }
  .top button { font: 600 15px/1 "General Sans", ui-sans-serif, system-ui, sans-serif; padding: 10px 18px; border: 0; border-radius: 0; background: #ffc72c; color: #0a1628; cursor: pointer; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8mm; width: 190mm; margin: 10mm auto; }
  /* the dashed outline is the cut line */
  .card { margin: 0; padding: 5mm; background: #fff; outline: 0.3mm dashed #9aa3ad; break-inside: avoid; display: flex; flex-direction: column; gap: 3mm; }
  .brand { width: 100%; height: auto; display: block; }
  .qr svg { width: 100%; height: auto; display: block; }
  figcaption { display: flex; justify-content: space-between; align-items: baseline; gap: 2mm; font-size: 10pt; }
  figcaption span { font-size: 8pt; font-variant-numeric: tabular-nums; color: #3c4a5c; }
  .placement { margin: 0; padding: 2mm; background: #fff2c9; font-size: 8pt; line-height: 1.35; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  @media print {
    body { background: #fff; }
    .top { display: none; }
    .grid { margin: 0 auto; }
    @page { size: A4; margin: 10mm; }
  }
</style></head>
<body>
  <div class="top"><button onclick="print()">Print</button><span>${cards.length} QR cards. Cut along the dashed lines.${labels ? ' Cards marked “card x of y” go together at the same spot; cut off the yellow placement notes first.' : ''}</span></div>
  <div class="grid">${items}</div>
</body></html>`;
}

function ordinal(n) {
  if (!n) return '';
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
