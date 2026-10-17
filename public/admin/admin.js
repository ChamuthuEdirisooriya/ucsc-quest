// Admin dashboard: a small hash-routed app with no build step.

const app = document.getElementById('app');

/* ------------------------------------------------------------ helpers */

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    }
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

// Like replaceChildren, but accepts nested arrays and skips null/false.
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/login') {
    location.hash = '#/login';
    throw new Error(data.error || 'Please sign in.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), isError ? 5000 : 2200);
}

// Run an async action, report errors as a toast.
async function attempt(fn, success) {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (err) {
    toast(err.message, true);
    return undefined;
  }
}

function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return new Date(iso).toLocaleDateString();
}
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
function duration(from, to) {
  const ms = new Date(to) - new Date(from);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${Math.floor((ms % 60000) / 1000)}s`;
}

const KIND_NAMES = { start: 'Start', checkpoint: 'Checkpoint', decoy: 'Decoy', finish: 'Finish' };
const codeName = (c) => c?.label || `${KIND_NAMES[c?.kind] ?? 'QR'} #${c?.id ?? ''}`;
const cardSuffix = (s) => (s.card_total > 1 && s.card_slot ? ` · card ${s.card_slot}` : '');

function modal(title, content, { onClose } = {}) {
  const dlg = h('dialog', {},
    h('header', {}, h('h2', {}, title), h('button', { class: 'btn ghost', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'body' }, content),
  );
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/* ------------------------------------------------------------ routing */

let cleanup = [];
function onLeave(fn) { cleanup.push(fn); }

async function route() {
  for (const fn of cleanup) fn();
  cleanup = [];
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

  if (parts[0] === 'login') return renderLogin();
  const me = await api('GET', '/me').catch(() => ({ admin: false }));
  if (!me.admin) return (location.hash = '#/login');

  if (parts[0] === 'hunt' && parts[1]) return renderHunt(Number(parts[1]), parts[2] || 'live');
  return renderHunts();
}
window.addEventListener('hashchange', route);
route();

function shell(...content) {
  app.replaceChildren(
    h('div', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, 'Hunt Control'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost small', onclick: async () => { await api('POST', '/logout'); location.hash = '#/login'; } }, 'Sign out'),
    ),
    h('div', { class: 'wrap' }, content),
  );
}

/* ------------------------------------------------------------ login */

function renderLogin() {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, autofocus: true });
  const form = h('form', { class: 'panel login', onsubmit: async (e) => {
    e.preventDefault();
    const ok = await attempt(() => api('POST', '/login', { password: pw.value }));
    if (ok) location.hash = '#/';
  } },
    h('h1', {}, 'Hunt Control'),
    h('p', {}, 'Organiser sign-in'),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
    h('button', { class: 'btn primary', style: { width: '100%' } }, 'Sign in'),
  );
  app.replaceChildren(form);
  pw.focus();
}

/* ------------------------------------------------------------ hunts list */

async function renderHunts() {
  const hunts = await api('GET', '/hunts');
  const name = h('input', { placeholder: 'Campus Quest 2026', required: true });
  const milestones = h('input', { type: 'number', min: 1, max: 50, value: 5, required: true, style: { width: '90px' } });

  shell(
    h('div', { class: 'section-title' }, h('h2', {}, 'Your hunts')),
    h('form', { class: 'panel', style: { marginBottom: '22px' }, onsubmit: async (e) => {
      e.preventDefault();
      const res = await attempt(() => api('POST', '/hunts', { name: name.value, milestones: Number(milestones.value) }));
      if (res) location.hash = `#/hunt/${res.id}/codes`;
    } },
      h('header', {}, h('h3', {}, 'New hunt'), h('span', { class: 'hint' }, 'Every team will visit the same number of milestones before the shared final destination.')),
      h('div', { class: 'body row' },
        h('label', { class: 'field grow', style: { margin: 0 } }, h('span', {}, 'Name'), name),
        h('label', { class: 'field', style: { margin: 0 } }, h('span', {}, 'Milestones per team'), milestones),
        h('button', { class: 'btn primary', style: { alignSelf: 'flex-end' } }, 'Create hunt'),
      ),
    ),
    hunts.length === 0
      ? h('div', { class: 'panel empty' }, 'No hunts yet. Create your first one above.')
      : h('div', { class: 'hunt-grid' }, hunts.map((hu) =>
        h('a', { class: 'panel hunt-card', href: `#/hunt/${hu.id}/live` },
          h('span', { class: `pill ${hu.status}` }, hu.status),
          h('h3', {}, hu.name),
          h('div', { class: 'stats' },
            h('span', {}, `${hu.milestones} milestones`),
            h('span', {}, `${hu.path_count} paths`),
            h('span', {}, `${hu.team_count} teams`),
            hu.finished_count ? h('span', {}, `${hu.finished_count} finished`) : null,
          ),
        ))),
  );
}

/* ------------------------------------------------------------ hunt view */

async function renderHunt(id, tab) {
  const data = await api('GET', `/hunts/${id}`).catch((err) => { toast(err.message, true); location.hash = '#/'; });
  if (!data) return;
  const { hunt, issues } = data;

  const setStatus = async (status, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    if (await attempt(() => api('PUT', `/hunts/${id}`, { status }), `Hunt is now ${status}`)) route();
  };
  const startCode = data.codes.find((c) => c.kind === 'start');

  const statusActions = {
    draft: [h('button', { class: 'btn primary', onclick: () => setStatus('live') }, 'Go live')],
    live: [
      h('button', { class: 'btn', onclick: () => setStatus('draft', 'Move back to draft? Players will be blocked until you go live again.') }, 'Pause (draft)'),
      h('button', { class: 'btn dark', onclick: () => setStatus('ended', 'End the hunt? Players can no longer scan.') }, 'End hunt'),
    ],
    ended: [h('button', { class: 'btn', onclick: () => setStatus('live') }, 'Reopen')],
  }[hunt.status];

  const tabs = [['live', 'Live tracking'], ['paths', 'Paths & clues'], ['codes', 'QR codes'], ['settings', 'Settings']];
  const views = { live: liveTab, paths: pathsTab, codes: codesTab, settings: settingsTab };

  shell(
    h('div', { class: 'hunt-head' },
      h('div', {},
        h('div', { class: 'row' }, h('h1', {}, hunt.name), h('span', { class: `pill ${hunt.status}` }, hunt.status)),
        h('div', { class: 'sub' }, `${hunt.milestones} milestones per team · ${data.paths.length} paths · ${data.team_count} teams`),
      ),
      h('div', { class: 'actions' },
        startCode ? h('a', { class: 'btn ghost', href: startCode.cards[0]?.url, target: '_blank', title: 'Open the start QR link like a player would' }, 'Test as player ↗') : null,
        statusActions,
      ),
    ),
    h('nav', { class: 'tabs' }, tabs.map(([key, label]) =>
      h('a', { href: `#/hunt/${id}/${key}`, class: key === tab ? 'on' : '' }, label,
        key === 'paths' && issues.errors.length ? h('span', { class: 'count' }, issues.errors.length) : null))),
    h('div', { id: 'tab' }),
  );
  await (views[tab] ?? liveTab)(data, document.getElementById('tab'));
}

function issueList(issues, filter = () => true) {
  const errors = issues.errors.filter(filter);
  const warnings = issues.warnings.filter(filter);
  if (!errors.length && !warnings.length) return null;
  return h('div', { class: 'issues' },
    errors.slice(0, 6).map((e) => h('div', { class: 'issue error' }, e.message)),
    errors.length > 6 ? h('div', { class: 'issue error' }, `…and ${errors.length - 6} more to fix before going live.`) : null,
    warnings.length ? h('details', {},
      h('summary', { class: 'muted' }, `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`),
      warnings.map((w) => h('div', { class: 'issue warning', style: { marginTop: '6px' } }, w.message))) : null,
  );
}

/* ------------------------------------------------------------ live tab */

const SCAN_TEXT = {
  registered: ['✓', 'registered'],
  advance: ['✓', 'found'],
  finish: ['★', 'FINISHED at'],
  repeat: ['↺', 're-scanned'],
  wrong: ['✕', 'wrong QR'],
  ahead: ['✕', 'skipped ahead to'],
  early: ['✕', 'too early at'],
  decoy: ['?', 'hit decoy'],
  'no-team': ['·', 'scanned without a team'],
};

async function liveTab(data, root) {
  const huntId = data.hunt.id;
  let live = null;

  const draw = () => {
    if (!live) return;
    const n = live.hunt.milestones;
    const { stats } = live;
    const statBox = (value, label) => h('div', { class: 'panel stat' }, h('b', {}, value), h('span', {}, label));

    const teamsTable = live.teams.length === 0
      ? h('div', { class: 'empty' },
        h('p', {}, 'No teams yet. Teams appear here the moment they scan the start QR.'),
        data.hunt.status === 'draft' ? h('p', {}, 'The hunt is in draft: only you (signed in) can play. Go live when your paths are ready.') : null)
      : h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Team'), h('th', {}, 'Path'), h('th', {}, 'Progress'), h('th', { class: 'hide-sm' }, 'Heading to'), h('th', { class: 'hide-sm' }, 'Last seen'), h('th', { title: 'Wrong / decoy scans' }, 'Misses'))),
        h('tbody', {}, live.teams.map((t) =>
          h('tr', { class: 'click', onclick: () => openTeam(t.id, live, reload) },
            h('td', { class: `rank ${t.rank === 1 ? 'top' : ''}` }, t.rank ? `${t.rank}` : '·'),
            h('td', { class: 'team-name' }, t.name, h('small', {}, t.join_code)),
            h('td', {}, h('span', { class: 'chip' }, h('i', { style: { background: t.path_color } }), t.path_name)),
            h('td', {},
              h('div', { class: 'bar', style: { '--c': t.path_color } },
                Array.from({ length: n }, (_, i) => h('span', { class: i < t.progress ? 'on' : '' })),
                h('span', { class: `flag ${t.finished_at ? 'on' : ''}` })),
              h('div', { class: 'bar-label' }, t.finished_at ? `done in ${duration(t.started_at, t.finished_at)}` : `${t.progress}/${n}`)),
            h('td', { class: 'hide-sm' }, t.finished_at ? h('span', { class: 'muted' }, '—') : t.heading_to),
            h('td', { class: 'hide-sm muted', 'data-ago': t.last_seen_at }, ago(t.last_seen_at)),
            h('td', {},
              t.wrong_scans ? h('span', { class: 'badge bad', title: 'Wrong / out-of-order scans' }, t.wrong_scans) : null, ' ',
              t.decoy_scans ? h('span', { class: 'badge warn', title: 'Decoy scans' }, t.decoy_scans) : null),
          ))));

    // Race board: which milestone each team is heading to, per path.
    const board = live.teams.length ? h('div', { class: 'panel board', style: { marginTop: '18px' } },
      h('header', {}, h('h3', {}, 'Race board'), h('span', { class: 'hint' }, 'Teams placed by the milestone they are looking for')),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Path'), Array.from({ length: n }, (_, i) => h('th', {}, `→ ${i + 1}`)), h('th', {}, '→ ★'), h('th', {}, 'Done'))),
        h('tbody', {}, live.paths.map((p) => h('tr', {},
          h('td', {}, h('span', { class: 'chip' }, h('i', { style: { background: p.color } }), p.name)),
          Array.from({ length: n + 2 }, (_, col) => h('td', {},
            live.teams
              .filter((t) => t.path_id === p.id && (t.finished_at ? col === n + 1 : t.progress === col))
              .map((t) => h('span', { class: 'tchip', style: { '--c': p.color }, onclick: () => openTeam(t.id, live, reload) }, t.name)))),
        ))))) : null;

    const feed = h('div', { class: 'panel' },
      h('header', {}, h('h3', {}, 'Activity'), h('span', { class: 'hint' }, 'live')),
      live.activity.length === 0
        ? h('div', { class: 'empty' }, 'Scans will stream in here.')
        : h('div', { class: 'feed' }, h('ul', {}, live.activity.map((a) => {
          const [icon, verb] = SCAN_TEXT[a.result] ?? ['·', a.result];
          return h('li', {},
            h('span', { class: `ico ${a.result}` }, icon),
            h('span', {}, h('b', {}, a.team_name ?? 'Unknown phone'), ` ${verb} `, a.result === 'registered' ? null : h('span', {}, a.code_label + cardSuffix(a))),
            h('time', { 'data-ago': a.at, title: new Date(a.at).toLocaleString() }, ago(a.at)));
        }))));

    fill(root, 
      h('div', { class: 'stats-row' },
        statBox(stats.teams, 'Teams'),
        statBox(stats.finished, 'Finished'),
        statBox(stats.scans, 'Scans'),
        statBox(stats.wrong, 'Wrong scans'),
        statBox(stats.decoys, 'Decoy hits')),
      h('div', { class: 'live-grid' },
        h('div', {}, h('div', { class: 'panel' }, teamsTable), board),
        feed),
    );
  };

  const reload = async () => {
    live = await api('GET', `/hunts/${huntId}/live`).catch(() => live);
    draw();
  };
  await reload();

  // Push updates over SSE; debounce bursts of scans.
  let pending;
  const es = new EventSource(`/api/hunts/${huntId}/stream`);
  es.onmessage = () => { clearTimeout(pending); pending = setTimeout(reload, 250); };
  const tick = setInterval(() => document.querySelectorAll('[data-ago]').forEach((el) => (el.textContent = ago(el.dataset.ago))), 15000);
  const poll = setInterval(reload, 60000); // safety net if the stream drops
  onLeave(() => { es.close(); clearInterval(tick); clearInterval(poll); clearTimeout(pending); });
}

async function openTeam(teamId, live, onChange) {
  const detail = await attempt(() => api('GET', `/teams/${teamId}`));
  if (!detail) return;
  const { team, route } = detail;
  const color = live.paths.find((p) => p.id === team.path_id)?.color ?? '#94a3b8';
  const n = live.hunt.milestones;

  const name = h('input', { value: team.name });
  const path = h('select', {}, live.paths.map((p) => h('option', { value: p.id, selected: p.id === team.path_id }, p.name)));
  const progress = h('select', {}, Array.from({ length: n + 1 }, (_, i) => h('option', { value: i, selected: i === team.progress }, `${i} / ${n}`)));

  const dlg = modal(team.name, [
    h('div', { class: 'row', style: { marginBottom: '16px' } },
      h('span', { class: 'muted' }, 'Team code '), h('b', { class: 'mono' }, team.join_code),
      h('span', { class: 'muted' }, ` · started ${clock(team.started_at)}`),
      team.finished_at ? h('span', { class: 'pill live' }, `finished in ${duration(team.started_at, team.finished_at)}`) : null),
    h('ol', { class: 'route', style: { '--c': color } }, route.map((r) =>
      h('li', { class: r.reached ? 'done' : '' },
        h('span', { class: 'dot' }, r.position ?? '★'),
        h('span', {}, r.label || h('em', { class: 'muted' }, 'not set')),
        h('time', {}, r.at ? clock(r.at) : '')))),
    h('details', { style: { marginBottom: '16px' } },
      h('summary', { class: 'muted', style: { cursor: 'pointer' } }, `All ${detail.scans.length} scans`),
      h('ul', { class: 'route', style: { marginTop: '8px' } }, detail.scans.map((s) => {
        const [icon, verb] = SCAN_TEXT[s.result] ?? ['·', s.result];
        return h('li', {}, h('span', { class: 'dot' }, icon), h('span', {}, `${verb} ${s.result === 'registered' ? '' : s.code_label + cardSuffix(s)}`), h('time', {}, clock(s.at)));
      }))),
    h('div', { class: 'panel body', style: { background: '#fbfaf7' } },
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, h('span', {}, 'Path'), path),
        h('label', { class: 'field grow' }, h('span', {}, 'Milestones found'), progress)),
      h('small', { class: 'muted', style: { display: 'block', marginBottom: '12px' } }, 'Changing the path or progress takes effect on the team’s next scan or page refresh.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          const ok = await attempt(() => api('PUT', `/teams/${teamId}`, { name: name.value, path_id: Number(path.value), progress: Number(progress.value) }), 'Team updated');
          if (ok) { dlg.close(); onChange(); }
        } }, 'Save changes'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm(`Delete team "${team.name}"? Their phone will need to register again.`)) return;
          if (await attempt(() => api('DELETE', `/teams/${teamId}`), 'Team deleted')) { dlg.close(); onChange(); }
        } }, 'Delete team'))),
  ]);
}

/* ------------------------------------------------------------ paths tab */

async function pathsTab(data, root) {
  const { hunt, codes, paths, issues } = data;
  const n = hunt.milestones;
  const checkpoints = codes.filter((c) => c.kind === 'checkpoint');
  const codeById = new Map(codes.map((c) => [c.id, c]));
  const pathById = new Map(paths.map((p) => [p.id, p]));

  const count = h('input', { type: 'number', min: 1, max: 50, value: Math.max(2, paths.length || 4) });
  const replace = h('input', { type: 'checkbox' });

  const generate = async () => {
    if (replace.checked && paths.length && !confirm('Replace all existing paths? Their clues will be lost.')) return;
    if (await attempt(() => api('POST', `/hunts/${hunt.id}/generate-paths`, { count: Number(count.value), replace: replace.checked }), 'Paths generated — now write the clues')) route();
  };

  // Which checkpoint is used where (for the overlap matrix and dropdown hints)
  const usageText = (codeId, exceptPath) => codeById.get(codeId)?.usage
    .filter((u) => u.path_id !== exceptPath)
    .map((u) => `${pathById.get(u.path_id)?.name} #${u.position}`).join(', ');
  // Which paths never meet this checkpoint (it is shared, but not by everyone).
  const skippedBy = (codeId) => paths.filter((p) => !codeById.get(codeId)?.usage.some((u) => u.path_id === p.id)).map((p) => p.name);
  const sharingTag = (c) => {
    const k = c.usage.length;
    if (k === 0) return 'unused';
    if (k === paths.length) return paths.length === 1 ? 'on the path' : `every path (${k}/${k})`;
    return `${k}/${paths.length} paths · skipped by ${skippedBy(c.id).join(', ')}`;
  };

  const matrix = paths.length && checkpoints.length ? h('div', { class: 'panel matrix' },
    h('header', {}, h('h3', {}, 'Checkpoint overview'), h('span', { class: 'hint' }, 'Numbers show the milestone position of each checkpoint in each path. Empty cells are paths whose teams never visit that checkpoint.')),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Checkpoint'), paths.map((p) => h('th', {}, h('span', { class: 'chip' }, h('i', { style: { background: p.color } }), p.name))), h('th', {}, ''))),
      h('tbody', {}, checkpoints.map((c) => h('tr', {},
        h('td', {}, codeName(c)),
        paths.map((p) => {
          const u = c.usage.find((x) => x.path_id === p.id);
          return h('td', { class: u ? 'hit' : '', style: { '--c': p.color } }, u ? h('b', {}, u.position) : h('span', { class: 'muted' }, '·'));
        }),
        h('td', { class: 'tag' }, sharingTag(c)),
      ))))) : null;

  fill(root, 
    issueList(issues),
    h('div', { class: 'toolbar' },
      h('div', { class: 'group' },
        h('span', {}, 'Generate'), count, h('span', {}, 'paths from'), h('b', {}, `${checkpoints.length} checkpoints`),
        h('label', { class: 'row', style: { gap: '4px', marginLeft: '6px' } }, replace, h('span', { class: 'muted' }, 'replace existing')),
        h('button', { class: 'btn dark', onclick: generate, disabled: checkpoints.length < n }, 'Generate')),
      h('button', { class: 'btn', onclick: async () => {
        if (await attempt(() => api('POST', `/hunts/${hunt.id}/paths`, {}), 'Path added')) route();
      } }, '+ Empty path'),
      checkpoints.length < n ? h('span', { class: 'muted' }, `Add at least ${n} checkpoint QRs on the QR codes tab first.`) : null,
    ),
    matrix,
    paths.length === 0 ? h('div', { class: 'panel empty' }, 'No paths yet. Generate some from your checkpoints, or add one by hand.') : null,
    paths.map((p) => pathEditor(p)),
  );

  function pathEditor(p) {
    const draft = { name: p.name, color: p.color, start_clue: p.start_clue, steps: p.steps.map((s) => ({ ...s })) };
    const errorsAt = new Set(issues.errors.filter((e) => e.path_id === p.id && e.position).map((e) => e.position));
    let card;
    const markDirty = () => { card.classList.add('dirty'); saveBtn.disabled = false; };

    const saveBtn = h('button', { class: 'btn primary', disabled: true, onclick: async () => {
      if (await attempt(() => api('PUT', `/paths/${p.id}`, draft), `${draft.name} saved`)) route();
    } }, 'Save path');

    const leadsTo = (i) => {
      if (i === n - 1) return h('span', {}, 'leads to ', h('b', {}, 'the final destination'));
      const next = codeById.get(draft.steps[i + 1].code_id);
      return h('span', {}, `leads to milestone ${i + 2}`, next ? [': ', h('b', {}, codeName(next))] : '');
    };
    const leadLabels = [];

    const stepRows = draft.steps.map((s, i) => {
      const lead = h('div', { class: 'lead' }, leadsTo(i));
      leadLabels.push(lead);
      const sel = h('select', { onchange: () => {
        s.code_id = sel.value ? Number(sel.value) : null;
        hint.textContent = s.code_id ? sharedText(s.code_id) : '';
        if (i > 0) leadLabels[i - 1].replaceChildren(leadsTo(i - 1));
        markDirty();
      } },
        h('option', { value: '' }, '— choose checkpoint —'),
        checkpoints.map((c) => {
          const other = usageText(c.id, p.id);
          return h('option', { value: c.id, selected: c.id === s.code_id }, `${codeName(c)}${other ? `  (also ${other})` : ''}`);
        }));
      const sharedText = (codeId) => {
        const other = usageText(codeId, p.id);
        const skipped = skippedBy(codeId).filter((name) => name !== p.name);
        return [other ? `Also on ${other}` : 'Only this path', skipped.length && other ? `skipped by ${skipped.join(', ')}` : ''].filter(Boolean).join(' · ');
      };
      const hint = h('small', {}, s.code_id ? sharedText(s.code_id) : '');
      return h('div', { class: `step ${errorsAt.has(s.position) ? 'err' : ''}` },
        h('div', { class: 'num' }, s.position),
        h('div', { class: 'where' }, sel, hint),
        h('div', {},
          lead,
          h('textarea', { class: 'clue', rows: 2, placeholder: 'Clue shown when a team on this path scans this QR…', value: s.clue,
            oninput: (e) => { s.clue = e.target.value; markDirty(); } })),
      );
    });

    card = h('section', { class: 'panel path-card', style: { '--c': p.color } },
      h('header', {},
        h('input', { type: 'color', value: p.color, title: 'Path colour', oninput: (e) => { draft.color = e.target.value; card.style.setProperty('--c', draft.color); markDirty(); } }),
        h('input', { class: 'name', value: p.name, oninput: (e) => { draft.name = e.target.value; markDirty(); } }),
        h('span', { class: 'hint' }, `${p.team_count} team${p.team_count === 1 ? '' : 's'} on this path`),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn danger small', onclick: async () => {
          if (!confirm(`Delete ${p.name}?`)) return;
          if (await attempt(() => api('DELETE', `/paths/${p.id}`), 'Path deleted')) route();
        } }, 'Delete')),
      h('div', { class: 'steps' },
        h('div', { class: 'step' },
          h('div', { class: 'num start' }, '▶'),
          h('div', { class: 'where' }, h('b', {}, 'Start QR'), h('small', {}, 'Shared by every team. Shown right after registering.')),
          h('div', {},
            h('div', { class: 'lead' }, leadsTo(-1)),
            h('textarea', { class: 'clue', rows: 2, placeholder: 'First clue for teams on this path…', value: p.start_clue,
              oninput: (e) => { draft.start_clue = e.target.value; markDirty(); } }))),
        stepRows,
        h('div', { class: 'step' },
          h('div', { class: 'num start' }, '★'),
          h('div', { class: 'where' }, h('b', {}, 'Final destination'), h('small', {}, 'Shared by every team. Shows the finish message.')),
          h('div', { class: 'muted', style: { paddingTop: '6px' } }, 'Edit the finish message on the Settings tab.'))),
      h('div', { class: 'path-foot' }, saveBtn, h('span', { class: 'muted' }, 'Unsaved changes are highlighted.')),
    );
    // The start clue's "leads to" label also depends on the first step.
    const firstLead = card.querySelector('.step .lead');
    const origFirstSelect = stepRows[0]?.querySelector('select');
    origFirstSelect?.addEventListener('change', () => firstLead.replaceChildren(leadsTo(-1)));
    return card;
  }
}

/* ------------------------------------------------------------ codes tab */

function untilText(iso) {
  if (!iso) return '';
  const s = Math.round((new Date(iso) - Date.now()) / 1000);
  if (s <= 0) return 'on the next scan';
  return s < 60 ? `in ${s}s` : `in ${Math.round(s / 60)} min`;
}

async function codesTab(data, root) {
  const { hunt, codes, paths } = data;
  const pathById = new Map(paths.map((p) => [p.id, p]));
  const byKind = (k) => codes.filter((c) => c.kind === k);
  const cardTotal = (k) => byKind(k).reduce((n, c) => n + c.cards.length, 0);
  const thumbs = new Map(); // card id -> thumbnail element, to highlight the real card live
  const shuffleNotes = new Map(); // code id -> element showing the next shuffle time

  const printDialog = () => {
    const kinds = { start: true, checkpoint: true, decoy: true, finish: true };
    const labels = h('input', { type: 'checkbox', checked: true });
    const dlg = modal('Print QR codes', [
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'All cards look the same, whether they are real or decoys. The placement notes tell you which cards go together at the same spot (“card 2 of 5”). Cut or fold them off before you put the cards out.'),
      h('div', { class: 'row', style: { marginBottom: '14px' } }, Object.keys(kinds).map((k) =>
        h('label', { class: 'row', style: { gap: '6px' } },
          h('input', { type: 'checkbox', checked: true, onchange: (e) => (kinds[k] = e.target.checked) }),
          `${KIND_NAMES[k]} (${cardTotal(k)} cards)`))),
      h('label', { class: 'row', style: { gap: '6px', marginBottom: '18px' } }, labels, 'Include placement notes for organisers'),
      h('button', { class: 'btn primary', onclick: () => {
        const ks = Object.keys(kinds).filter((k) => kinds[k]).join(',');
        window.open(`/admin/print/${hunt.id}?kinds=${ks}&labels=${labels.checked ? 1 : 0}`, '_blank');
        dlg.close();
      } }, 'Open printable sheet'),
    ]);
  };

  const cardModal = (c, card) => modal(`${codeName(c)}${c.cards.length > 1 ? ` · card ${card.slot} of ${c.cards.length}` : ''}`, [
    h('img', { class: 'qr-big', src: `/api/cards/${card.id}/qr.svg`, alt: `QR ${card.token}` }),
    h('p', { class: 'mono muted', style: { textAlign: 'center', wordBreak: 'break-all' } }, card.url),
    h('div', { class: 'row', style: { justifyContent: 'center' } },
      h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(card.url).then(() => toast('Link copied')) }, 'Copy link'),
      h('a', { class: 'btn', href: card.url, target: '_blank' }, 'Open as a player ↗')),
    c.cards.length > 1 ? h('p', { class: 'muted', style: { textAlign: 'center', fontSize: '12px' } }, 'Opening the link counts as a scan. If this is the real card, the real QR moves to another card.') : null,
  ]);

  const codeRow = (c) => {
    const multi = c.cards.length > 1 && c.kind !== 'decoy';
    const label = h('input', { value: c.label, placeholder: c.kind === 'decoy' ? 'Where you will plant it (organisers only)' : 'Location name (organisers only)' });
    const message = c.kind === 'decoy'
      ? h('textarea', { class: 'clue', rows: 2, value: c.message, placeholder: 'Message shown to anyone who scans this decoy…' })
      : null;
    const save = async () => {
      if (label.value === c.label && (!message || message.value === c.message)) return;
      const updated = await attempt(() => api('PUT', `/codes/${c.id}`, { label: label.value, message: message?.value }), 'Saved');
      if (updated) Object.assign(c, { label: updated.label, message: updated.message });
    };
    label.addEventListener('change', save);
    message?.addEventListener('change', save);

    const usage = c.kind === 'checkpoint'
      ? (c.usage.length
        ? c.usage.map((u) => h('span', { class: 'chip' }, h('i', { style: { background: pathById.get(u.path_id)?.color } }), `${pathById.get(u.path_id)?.name} #${u.position}`))
        : h('span', {}, 'not in any path'))
      : null;
    const note = { start: 'Teams register here and get their first clue.', finish: 'Shared final destination for every path.', decoy: 'Never moves a team forward.' }[c.kind];

    const strip = h('div', { class: 'cards-strip' }, c.cards.map((k) => {
      const el = h('button', { class: `card-thumb ${multi && k.id === c.real_card_id ? 'real' : ''}`, title: `Card ${k.slot} · ${k.token} · ${k.scan_count} scans`, onclick: () => cardModal(c, k) },
        h('img', { src: `/api/cards/${k.id}/qr.svg`, alt: `QR card ${k.slot}`, loading: 'lazy' }),
        h('span', {}, multi ? `#${k.slot}` : k.token),
        multi ? h('em', {}, 'real now') : null);
      thumbs.set(k.id, el);
      return el;
    }));

    let cardControls = null;
    if (c.kind === 'checkpoint' || c.kind === 'finish') {
      const count = h('input', { type: 'number', min: 1, max: 12, value: c.cards.length, style: { width: '64px' } });
      const shuffleNote = h('span', {}, multi ? `next shuffle ${untilText(c.next_shuffle_at)}` : '');
      shuffleNotes.set(c.id, shuffleNote);
      cardControls = h('div', { class: 'card-controls' },
        h('span', {}, 'QR cards here'), count,
        h('button', { class: 'btn small', onclick: async () => {
          const n = Number(count.value);
          if (n < c.cards.length && !confirm(`Remove ${c.cards.length - n} card(s)? Printed copies of removed cards will stop working.`)) return;
          if (await attempt(() => api('PUT', `/codes/${c.id}`, { cards: n }), 'Cards updated')) route();
        } }, 'Set'),
        h('span', { class: 'muted' }, multi ? `1 real + ${c.cards.length - 1} decoys · ` : 'single QR, no decoys', shuffleNote),
        multi ? h('button', { class: 'btn small ghost', onclick: async () => {
          const res = await attempt(() => api('POST', `/codes/${c.id}/shuffle`), 'Real QR moved');
          if (res) refreshReal();
        } }, '⤮ Shuffle now') : null);
    }

    return h('div', { class: 'panel code' },
      h('div', {},
        h('div', { class: 'row', style: { marginBottom: '6px' } }, h('span', { class: `kind ${c.kind}` }, KIND_NAMES[c.kind]), note ? h('span', { class: 'muted' }, note) : null),
        label,
        message ? h('div', { style: { marginTop: '8px' } }, message) : null,
        strip,
        cardControls,
        h('div', { class: 'meta' }, h('span', {}, `${c.scan_count} scans`), usage ? ['·', usage] : null)),
      h('div', { class: 'side' },
        h('a', { class: 'btn small', href: `/admin/print/${hunt.id}?ids=${c.id}&labels=1`, target: '_blank' }, c.cards.length > 1 ? `Print ${c.cards.length} cards` : 'Print'),
        ['checkpoint', 'decoy'].includes(c.kind) ? h('button', { class: 'btn small danger', onclick: async () => {
          if (!confirm(`Delete this ${c.kind} and its ${c.cards.length} card(s)? Printed copies will stop working.`)) return;
          if (await attempt(() => api('DELETE', `/codes/${c.id}`), 'Deleted')) route();
        } }, 'Delete') : null),
    );
  };

  // Keep the "real now" highlight current while players scan (and as timed shuffles fall due).
  async function refreshReal() {
    const fresh = await api('GET', `/hunts/${hunt.id}`).catch(() => null);
    if (!fresh) return;
    for (const c of fresh.codes) {
      if (c.kind === 'decoy' || c.cards.length < 2) continue;
      for (const k of c.cards) thumbs.get(k.id)?.classList.toggle('real', k.id === c.real_card_id);
      const note = shuffleNotes.get(c.id);
      if (note) note.textContent = `next shuffle ${untilText(c.next_shuffle_at)}`;
    }
  }
  const es = new EventSource(`/api/hunts/${hunt.id}/stream`);
  es.onmessage = refreshReal;
  const timer = setInterval(refreshReal, 30000);
  onLeave(() => { es.close(); clearInterval(timer); });

  const cpLabels = h('textarea', { rows: 4, placeholder: 'Library entrance\nFountain\nCafeteria notice board\n…' });
  const cpDecoys = h('input', { type: 'number', min: 0, max: 11, value: hunt.decoys_per_location, style: { width: '64px' } });
  const addCheckpoints = async () => {
    const items = cpLabels.value.split('\n').map((s) => s.trim()).filter(Boolean).map((label) => ({ label, decoys: Number(cpDecoys.value) }));
    if (!items.length) return toast('Write one location per line.', true);
    if (await attempt(() => api('POST', `/hunts/${hunt.id}/codes`, { kind: 'checkpoint', items }), `${items.length} checkpoint${items.length > 1 ? 's' : ''} created`)) route();
  };

  const allCards = h('input', { type: 'number', min: 1, max: 12, value: hunt.decoys_per_location + 1 });
  const decoyLabel = h('input', { placeholder: 'Placement (optional), e.g. Near the fountain' });
  const decoyCount = h('input', { type: 'number', min: 1, max: 50, value: 1, style: { width: '80px' } });
  const decoyMessage = h('textarea', { class: 'clue', rows: 2, value: 'Nice try — this one is a decoy! Head back to your clue.' });
  const addDecoys = async () => {
    const items = Array.from({ length: Number(decoyCount.value) || 1 }, () => ({ label: decoyLabel.value, message: decoyMessage.value }));
    if (await attempt(() => api('POST', `/hunts/${hunt.id}/codes`, { kind: 'decoy', items }), `${items.length} decoy${items.length > 1 ? 's' : ''} created`)) route();
  };

  fill(root,
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: printDialog }, 'Print QR codes'),
      h('div', { class: 'group' },
        h('span', {}, 'Every checkpoint gets'), allCards, h('span', {}, 'cards'),
        h('button', { class: 'btn dark', onclick: async () => {
          if (!confirm(`Set every checkpoint to ${allCards.value} QR cards (1 real + ${allCards.value - 1} decoys)? Printed copies of any removed cards stop working.`)) return;
          if (await attempt(() => api('POST', `/hunts/${hunt.id}/cards`, { cards: Number(allCards.value) }), 'Cards updated')) route();
        } }, 'Apply')),
      h('button', { class: 'btn', onclick: async () => {
        if (await attempt(() => api('POST', `/hunts/${hunt.id}/shuffle`), 'Every real QR moved')) refreshReal();
      } }, '⤮ Shuffle all now')),
    h('p', { class: 'muted', style: { marginTop: '-6px' } },
      `At each spot with several cards, only one card is real. The real one moves to a random other card every ${hunt.shuffle_min}–${hunt.shuffle_max} minutes, and straight after anyone scans it. The others show the decoy message. Change this on the Settings tab.`),

    h('div', { class: 'section-title' }, h('h2', {}, 'Start & finish'), h('span', { class: 'hint' }, 'Shared by all teams')),
    h('div', { class: 'code-list' }, [...byKind('start'), ...byKind('finish')].map(codeRow)),

    h('div', { class: 'section-title' }, h('h2', {}, 'Checkpoints'), h('span', { class: 'hint' }, `${byKind('checkpoint').length} locations, ${cardTotal('checkpoint')} cards. Each path uses ${hunt.milestones} of these locations.`)),
    h('div', { class: 'panel add-box', style: { marginBottom: '12px' } },
      h('b', {}, 'Add checkpoint locations, one per line'), cpLabels,
      h('div', { class: 'row' },
        h('button', { class: 'btn dark', onclick: addCheckpoints }, 'Create checkpoints'),
        h('span', { class: 'muted' }, 'each with 1 real card +'), cpDecoys, h('span', { class: 'muted' }, 'decoy cards'))),
    h('div', { class: 'code-list' }, byKind('checkpoint').map(codeRow)),

    h('div', { class: 'section-title' }, h('h2', {}, 'Standalone decoys'), h('span', { class: 'hint' }, 'Single fake QRs you can put anywhere, separate from the decoy cards at each checkpoint.')),
    h('div', { class: 'panel add-box', style: { marginBottom: '12px' } },
      h('div', { class: 'row' }, h('b', {}, 'Add'), decoyCount, h('b', {}, 'decoys'), h('div', { class: 'grow' }, decoyLabel)),
      decoyMessage,
      h('div', {}, h('button', { class: 'btn dark', onclick: addDecoys }, 'Create decoys'))),
    h('div', { class: 'code-list' }, byKind('decoy').map(codeRow)),
  );
}

/* ------------------------------------------------------------ settings tab */

async function settingsTab(data, root) {
  const { hunt } = data;
  const settings = await api('GET', '/settings');

  const name = h('input', { value: hunt.name });
  const milestones = h('input', { type: 'number', min: 1, max: 50, value: hunt.milestones, disabled: data.team_count > 0 });
  const welcome = h('textarea', { rows: 3, value: hunt.welcome });
  const finish = h('textarea', { rows: 3, value: hunt.finish_message });
  const baseUrl = h('input', { value: settings.base_url, placeholder: settings.effective_base_url });
  const decoyMessage = h('textarea', { class: 'clue', rows: 2, value: hunt.decoy_message });
  const decoysPer = h('input', { type: 'number', min: 0, max: 11, value: hunt.decoys_per_location, style: { width: '80px' } });
  const shuffleMin = h('input', { type: 'number', min: 1, max: 240, value: hunt.shuffle_min, style: { width: '80px' } });
  const shuffleMax = h('input', { type: 'number', min: 1, max: 240, value: hunt.shuffle_max, style: { width: '80px' } });

  fill(root, 
    h('div', { class: 'panel', style: { marginBottom: '18px' } },
      h('header', {}, h('h3', {}, 'Hunt details')),
      h('div', { class: 'body' },
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Milestones per team'), milestones,
          h('small', {}, data.team_count > 0 ? 'Locked because teams have started. Reset teams below to change it.' : 'Every path has exactly this many checkpoints before the final destination.')),
        h('label', { class: 'field' }, h('span', {}, 'Welcome message (start QR)'), welcome),
        h('label', { class: 'field' }, h('span', {}, 'Finish message (final destination)'), finish),
        h('button', { class: 'btn primary', onclick: async () => {
          const ok = await attempt(() => api('PUT', `/hunts/${hunt.id}`, {
            name: name.value, welcome: welcome.value, finish_message: finish.value,
            ...(data.team_count === 0 ? { milestones: Number(milestones.value) } : {}),
          }), 'Hunt saved');
          if (ok) route();
        } }, 'Save'))),

    h('div', { class: 'panel', style: { marginBottom: '18px' } },
      h('header', {}, h('h3', {}, 'Decoy cards'), h('span', { class: 'hint' }, 'Several identical-looking QR cards at each spot, only one of them real')),
      h('div', { class: 'body' },
        h('label', { class: 'field' }, h('span', {}, 'Message on a decoy card'), decoyMessage,
          h('small', {}, 'Shown when someone scans a card that is not the real one right now. It does not say whether the spot is right.')),
        h('div', { class: 'row', style: { marginBottom: '14px' } },
          h('label', { class: 'field', style: { margin: 0 } }, h('span', {}, 'Decoys per new checkpoint'), decoysPer),
          h('label', { class: 'field', style: { margin: 0 } }, h('span', {}, 'Shuffle after at least (min)'), shuffleMin),
          h('label', { class: 'field', style: { margin: 0 } }, h('span', {}, '…and at most (min)'), shuffleMax)),
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'The real QR moves to a random other card at a random time in this range. It also moves straight after anyone scans it, so the next team cannot just copy which card was scanned.'),
        h('button', { class: 'btn primary', onclick: async () => {
          const ok = await attempt(() => api('PUT', `/hunts/${hunt.id}`, {
            decoy_message: decoyMessage.value,
            decoys_per_location: Number(decoysPer.value),
            shuffle_min: Number(shuffleMin.value),
            shuffle_max: Number(shuffleMax.value),
          }), 'Decoy settings saved');
          if (ok) route();
        } }, 'Save'))),

    h('div', { class: 'panel', style: { marginBottom: '18px' } },
      h('header', {}, h('h3', {}, 'QR link address'), h('span', { class: 'hint' }, 'Applies to all hunts')),
      h('div', { class: 'body' },
        h('p', { style: { marginTop: 0 } }, 'Every QR code opens ', h('b', { class: 'mono' }, `${settings.effective_base_url}/q/…`), '. Phones must be able to reach this address — ', h('b', {}, 'localhost will not work'), ' on a phone. Set it before printing.'),
        h('label', { class: 'field' }, h('span', {}, 'Public base URL (leave empty to use the address you are browsing on)'), baseUrl),
        settings.suggestions.length ? h('p', { class: 'muted' }, 'On this Wi-Fi network: ', settings.suggestions.map((s) =>
          h('button', { class: 'btn small', style: { margin: '2px' }, onclick: () => (baseUrl.value = s) }, s))) : null,
        h('button', { class: 'btn primary', onclick: async () => {
          if (await attempt(() => api('PUT', '/settings', { base_url: baseUrl.value }), 'Address saved')) route();
        } }, 'Save address'))),

    h('div', { class: 'panel', style: { borderColor: 'var(--bad-soft)' } },
      h('header', {}, h('h3', {}, 'Danger zone')),
      h('div', { class: 'body row' },
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Delete ALL teams and scan history for this hunt? Phones will need to register again.')) return;
          if (await attempt(() => api('DELETE', `/hunts/${hunt.id}/teams`), 'Teams reset')) route();
        } }, 'Reset all teams'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (prompt(`Type the hunt name to delete it permanently:\n${hunt.name}`) !== hunt.name) return;
          if (await attempt(() => api('DELETE', `/hunts/${hunt.id}`), 'Hunt deleted')) location.hash = '#/';
        } }, 'Delete hunt'))),
  );
}
