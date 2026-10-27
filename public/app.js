// Toy Doctor Dispatch — board UI

const app = document.getElementById('app');
const HOUR = 88; // px per hour, matches --hour
const REFRESH_MS = 60_000;
const state = { user: null, shops: [], shopId: null, date: null, today: null, demo: false, board: null, error: null, timer: null, allTechs: false, view: 'tech', week: null, month: null };
const VIEWS = { tech: 'Day – Technician', advisor: 'Day – Service Advisor', week: 'Week', month: 'Month' };

const CAT = {
  red: 'L2 + Diag', yellow: 'L1 Diag', blue: 'Maintenance', green: 'Waiter', purple: 'Prev Recs / Specific Tech', other: 'Uncategorized',
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtHour = (h) => { const hh = Math.floor(h + 1e-6); const mm = Math.round((h - hh) * 60); const h12 = ((hh + 11) % 12) + 1; return `${h12}:${String(mm).padStart(2, '0')}`; };
const fmtH = (n) => `${Number(n).toFixed(1)} h`;
const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
const longDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const icon = (path) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"></path></svg>`;
const toHM = (h) => `${String(Math.floor(h + 1e-6)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const fromHM = (v) => { if (!v) return null; const [h, m] = String(v).split(':').map(Number); return h + (m || 0) / 60; };
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401) { state.user = null; renderSignIn(); throw new Error('signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- sign-in ----------
async function start() {
  const cfg = await fetch('/auth/config').then((r) => r.json());
  state.authCfg = cfg;
  if (cfg.disabled || cfg.user) { state.user = cfg.user; return boot(); }
  renderSignIn();
}

function renderSignIn(message) {
  const cfg = state.authCfg ?? {};
  app.innerHTML = `<div class="signin"><div class="box">
    <div class="logo" style="width:48px;height:48px;font-size:18px">TD</div>
    <h1>Toy Doctor Dispatch</h1>
    <p>Sign in with your Toy Doctor Google account.</p>
    <div id="gbtn"></div>
    ${message ? `<p class="error" role="alert">${esc(message)}</p>` : ''}
    ${cfg.clientId ? '' : '<p class="error">Google sign-in isn\'t set up yet (GOOGLE_CLIENT_ID is missing).</p>'}
  </div></div>`;
  if (!cfg.clientId) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: cfg.clientId,
      callback: async ({ credential }) => {
        const r = await fetch('/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return renderSignIn(j.error || 'Sign-in failed.');
        const c = await fetch('/auth/config').then((x) => x.json());
        state.authCfg = c; state.user = c.user; boot();
      },
    });
    google.accounts.id.renderButton(document.getElementById('gbtn'), { theme: 'outline', size: 'large', text: 'signin_with' });
  };
  document.head.appendChild(s);
}

async function signOut() { await fetch('/auth/logout', { method: 'POST' }); state.user = null; clearInterval(state.timer); start(); }

// ---------- data ----------
async function boot() {
  app.innerHTML = '<div class="loading">Loading the board…</div>';
  try {
    const s = await api('/api/shops');
    state.shops = s.shops; state.today = s.today; state.demo = s.demo;
    const saved = Number(recall('td-shop'));
    state.shopId = s.shops.some((x) => x.id === saved) ? saved : s.shops[0]?.id;
    state.date = s.today;
    state.allTechs = recall('td-alltechs') === '1';
    state.view = VIEWS[recall('td-view')] ? recall('td-view') : 'tech';
    await load();
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden) load(true); }, REFRESH_MS);
  } catch (e) { if (e.message !== 'signed out') { state.error = e.message; render(); } }
}

async function load(quiet) {
  const v = state.view;
  const key = v === 'week' ? 'week' : v === 'month' ? 'month' : 'board';
  if (!quiet) { state[key] = null; render(); }
  try {
    const path = key === 'board' ? '/api/board' : `/api/${key}`;
    const data = await api(`${path}?shop=${state.shopId}&date=${state.date}`);
    if (state.view !== v) return; // switched views while loading
    state[key] = data;
    state.error = null;
    clearTimeout(state.namesTimer);
    if (data.namesPending) state.namesTimer = setTimeout(() => load(true), 8000); // names still loading
  } catch (e) { if (e.message === 'signed out') return; state.error = e.message; }
  render();
}

function go(date) { state.date = date; load(); }
function setShop(id) { state.shopId = id; remember('td-shop', String(id)); state.board = null; load(); }
function setView(v) { state.view = v; remember('td-view', v); load(); }
// the day board is needed for booking (techs, advisors) even from the Week and Month views
async function ensureBoard() {
  if (state.board && state.board.date === state.date && state.board.shopId === state.shopId) return state.board;
  state.board = await api(`/api/board?shop=${state.shopId}&date=${state.date}`);
  return state.board;
}
const monthAdd = (d, n) => { const x = new Date(`${d.slice(0, 7)}-01T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };

// ---------- rendering ----------
function render() {
  const b = state.board;
  const v = state.view;
  // keep the sideways scroll on the board (and the page scroll) across redraws
  const prevLeft = document.querySelector('.board')?.scrollLeft ?? state.boardLeft ?? 0;
  const prevBoardTop = document.querySelector('.board')?.scrollTop ?? state.boardTop ?? null;
  const prevTop = window.scrollY;
  app.innerHTML = `${header()}
  <main>
    ${state.demo ? `<div class="banner demo"><b>Demo data</b><span class="muted">This is sample data so you can try the board. Real Tekmetric data shows once credentials are added.</span></div>` : ''}
    ${state.error ? `<div class="error" role="alert">${esc(state.error)}</div>` : ''}
    ${v === 'week' ? (state.week ? weekView(state.week) : state.error ? '' : '<div class="loading">Loading the week…</div>')
    : v === 'month' ? (state.month ? monthView(state.month) : state.error ? '' : '<div class="loading">Loading the month…</div>')
    : v === 'advisor' ? (b ? `${weekStrip(b)}${noShowBanners(b)}${advisorSummary(b)}${advisorToolbar(b)}${advisorBoard(b)}<p class="foot">Customers due today at their drop-off or waiter time, one card per RO or appointment. Pick an advisor on a booked appointment and it's written to the RO's service writer when the RO opens (only if it has none). Waiting on authorization lists each advisor's open ROs labeled Pending Authorization, Estimating or NEEDS DEPOSIT, oldest first. Updates every minute.</p>` : state.error ? '' : '<div class="loading">Loading the board…</div>')
    : b ? `${weekStrip(b)}${noShowBanners(b)}${summary(b)}${techToolbar(b)}${board(b)}
      <p class="foot">Active load counts sold hours on ROs labeled All Parts Here or In Progress, or promised today. Today's not-arrived appointments always count (1.0 h unless hours were set when assigning). An assigned tech is written to the RO when it opens, only if the RO has no tech yet. Dragging an open RO to another tech (or picking one on the card) moves that tech's jobs on it in Tekmetric right away, with Undo. Parts hold and offsite hours show separately. Pay period = sold hours on ROs marked Complete, 1st–15th and 16th–end of month. Pace = completed − days worked × daily capacity. Carry-over work starts in the afternoon (1:00) so mornings stay open for incoming cars; drag any card to the time a tech will work on it. That plan is for the board only and never moves the customer's appointment in Tekmetric. To move the appointment itself, open the card and change its time, or drag it onto a day above. Click an open time in a tech's column to book there. Updates every minute.</p>`
      : state.error ? '' : '<div class="loading">Loading the board…</div>'}
  </main>`;
  bind();
  // the board sits just below the top menu, whatever its height (it wraps on narrower screens)
  document.documentElement.style.setProperty('--hdr', `${document.querySelector('header')?.offsetHeight ?? 70}px`);
  const boardEl = document.querySelector('.board');
  if (boardEl) {
    boardEl.scrollLeft = prevLeft;
    // first time a day is shown: start the board a little above the red "now" line (or at opening time)
    const dayKey = `${state.view}-${state.shopId}-${state.date}`;
    if (state.scrolledFor !== dayKey) {
      state.scrolledFor = dayKey;
      const nowEl = boardEl.querySelector('.now');
      boardEl.scrollTop = nowEl ? Math.max(0, nowEl.offsetTop - 2.5 * HOUR) : 0;
    } else if (prevBoardTop != null) boardEl.scrollTop = prevBoardTop;
    boardEl.addEventListener('scroll', () => { state.boardLeft = boardEl.scrollLeft; state.boardTop = boardEl.scrollTop; }, { passive: true });
  }
  window.scrollTo(0, prevTop);
  flashCard();
}

function header() {
  return `<header>
    <div class="brand"><div class="logo">TD</div><div><b>Toy Doctor</b><span>Dispatch</span></div></div>
    ${state.shops.length > 1 ? `<div class="seg" role="group" aria-label="Location">${state.shops.map((s) => `<button type="button" data-shop="${s.id}" aria-pressed="${s.id === state.shopId}">${esc(s.name)}</button>`).join('')}</div>` : ''}
    <nav class="views" aria-label="Views">
      ${Object.entries(VIEWS).map(([k, l]) => `<button type="button" data-view="${k}" ${state.view === k ? 'aria-current="page"' : ''}>${l}</button>`).join('')}
    </nav>
    <div class="datenav">
      <button type="button" class="icon-btn" data-go="-1" aria-label="Previous ${unit()}">${icon('M10 3L5 8l5 5')}</button>
      <span class="date">${state.date ? esc(dateLabel()) : ''}</span>
      <button type="button" class="icon-btn" data-go="1" aria-label="Next ${unit()}">${icon('M6 3l5 5-5 5')}</button>
      <button type="button" class="btn" data-today ${state.date === state.today ? 'disabled' : ''}>Today</button>
      <button type="button" class="btn" data-refresh aria-label="Refresh">Refresh</button>
      <button type="button" class="btn primary" data-book>+ Book appointment</button>
    </div>
    ${state.user && !state.authCfg?.disabled ? `<div class="user"><span>${esc(state.user.name)}</span><button type="button" data-signout>Sign out</button></div>` : ''}
  </header>`;
}

const unit = () => ({ week: 'week', month: 'month' })[state.view] ?? 'day';
function dateLabel() {
  if (state.view === 'month') return new Date(`${state.date}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  if (state.view === 'week') { const mon = addDays(state.date, -((new Date(`${state.date}T12:00:00Z`).getUTCDay() + 6) % 7)); return `Week of ${shortDate(mon)}`; }
  return longDate(state.date);
}
function step(n) {
  if (state.view === 'month') return go(monthAdd(state.date, n));
  go(addDays(state.date, state.view === 'week' ? 7 * n : n));
}

function weekStrip(b) {
  return `<section class="week" aria-label="This week">${b.week.map((w) => `
    <button type="button" data-date="${w.date}" ${w.closed ? '' : 'data-dropday'} aria-pressed="${w.date === b.date}" class="${w.closed ? 'closed' : ''}">
      <span class="d">${esc(dayName(w.date))}</span>
      ${w.closed ? '<span class="n muted">Closed</span><span class="s">—</span>'
        : `<span class="n">${w.count} <small>appts</small></span><span class="s ${w.heavy ? 'heavy' : ''}">${w.heavy ? 'Heavy day · ' : ''}${w.waiters} waiter${w.waiters === 1 ? '' : 's'}</span>`}
    </button>`).join('')}</section>`;
}

function noShowBanners(b) {
  return b.noShows.map((n) => `<div class="banner alert" role="status"><span class="dot"></span>
    <div style="flex:1 1 320px;min-width:0"><b>${esc(n.customer)} · ${esc(n.vehicle)} was due at ${fmtHour(n.startHour)} and hasn't arrived</b>
    <small>Not marked arrived, canceled or rescheduled after 1 hour. Its ${fmtH(n.hours)} still counts toward today's load. Dismiss it from today's hours?</small></div>
    <div class="banner-actions">
      <button type="button" class="btn primary" data-ns="noshow" data-id="${n.appointmentId}">Mark no-show</button>
      <button type="button" class="btn" data-ns="resched" data-id="${n.appointmentId}">Reschedule</button>
      <button type="button" class="btn" data-ns="keep" data-id="${n.appointmentId}">Still coming</button>
    </div></div>`).join('');
}

function summary(b) {
  const s = b.summary;
  const pct = s.capacityHours ? Math.round((s.activeHours / s.capacityHours) * 100) : 0;
  return `<section class="summary" aria-label="Day summary">
    <div class="stat"><span class="k">Appointments</span><span class="v">${s.appointments}</span><span class="x">${s.waiters} waiters · ${s.dropoffs} drop-offs</span></div>
    <div class="stat"><span class="k">Shop load (active)</span><span class="v">${s.activeHours.toFixed(1)} <small>/ ${s.capacityHours.toFixed(1)} h</small></span><span class="x">${pct}% of tech capacity</span></div>
    <div class="stat"><span class="k">Parts hold</span><span class="v">${s.partsHold.toFixed(1)} <small>h</small></span><span class="x">${s.partsHoldROs} RO${s.partsHoldROs === 1 ? '' : 's'} · not counted</span></div>
    <div class="stat"><span class="k">Offsite</span><span class="v">${s.offsite.toFixed(1)} <small>h</small></span><span class="x">${s.offsiteROs} RO${s.offsiteROs === 1 ? '' : 's'} · not counted</span></div>
    <div class="stat"><span class="k">Unassigned</span><span class="v" style="color:var(--red)">${s.unassigned}</span><span class="x">${fmtH(s.unassignedHours)}</span></div>
    <div class="legend">${['red', 'yellow', 'blue', 'green', 'purple'].map((c) => `<span class="chip" style="background:var(--c-${c}-bg);color:var(--c-${c}-tx)"><i style="background:var(--c-${c}-dot)"></i>${CAT[c]}</span>`).join('')}</div>
  </section>`;
}

// Which cards can be assigned: booked appointments (no RO yet) and open ROs with no tech.
// Which cards can be moved between techs: booked appointments, and open ROs (written to Tekmetric right away)
const canAssign = (card) => card.kind === 'appt' || (card.kind === 'ro' && card.state !== 'done');
function assignAttrs(card) {
  if (!canAssign(card)) return '';
  const who = `${card.customer} · ${card.vehicle}`;
  return `role="button" tabindex="0" draggable="true" data-assign="${esc(card.key)}" data-key="${esc(card.key)}" aria-label="${esc(card.assignedTechId ? `Change tech for ${who}` : `Assign ${who} to a tech`)}"`;
}

function statusDot(card) {
  if (card.state === 'active') return '#2E8B47';
  if (card.state === 'parts') return '#B88A00';
  if (card.state === 'offsite') return '#5E7C8A';
  if (card.state === 'done') return '#6B7078';
  return '#2F6FCB';
}

function cardHtml(card, col) {
  const c = card.category;
  const width = 100 / col.lanes;
  const top = (card.top - state.board.hours.start) * HOUR;
  const height = Math.max(card.span * HOUR - 4, 40);
  const time = cardTime(card, true);
  const status = card.noShow
    ? `<span class="status warn"><span class="t">No-show? 1 h past</span></span>`
    : card.kind === 'appt'
      ? `<span class="status dashed"><span class="t">${esc(card.label)}${card.assignedTechId ? ' · sets RO tech on arrival' : ''}</span></span>`
      : `<span class="status"><i style="background:${statusDot(card)}"></i><span class="t">RO ${esc(card.roNumber)} · ${esc(card.label)}</span></span>`;
  return `<div class="card ${card.state} ${card.noShow ? 'noshow' : ''}" ${assignAttrs(card) || `draggable="true" data-key="${esc(card.key)}"`} style="top:${top + 2}px;height:${height}px;left:calc(${card.lane * width}% + 6px);width:calc(${width}% - 12px);background:var(--c-${c}-bg);border-color:var(--c-${c}-bd)"
      title="${esc(`${card.customer} · ${card.vehicle}\n${card.work}\n${card.hours} h${card.hoursEstimated ? ' (estimate)' : ''} · ${card.label}${card.alsoOn.length ? `\nAlso on: ${card.alsoOn.join(', ')}` : ''}${card.promisedToday ? '\nPromised today' : ''}`)}">
    <div class="top t" style="color:var(--c-${c}-tx)"><i style="background:var(--c-${c}-dot)"></i>${time} · ${esc(CAT[c])}</div>
    <div class="cust t">${esc(card.customer)} · ${esc(card.vehicle)}</div>
    <div class="work t">${esc(card.work)} · ${card.hours.toFixed(1)} h${card.hoursEstimated ? ' est.' : ''}${card.alsoOn.length ? ` · also ${esc(card.alsoOn.join(', '))}` : ''}</div>
    ${status}
  </div>`;
}

// Top line of a card: when the car comes in, and (on the timeline) when the tech is planned to work it.
function cardTime(card, onTimeline) {
  if (card.dropHour == null) return onTimeline ? `Carry-over · ${fmtHour(card.top)}` : 'Carry-over';
  const arrive = `${card.waiter ? 'Waiting' : 'Drop-off'} ${fmtHour(card.dropHour)}`;
  const moved = onTimeline && Math.abs(card.top - card.dropHour) > 0.01;
  return moved ? `${arrive} · planned ${fmtHour(card.top)}` : arrive;
}

// Unassigned column: a compact list in time order (not on the timeline)
function queueCard(card) {
  const c = card.category;
  const time = cardTime(card, false);
  const status = card.noShow ? '<span class="status warn"><span class="t">No-show? 1 h past</span></span>'
    : card.kind === 'appt' ? `<span class="status dashed"><span class="t">${esc(card.label)}</span></span>`
    : `<span class="status"><i style="background:${statusDot(card)}"></i><span class="t">RO ${esc(card.roNumber)} · ${esc(card.label)}</span></span>`;
  return `<div class="qcard ${card.state} ${card.noShow ? 'noshow' : ''}" ${assignAttrs(card)} style="background:var(--c-${c}-bg);border-color:var(--c-${c}-bd)" title="${esc(`${card.customer} · ${card.vehicle}\n${card.work}`)}">
    <div class="top t" style="color:var(--c-${c}-tx)"><i style="background:var(--c-${c}-dot)"></i>${time} · ${esc(CAT[c])}</div>
    <div class="cust t">${esc(card.customer)} · ${esc(card.vehicle)}</div>
    <div class="work t">${esc(card.work)} · ${card.hours.toFixed(1)} h${card.hoursEstimated ? ' est.' : ''}</div>
    ${status}
  </div>`;
}

function colHead(col) {
  if (col.type === 'unassigned') {
    return `<div class="colhead un pin1"><span class="nm" style="font-weight:600">Unassigned</span>
      <span class="sub">${col.appts} appt${col.appts === 1 ? '' : 's'} · ${fmtH(col.active)}</span>
      <span class="sub">Click a card or drag it onto a tech at the time they'll work it. The tech is written to the RO when it opens.</span></div>`;
  }
  const pct = col.capacity ? Math.min(100, Math.round((col.active / col.capacity) * 100)) : 0;
  const label = { open: 'Open', near: 'Near full', over: 'Over' }[col.status];
  const openTxt = col.open >= 0 ? `${col.open.toFixed(1)} h open` : `${Math.abs(col.open).toFixed(1)} h over`;
  const p = col.pay;
  const pace = p.pace > 0.05 ? `<span class="pace ahead">+${p.pace.toFixed(1)} vs pace</span>` : p.pace < -0.05 ? `<span class="pace behind">−${Math.abs(p.pace).toFixed(1)} vs pace</span>` : '<span class="pace">On pace</span>';
  return `<div class="colhead">
    <div class="who"><div class="avatar">${esc(col.initials)}</div><div style="min-width:0"><span class="nm t" style="display:block">${esc(col.name)}</span><small>${col.appts} RO${col.appts === 1 ? '' : 's'} / appts</small></div><span class="pill ${col.status}">${label}</span></div>
    <div class="load"><span class="num" ${col.status === 'over' ? 'style="color:var(--red)"' : ''}>${col.active.toFixed(1)} <small>/ ${col.capacity.toFixed(1)} h</small></span><span class="open-h ${col.status === 'over' ? 'bad' : col.status === 'open' ? 'good' : ''}">${openTxt}</span></div>
    <div class="bar" role="img" aria-label="${pct}% loaded"><div class="${col.status === 'over' ? 'over' : ''}" style="width:${pct}%"></div></div>
    <span class="sub">Parts hold ${col.partsHold.toFixed(1)} h · Offsite ${col.offsite.toFixed(1)} h</span>
    ${availButton(col)}
    <div class="pay">
      <div class="row"><span class="lbl">Pay period ${esc(shortDate(p.start))}–${esc(new Date(`${p.end}T12:00:00`).getDate())}</span><span class="lbl" style="font-weight:500">${p.daysWorked} of ${p.daysTotal} days</span></div>
      <div class="row"><span class="hrs">${p.completed.toFixed(1)} h <small>completed</small></span>${pace}</div>
    </div>
  </div>`;
}

function visibleColumns(b) {
  return b.columns.filter((c) => c.type !== 'tech' || state.allTechs || !c.out || c.cards.length || c.parked.length);
}

function board(b) {
  const cols = visibleColumns(b);
  const { close, start: open, end } = b.hours;
  const height = (end - open) * HOUR;
  const template = `64px ${cols.map((c) => (c.type === 'unassigned' ? '250px' : `minmax(${c.lanes > 1 ? 200 + (Math.min(c.lanes, 3) - 1) * 110 : 210}px, ${Math.min(c.lanes, 3)}fr)`)).join(' ')}`;
  const nowLine = b.nowHour != null && b.nowHour >= open && b.nowHour <= end ? `<div class="now" style="top:${(b.nowHour - open) * HOUR}px" aria-hidden="true"></div>` : '';
  const closedBand = (end > close ? `<div class="closed-band" style="top:${(close - open) * HOUR}px;height:${(end - close) * HOUR}px" aria-hidden="true"></div>` : '')
    + (open < b.hours.open ? `<div class="closed-band" style="top:0;height:${(b.hours.open - open) * HOUR}px" aria-hidden="true"></div>` : '');
  let times = '';
  for (let h = open; h < end; h++) times += `<span style="top:${(h - open) * HOUR}px">${fmtHour(h)}</span>`;
  const parked = (c) => c.parked.length
    ? c.parked.map((k) => `<div class="item" title="${esc(`${k.customer} · ${k.vehicle} — ${k.work}`)}"><i style="background:${statusDot(k)}"></i><span class="t">RO ${esc(k.roNumber)} · ${esc(k.label)}</span><b>${k.hours.toFixed(1)} h</b></div>`).join('')
    : `<span class="muted">${c.type === 'unassigned' ? 'Not counted in load' : 'Nothing parked'}</span>`;
  return `<section class="board" aria-label="Technician dispatch board">
    <div class="grid" style="grid-template-columns:${template}">
      <div class="pin0 corner"></div>
      ${cols.map(colHead).join('')}
      <div class="times pin0" style="height:${height}px">${times}</div>
      ${cols.map((c) => (c.type === 'unassigned'
        ? `<div class="lane un queue pin1" data-drop="unassigned" style="height:${height}px">${c.cards.length ? c.cards.map(queueCard).join('') : '<span class="muted" style="font-size:12px;padding:6px">Nothing unassigned</span>'}</div>`
        : `<div class="lane ${c.out ? 'is-out' : ''}" data-drop="${c.id}" data-bookat="${c.id}" style="height:${height}px">${closedBand}${awayBand(c, open, end)}${nowLine}${c.cards.map((k) => cardHtml(k, c)).join('')}</div>`)).join('')}
      <div class="parked-label pin0">Parked</div>
      ${cols.map((c) => `<div class="parked ${c.type === 'unassigned' ? 'un pin1' : ''}">${parked(c)}</div>`).join('')}
    </div>
  </section>`;
}

// ---------- availability ----------
const AVAIL_TEXT = (a) => a.status === 'out' ? 'Out today'
  : a.status === 'leave' ? `Leaves at ${fmtHour(a.leaveHour)}`
  : a.status === 'limit' ? `Limit ${a.limitHours} h` : 'In today';

function availButton(col) {
  const a = col.availability ?? { status: 'in' };
  const tone = a.status === 'in' ? 'in' : a.status === 'out' ? 'out' : 'part';
  const extra = [a.capacityToday != null ? `${a.capacityToday} h today` : '', a.note].filter(Boolean).join(' · ');
  return `<button type="button" class="avail ${tone}" data-avail="${col.id}" aria-haspopup="dialog" aria-label="Availability for ${esc(col.name)}: ${esc(AVAIL_TEXT(a))}">
    <i></i><span class="t">${esc(AVAIL_TEXT(a))}${extra ? ` · ${esc(extra)}` : ''}</span>
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"></path></svg>
  </button>`;
}

// gray hatch over the hours a tech isn't here
function awayBand(c, start, end) {
  if (c.out) return `<div class="closed-band away" style="top:0;height:${(end - start) * HOUR}px" aria-hidden="true"><span>Out today</span></div>`;
  const leave = c.availability?.status === 'leave' ? c.availability.leaveHour : null;
  if (leave == null || leave >= end) return '';
  return `<div class="closed-band away" style="top:${(leave - start) * HOUR}px;height:${(end - leave) * HOUR}px" aria-hidden="true"><span>Gone at ${fmtHour(leave)}</span></div>`;
}

function techToolbar(b) {
  const techs = b.columns.filter((c) => c.type === 'tech');
  const out = techs.filter((c) => c.out);
  const onToday = techs.length - out.length;
  return `<div class="toolbar">
    <span style="font-size:13px;font-weight:600">Techs</span>
    <div class="seg" role="group" aria-label="Which techs to show">
      <button type="button" data-techs="today" aria-pressed="${!state.allTechs}">On today (${onToday})</button>
      <button type="button" data-techs="all" aria-pressed="${state.allTechs}">All techs (${techs.length})</button>
    </div>
    <span class="muted" style="font-size:12px">${out.length ? `Out today: ${out.map((c) => esc(c.name)).join(' · ')}` : 'Everyone is in today'}${b.hiddenTechs ? ` · ${b.hiddenTechs} hidden from the board` : ''}</span>
    <button type="button" class="btn" data-manage style="margin-left:auto">Manage techs</button>
  </div>`;
}

function openAvailability(col) {
  const a = col.availability ?? { status: 'in' };
  const leaveOther = a.status === 'leave' && ![13, 14, 15].includes(a.leaveHour);
  const limitOther = a.status === 'limit' && ![2, 4, 6].includes(a.limitHours);
  const toTime = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  const dlg = document.createElement('dialog');
  dlg.className = 'assign';
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(col.name)} · ${esc(longDate(state.date))}</h2>
    <fieldset><legend>Availability</legend>
      <label class="opt"><input type="radio" name="status" value="in" ${a.status === 'in' ? 'checked' : ''}><span style="flex:1">In today</span><span class="muted" style="font-size:12px">Default</span></label>
      <label class="opt"><input type="radio" name="status" value="out" ${a.status === 'out' ? 'checked' : ''}><span style="flex:1">Out today</span></label>
      <label class="opt"><input type="radio" name="status" value="leave" ${a.status === 'leave' ? 'checked' : ''}><span style="flex:1">Leaves early</span></label>
      <div class="chips" data-for="leave">
        ${[13, 14, 15].map((h) => `<label class="chipopt"><input type="radio" name="leaveHour" value="${h}" ${a.leaveHour === h ? 'checked' : ''}><span>${fmtHour(h)}</span></label>`).join('')}
        <label class="chipopt other"><input type="radio" name="leaveHour" value="other" ${leaveOther ? 'checked' : ''}><span>Other</span><input type="time" name="leaveOther" step="900" min="08:15" max="19:00" value="${leaveOther ? toTime(a.leaveHour) : '12:00'}" aria-label="Leave time"></label>
      </div>
      <label class="opt"><input type="radio" name="status" value="limit" ${a.status === 'limit' ? 'checked' : ''}><span style="flex:1">Limit work</span></label>
      <div class="chips" data-for="limit">
        ${[2, 4, 6].map((h) => `<label class="chipopt"><input type="radio" name="limitHours" value="${h}" ${a.limitHours === h ? 'checked' : ''}><span>${h} h</span></label>`).join('')}
        <label class="chipopt other"><input type="radio" name="limitHours" value="other" ${limitOther ? 'checked' : ''}><span>Other</span><input type="number" name="limitOther" min="0.5" max="16" step="0.5" value="${limitOther ? a.limitHours : 3}" aria-label="Limit hours"></label>
      </div>
    </fieldset>
    <label class="hrs-in">Note (optional)<input type="text" name="note" maxlength="60" value="${esc(a.note ?? '')}" placeholder="Dentist, training…" style="width:200px;text-align:left"></label>
    <fieldset><legend>Daily capacity</legend>
      <label class="hrs-in">Hours<input type="number" name="capacity" min="0" max="16" step="0.5" value="${(a.capacityToday ?? col.standingCapacity).toFixed(1)}"></label>
      <div class="chips">
        <label class="chipopt"><input type="radio" name="capScope" value="every" ${a.capacityToday == null ? 'checked' : ''}><span>Every day</span></label>
        <label class="chipopt"><input type="radio" name="capScope" value="today" ${a.capacityToday != null ? 'checked' : ''}><span>Today only</span></label>
      </div>
    </fieldset>
    <p class="note">Out, Leaves early and Limit work also put a matching event on Tekmetric's schedule (e.g. "LEAVES 3:00 – ${esc(col.name)}"), so advisors in Tekmetric see it. Setting In removes it.</p>
    <div class="actions"><span style="flex:1"></span>
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="submit" class="btn primary">Save</button>
    </div>
  </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  const sync = () => { const st = form.status.value; dlg.querySelectorAll('.chips[data-for]').forEach((c) => { c.hidden = c.dataset.for !== st; }); };
  form.addEventListener('change', sync); sync();
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.addEventListener('cancel', () => dlg.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const status = f.get('status');
    const body = { shopId: state.shopId, date: state.date, techId: col.id, status, note: f.get('note') };
    if (status === 'leave') {
      const v = f.get('leaveHour');
      if (!v) return toast('Pick a leave time.', true);
      body.leaveHour = v === 'other' ? (([h, m]) => Number(h) + Number(m) / 60)(String(f.get('leaveOther')).split(':')) : Number(v);
    }
    if (status === 'limit') {
      const v = f.get('limitHours');
      if (!v) return toast('Pick how many hours.', true);
      body.limitHours = v === 'other' ? Number(f.get('limitOther')) : Number(v);
    }
    const capacity = Number(f.get('capacity'));
    if (f.get('capScope') === 'today') body.capacityToday = capacity;
    else if (capacity !== col.standingCapacity) body.capacityEveryDay = capacity;
    try {
      const r = await api('/api/availability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      close();
      const capMsg = body.capacityToday != null ? ` · ${body.capacityToday} h today` : body.capacityEveryDay != null ? ` · ${body.capacityEveryDay} h every day` : '';
      toast(r.syncError ?? `${col.name}: ${AVAIL_TEXT({ ...body })}${capMsg}${status !== 'in' ? ' · added to Tekmetric' : ''}`, Boolean(r.syncError));
      await load(true);
    } catch (err) { if (err.message !== 'signed out') toast(err.message, true); }
  });
  dlg.showModal();
}

async function openManageTechs() {
  let list;
  try { list = (await api(`/api/techs?shop=${state.shopId}`)).techs; } catch (e) { return toast(e.message, true); }
  const dlg = document.createElement('dialog');
  dlg.className = 'assign wide';
  dlg.innerHTML = `<form method="dialog">
    <h2>Manage techs</h2>
    <p class="muted" style="margin:0;font-size:13px">Choose who shows on the board, their order (drag a row or use the arrows), and their usual daily capacity. Everyone Tekmetric lists as able to do work is here.</p>
    <div class="chips"><button type="button" class="btn" data-all="1">Show all</button><button type="button" class="btn" data-all="0">Hide all</button><input type="search" placeholder="Search names" aria-label="Search techs" style="flex:1;height:44px;border:1px solid var(--line);border-radius:8px;padding:0 10px;font:inherit"></div>
    <div class="techlist">${list.map((t) => `<div class="techrow" draggable="true" data-id="${t.id}" data-name="${esc(t.name.toLowerCase())}">
      <span class="grip" aria-hidden="true">⋮⋮</span>
      <span class="moves"><button type="button" class="mv" data-mv="-1" aria-label="Move ${esc(t.name)} up">▲</button><button type="button" class="mv" data-mv="1" aria-label="Move ${esc(t.name)} down">▼</button></span>
      <label style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;min-height:44px"><input type="checkbox" name="show" value="${t.id}" ${t.show ? 'checked' : ''}><span class="t">${esc(t.name)}</span><small class="muted">${esc(t.role)}</small></label>
      <label class="muted" style="font-size:12px;display:flex;align-items:center;gap:6px">h/day<input type="number" name="cap-${t.id}" min="0" max="16" step="0.5" value="${t.capacity}" style="width:72px;height:36px;border:1px solid var(--line);border-radius:8px;padding:0 8px;font:inherit;text-align:right"></label>
    </div>`).join('')}</div>
    <div class="actions"><span style="flex:1"></span><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
  </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.addEventListener('cancel', () => dlg.remove());
  dlg.querySelectorAll('[data-all]').forEach((b) => b.addEventListener('click', () => dlg.querySelectorAll('.techrow:not([hidden]) input[name=show]').forEach((c) => { c.checked = b.dataset.all === '1'; })));
  // order: arrows, or drag a row
  const listEl = dlg.querySelector('.techlist');
  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mv]'); if (!b) return;
    const row = b.closest('.techrow');
    if (b.dataset.mv === '-1' && row.previousElementSibling) row.previousElementSibling.before(row);
    if (b.dataset.mv === '1' && row.nextElementSibling) row.nextElementSibling.after(row);
    b.focus();
  });
  let dragRow = null;
  listEl.addEventListener('dragstart', (e) => { dragRow = e.target.closest('.techrow'); dragRow?.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  listEl.addEventListener('dragend', () => { dragRow?.classList.remove('dragging'); dragRow = null; });
  listEl.addEventListener('dragover', (e) => {
    if (!dragRow) return; e.preventDefault();
    const over = e.target.closest('.techrow'); if (!over || over === dragRow) return;
    const r = over.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) over.before(dragRow); else over.after(dragRow);
  });
  dlg.querySelector('input[type=search]').addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); dlg.querySelectorAll('.techrow').forEach((r) => { r.hidden = !r.dataset.name.includes(q); }); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const order = [...listEl.querySelectorAll('.techrow')].map((r) => Number(r.dataset.id));
    const reordered = order.some((id, i) => id !== list[i].id);
    const changes = list.map((t) => ({ techId: t.id, show: form.querySelector(`input[name=show][value="${t.id}"]`).checked, capacity: Number(form.querySelector(`input[name="cap-${t.id}"]`).value), ...(reordered ? { order: order.indexOf(t.id) } : {}) }))
      .filter((c, i) => reordered || c.show !== list[i].show || c.capacity !== list[i].capacity);
    try {
      if (changes.length) await api('/api/techs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopId: state.shopId, changes }) });
      close(); toast(reordered ? 'Tech order saved' : changes.length ? `Saved ${changes.length} change${changes.length === 1 ? '' : 's'}` : 'No changes'); await load(true);
    } catch (err) { if (err.message !== 'signed out') toast(err.message, true); }
  });
  dlg.showModal();
}

// ---------- assigning ----------
function findCard(key) {
  for (const c of state.board.columns) for (const k of [...c.cards, ...c.parked]) if (k.key === key) return k;
  return null;
}
const colOf = (key) => state.board.columns.find((c) => c.cards.some((k) => k.key === key) || c.parked.some((k) => k.key === key));
const techCols = () => state.board.columns.filter((c) => c.type === 'tech' && (!c.out || state.allTechs));

async function plan(key, hour) {
  await api('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopId: state.shopId, date: state.date, key, hour }) });
}

async function assign(card, techId, hours, atHour, isUndo) {
  const from = card.kind === 'ro' ? card.assignedTechId ?? null : null;
  if (card.kind === 'ro' && from != null && from === techId) {
    if (atHour != null) { await plan(card.key, atHour).catch(() => {}); state.flash = card.key; await load(true); }
    return;
  }
  const body = card.kind === 'appt'
    ? { shopId: state.shopId, appointmentId: card.appointmentId, techId, hours }
    : { shopId: state.shopId, roId: card.roId, techId, fromTechId: from };
  try {
    await api('/api/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (atHour != null && techId != null) await plan(card.kind === 'ro' ? `ro-${card.roId}-${techId}` : card.key, atHour);
    state.flash = techId == null ? card.key : card.kind === 'ro' ? `ro-${card.roId}-${techId}` : card.key;
    if (techId == null && card.kind === 'appt') await plan(card.key, null);
    const tech = state.board.columns.find((c) => c.id === techId)?.name;
    const fromName = state.board.columns.find((c) => c.id === from)?.name;
    const undo = card.kind === 'ro' && from != null && !isUndo
      ? { label: 'Undo', fn: () => assign({ ...card, key: `ro-${card.roId}-${techId}`, assignedTechId: techId }, from, null, null, true) } : null;
    toast(techId == null ? `${card.customer} moved back to Unassigned`
      : card.kind === 'ro' ? (from != null ? `RO ${card.roNumber}: ${fromName}'s work moved to ${tech} in Tekmetric` : `RO ${card.roNumber}: technician set to ${tech} in Tekmetric`)
      : `${card.customer} → ${tech} · RO tech is set when it opens`, false, undo);
    await load(true);
  } catch (e) { if (e.message !== 'signed out') toast(e.message, true); }
}

// ---------- appointments in Tekmetric: reschedule, no-show, cancel ----------
// Changes the appointment itself in Tekmetric. `undo` puts back what was there.
async function changeAppt(card, change, message, undo) {
  try {
    const r = await api(`/api/appointments/${card.appointmentId}`, json('PATCH', { shopId: state.shopId, knownStart: card.startTime, ...change }));
    if (!change.status && r.date === state.date) state.flash = card.key;
    toast(message, false, undo ? { label: 'Undo', fn: () => changeAppt(card, undo, 'Undone') } : null);
    await load(true);
    return true;
  } catch (e) { if (e.message !== 'signed out') toast(e.message, true); return false; }
}
const whenText = (date, hour) => `${date === state.date ? '' : `${shortDate(date)} `}${fmtHour(hour)}`;
const wasAt = (card) => ({ date: card.date ?? state.date, startHour: card.startHour, dropHour: card.dropHour != null && card.dropHour < card.startHour ? card.dropHour : null });
const markNoShow = (card) => changeAppt(card, { status: 'NO_SHOW' }, `${card.customer} marked no-show in Tekmetric · off today's hours`, { status: 'NONE' });
const cancelAppt = (card) => changeAppt(card, { status: 'CANCELED' }, `${card.customer}'s appointment canceled in Tekmetric`, { status: 'NONE' });
async function keepComing(card) {
  try { await api('/api/noshow/keep', json('POST', { shopId: state.shopId, date: state.date, appointmentId: card.appointmentId })); toast(`OK — ${card.customer} stays on today's board`); await load(true); }
  catch (e) { if (e.message !== 'signed out') toast(e.message, true); }
}

const tekLink = (card) => (state.demo || !card.roId ? '' : `<a class="btn linkout" href="https://shop.tekmetric.com/admin/shop/${state.shopId}/repair-orders/${card.roId}/estimate" target="_blank" rel="noopener">Open RO in Tekmetric ↗</a>`);
function openAssign(card) {
  // an appointment, or an RO opened from today's appointment: the full editor
  if (card.kind === 'appt' || card.appointmentId) return openApptEdit(card);
  const current = card.assignedTechId;
  const dlg = document.createElement('dialog');
  dlg.className = 'assign';
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(card.customer)} · ${esc(card.vehicle)}</h2>
    <p class="muted" style="margin:0">RO ${esc(card.roNumber)} · ${esc(card.work)}${card.waiter ? ' · Waiter' : ''}</p>
    <fieldset><legend>Technician</legend>
      ${techCols().map((t) => `<label class="opt"><input type="radio" name="tech" value="${t.id}" ${t.id === current ? 'checked' : ''} required>
        <span class="t" style="flex:1">${esc(t.name)}</span><span class="pill ${t.status}">${t.active.toFixed(1)} / ${t.capacity.toFixed(1)} h</span></label>`).join('')}
    </fieldset>
    <p class="note">${current ? `Moves ${esc(techCols().find((t) => t.id === current)?.name ?? 'this tech')}'s jobs on RO ${esc(card.roNumber)} (${card.hours.toFixed(1)} h) to the tech you pick, in Tekmetric, right away. Other techs' jobs on the RO stay as they are.`
      : `Sets this tech on RO ${esc(card.roNumber)} and on any of its jobs without a tech, in Tekmetric, right away.`}</p>
    <p class="note">No appointment for this RO today, so its other details are changed in Tekmetric.</p>
    <div class="actions">${tekLink(card)}<span style="flex:1"></span><button type="button" class="btn" data-cancel>Close</button><button type="submit" class="btn primary">${current ? 'Save' : 'Assign'}</button></div>
  </form>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.addEventListener('cancel', () => dlg.remove());
  dlg.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const techId = Number(new FormData(e.target).get('tech'));
    close(); if (techId !== current) assign(card, techId);
  });
  dlg.showModal();
}

// Edit a booked appointment: everything Tekmetric lets us change, plus the board's tech, hours and advisor.
function openApptEdit(card) {
  const b = state.board;
  const isRO = card.kind === 'ro';
  const canDismiss = !isRO || card.notArrived; // no-show / cancel only before the customer arrives
  const advisorName = advisorList().find((a) => a.id === card.advisorId)?.name ?? card.advisor ?? '';
  const was = wasAt(card);
  const allT = b.columns.filter((c) => c.type === 'tech');
  const cat = CAT_KEYS.includes(card.category) ? card.category : null;
  const ride = ['LOANER', 'RIDE'].includes(card.rideOption) ? card.rideOption : 'NONE';
  const dlg = document.createElement('dialog');
  dlg.className = 'assign wide book';
  dlg.innerHTML = `<form method="dialog" autocomplete="off">
    <h2>Edit appointment</h2>
    <p class="muted" style="margin:0"><b style="color:var(--ink)">${esc(card.customer)}</b>${isRO ? ` · RO ${esc(card.roNumber)}` : ''} · ${esc(card.label)}${card.noShow ? ' · <span style="color:var(--red)">1 h past, not arrived</span>' : ''}</p>
    <label class="field">Vehicle<select name="vehicle"><option value="${card.vehicleId ?? ''}">${esc(card.vehicle || 'Loading vehicles…')}</option></select></label>
    <fieldset><legend>Type of work</legend><div class="kinds">
      ${CAT_KEYS.map((c) => `<label class="kind" style="--bg:var(--c-${c}-bg);--bd:var(--c-${c}-bd);--dot:var(--c-${c}-dot)"><input type="radio" name="category" value="${c}" ${c === cat ? 'checked' : ''} required><i></i><span>${esc(CAT[c])}</span></label>`).join('')}
    </div></fieldset>
    <div class="field"><label for="ed-concern">Concern / work requested</label><textarea id="ed-concern" name="concern" rows="2" maxlength="500" required>${esc(card.description || card.work)}</textarea></div>
    <div class="row3">
      <label>Date<input type="date" name="date" value="${was.date}" required></label>
      <label>Appointment<input type="time" name="time" step="900" value="${toHM(card.startHour)}" required></label>
      <label>Drop-off <span class="muted">(optional)</span><input type="time" name="drop" step="900" value="${was.dropHour != null ? toHM(was.dropHour) : ''}"></label>
    </div>
    <div class="row3">
      <label>Pick-up <span class="muted" data-pickreq>${ride === 'NONE' ? '(optional)' : '(required)'}</span><input type="time" name="pick" step="900" value="${card.pickupHour != null ? toHM(card.pickupHour) : ''}"></label>
      <label>${isRO ? 'Hours on RO' : 'Est. hours'}<input type="number" name="hours" min="0.1" max="24" step="0.1" value="${card.hours.toFixed(1)}" ${isRO ? 'disabled title="Sold hours come from the RO in Tekmetric"' : ''}></label>
    </div>
    <div class="row3">
      <label style="grid-column:span 2">Technician<select name="tech">${isRO && card.assignedTechId ? '' : '<option value="">Unassigned</option>'}${allT.map((t) => `<option value="${t.id}" ${t.id === card.assignedTechId ? 'selected' : ''}>${esc(t.name)} · ${t.out ? 'out' : t.open >= 0 ? `${t.open.toFixed(1)} h open` : `${Math.abs(t.open).toFixed(1)} h over`}</option>`).join('')}</select></label>
      ${isRO && card.advisorId
        ? `<label>Service advisor<select name="advisor" disabled title="Set on the RO in Tekmetric"><option value="${card.advisorId}">${esc(advisorName || 'Set in Tekmetric')}</option></select></label>`
        : `<label>Service advisor<select name="advisor"><option value="">None</option>${advisorList().map((a) => `<option value="${a.id}" ${a.id === card.advisorId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>`}
    </div>
    <fieldset><legend>Ride</legend><div class="chips" style="padding-left:0">
      ${[['NONE', 'None'], ['LOANER', 'Loaner'], ['RIDE', 'Ride / shuttle']].map(([v, l]) => `<label class="chipopt"><input type="radio" name="ride" value="${v}" ${v === ride ? 'checked' : ''}><span>${l}</span></label>`).join('')}
    </div></fieldset>
    <p class="note">${isRO
      ? `Date, time, vehicle, type, concern and ride are saved to the appointment in Tekmetric. Changing the tech moves ${card.assignedTechId ? 'this tech\'s' : 'the'} jobs on RO ${esc(card.roNumber)} in Tekmetric right away.`
      : 'Date, time, vehicle, type, concern and ride are saved to the appointment in Tekmetric. Tech, hours and advisor are written to the RO when it opens (only where blank).'}</p>
    <div class="actions minor">
      ${canDismiss ? '<button type="button" class="btn" data-noshow>Mark no-show</button><button type="button" class="btn" data-cancelappt>Cancel appointment</button>' : ''}
      ${tekLink(card)}
    </div>
    <div class="actions"><span style="flex:1"></span><button type="button" class="btn" data-cancel>Close</button><button type="submit" class="btn primary">Save</button></div>
  </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  // a message shown while the window was open stays on screen after it closes
  const close = () => { const t = dlg.querySelector('.toast'); if (t) document.body.appendChild(t); dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.addEventListener('cancel', () => dlg.remove());
  dlg.querySelector('[data-noshow]')?.addEventListener('click', () => { close(); markNoShow(card); });
  dlg.querySelector('[data-cancelappt]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (!btn.dataset.sure) { btn.dataset.sure = '1'; btn.textContent = 'Click again to cancel it in Tekmetric'; btn.classList.add('danger'); return; }
    close(); cancelAppt(card);
  });
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'ride') return;
    const need = e.target.value !== 'NONE';
    dlg.querySelector('[data-pickreq]').textContent = need ? '(required)' : '(optional)';
    if (need && !form.pick.value) form.pick.value = '17:00';
  });
  // the customer's vehicles, so a different one can be picked
  if (card.customerId) {
    api(`/api/vehicles?shop=${state.shopId}&customerId=${card.customerId}`).then((r) => {
      if (!r.vehicles.length) return;
      form.vehicle.innerHTML = r.vehicles.map((v) => `<option value="${v.id}" ${v.id === card.vehicleId ? 'selected' : ''}>${esc(v.text)}${v.plate ? ` · ${esc(v.plate)}` : ''}</option>`).join('');
    }).catch(() => {});
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const date = f.get('date'); const startHour = fromHM(f.get('time')); const dropHour = fromHM(f.get('drop')); const pickHour = fromHM(f.get('pick'));
    if (dropHour != null && dropHour > startHour) return toast('Drop-off should be at or before the appointment time.', true);
    const rideNow = f.get('ride');
    if (rideNow !== 'NONE' && pickHour == null) return toast('Add a pick-up time for the loaner or ride.', true);
    const change = {};
    const moved = date !== was.date || Math.abs(startHour - was.startHour) > 0.01 || (dropHour ?? null) !== (was.dropHour ?? null);
    if (moved) Object.assign(change, { date, startHour, dropHour });
    if (f.get('category') !== cat) change.category = f.get('category');
    if (String(f.get('concern')).trim() !== String(card.description || card.work).trim()) change.concern = f.get('concern');
    if (f.get('vehicle') && Number(f.get('vehicle')) !== card.vehicleId) change.vehicleId = Number(f.get('vehicle'));
    if (rideNow !== ride || (pickHour ?? null) !== (card.pickupHour ?? null)) Object.assign(change, { rideOption: rideNow, pickupHour: pickHour });
    const techId = f.get('tech') ? Number(f.get('tech')) : null;
    const hours = isRO ? card.hours : Number(f.get('hours')) || card.hours;
    const advisorId = isRO && card.advisorId ? card.advisorId : f.get('advisor') ? Number(f.get('advisor')) : null;
    const retech = techId !== (card.assignedTechId ?? null) || Math.abs(hours - card.hours) > 0.01;
    const readv = advisorId !== (card.advisorId ?? null);
    if (isRO && retech && techId == null) return toast('An open RO needs a tech. Pick one.', true);
    const btn = form.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (retech) {
        await api('/api/assign', json('POST', isRO
          ? { shopId: state.shopId, roId: card.roId, techId, fromTechId: card.assignedTechId ?? null }
          : { shopId: state.shopId, appointmentId: card.appointmentId, techId, hours }));
        if (isRO) card = { ...card, key: `ro-${card.roId}-${techId}`, assignedTechId: techId };
      }
      if (readv) await api('/api/advisor', json('POST', isRO ? { shopId: state.shopId, roId: card.roId, advisorId } : { shopId: state.shopId, appointmentId: card.appointmentId, advisorId }));
    } catch (err) { btn.disabled = false; btn.textContent = 'Save'; if (err.message !== 'signed out') toast(err.message, true); return; }
    if (!Object.keys(change).length) {
      close(); state.flash = card.key; toast(retech || readv ? `${card.customer}: saved` : 'No changes'); if (retech || readv) await load(true); return;
    }
    const onlyMoved = Object.keys(change).every((k) => ['date', 'startHour', 'dropHour'].includes(k));
    const ok = await changeAppt(card, change, moved ? `${card.customer} moved to ${whenText(date, startHour)} in Tekmetric` : `${card.customer}'s appointment updated in Tekmetric`, onlyMoved ? was : null);
    if (ok) close(); else { btn.disabled = false; btn.textContent = 'Save'; }
  });
  dlg.showModal();
}

// ---------- booking ----------
const KIND_HOURS = { red: 3, yellow: 1, blue: 1.5, green: 1, purple: 2 };
const CAT_KEYS = ['red', 'yellow', 'blue', 'green', 'purple'];
function openBook(pre = {}) {
  const b = state.board;
  const allT = b.columns.filter((c) => c.type === 'tech');
  const startHour = pre.hour ?? Math.max(b.hours.open, Math.min(Math.ceil(((b.isToday ? b.nowHour : 0) ?? 0) * 2) / 2, 16));
  const techOpts = (date) => `<option value="">Unassigned</option>${allT.map((t) => `<option value="${t.id}" ${t.id === pre.techId ? 'selected' : ''}>${esc(t.name)}${date === state.date ? ` · ${t.out ? 'out' : t.open >= 0 ? `${t.open.toFixed(1)} h open` : `${Math.abs(t.open).toFixed(1)} h over`}` : ''}</option>`).join('')}`;
  const dlg = document.createElement('dialog');
  dlg.className = 'assign wide book';
  dlg.innerHTML = `<form method="dialog" autocomplete="off">
    <h2>Book appointment</h2>
    <div class="field">
      <label for="bk-q">Customer</label>
      <div data-picked hidden class="picked"><span class="t"></span><button type="button" class="linkbtn" data-change>Change</button></div>
      <input id="bk-q" type="search" placeholder="Name or phone number" aria-describedby="bk-hint">
      <div class="results" data-results role="listbox" aria-label="Matching customers"></div>
      <span id="bk-hint" class="note">New customer? Add them in Tekmetric first, then search here.</span>
    </div>
    <fieldset data-vehicles hidden><legend>Vehicle</legend><div data-vlist></div></fieldset>
    <fieldset><legend>Type of work</legend><div class="kinds">
      ${['red', 'yellow', 'blue', 'green', 'purple'].map((c) => `<label class="kind" style="--bg:var(--c-${c}-bg);--bd:var(--c-${c}-bd);--dot:var(--c-${c}-dot)"><input type="radio" name="category" value="${c}" required><i></i><span>${esc(CAT[c])}</span></label>`).join('')}
    </div></fieldset>
    <div class="field"><label for="bk-concern">Concern / work requested</label><textarea id="bk-concern" name="concern" rows="2" maxlength="500" required placeholder="e.g. Check engine light, 60k service"></textarea></div>
    <div class="row3">
      <label>Date<input type="date" name="date" value="${pre.date ?? state.date}" required></label>
      <label>Appointment<input type="time" name="time" step="900" value="${toHM(startHour)}" required></label>
      <label>Drop-off <span class="muted">(optional)</span><input type="time" name="drop" step="900"></label>
    </div>
    <div class="row3">
      <label>Pick-up <span class="muted" data-pickreq>(optional)</span><input type="time" name="pick" step="900"></label>
    </div>
    <div class="row3">
      <label>Est. hours<input type="number" name="hours" min="0.1" max="24" step="0.1" value="1.0"></label>
      <label style="grid-column:span 2">Technician<select name="tech">${techOpts(pre.date ?? state.date)}</select></label>
    </div>
    <div class="row3">
      <label style="grid-column:span 2">Service advisor<select name="advisor"><option value="">Unassigned</option>${advisorList().map((a) => `<option value="${a.id}" ${a.id === (pre.advisorId ?? b.me) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
    </div>
    <fieldset><legend>Ride</legend><div class="chips" style="padding-left:0">
      ${[['NONE', 'None'], ['LOANER', 'Loaner'], ['RIDE', 'Ride / shuttle']].map(([v, l], i) => `<label class="chipopt"><input type="radio" name="ride" value="${v}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}
    </div></fieldset>
    <p class="note">Books the appointment in Tekmetric with the matching color. Waiters are booked green (Tekmetric's API can't set "Stay with vehicle"). The tech is set on the RO when it opens.</p>
    <div class="actions"><span style="flex:1"></span><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Book</button></div>
  </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  const q = dlg.querySelector('#bk-q'); const results = dlg.querySelector('[data-results]');
  const picked = dlg.querySelector('[data-picked]'); const vbox = dlg.querySelector('[data-vehicles]');
  let customer = null; let vehicles = []; let timer = null; let seq = 0; let hoursTouched = false;
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.addEventListener('cancel', () => dlg.remove());
  form.hours.addEventListener('input', () => { hoursTouched = true; });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'category' && !hoursTouched) form.hours.value = KIND_HOURS[e.target.value].toFixed(1);
    if (e.target.name === 'ride') {
      const need = e.target.value !== 'NONE';
      dlg.querySelector('[data-pickreq]').textContent = need ? '(required)' : '(optional)';
      if (need && !form.pick.value) form.pick.value = '17:00';
    }
    if (e.target.name === 'date') { const keep = form.tech.value; form.tech.innerHTML = techOpts(e.target.value); form.tech.value = keep; }
  });
  q.addEventListener('input', () => {
    clearTimeout(timer);
    const term = q.value.trim();
    if (term.length < 2) { results.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      results.innerHTML = '<span class="muted" style="padding:8px">Searching…</span>';
      try {
        const r = await api(`/api/customers?shop=${state.shopId}&q=${encodeURIComponent(term)}`);
        if (my !== seq) return;
        results.innerHTML = r.customers.length ? r.customers.map((c, i) => `<button type="button" class="opt" role="option" data-i="${i}"><span class="t" style="flex:1;text-align:left"><b>${esc(c.name)}</b></span><span class="muted">${esc(c.phone)}</span></button>`).join('')
          : '<span class="muted" style="padding:8px">No match. Add new customers in Tekmetric first.</span>';
        results.querySelectorAll('[data-i]').forEach((el) => el.addEventListener('click', () => pick(r.customers[Number(el.dataset.i)])));
      } catch (e) { if (my === seq) results.innerHTML = `<span class="error" style="padding:8px">${esc(e.message)}</span>`; }
    }, 250);
  });
  async function pick(c) {
    customer = c; results.innerHTML = ''; q.hidden = true;
    picked.hidden = false; picked.querySelector('.t').textContent = `${c.name}${c.phone ? ` · ${c.phone}` : ''}`;
    vbox.hidden = false; const list = vbox.querySelector('[data-vlist]'); list.innerHTML = '<span class="muted">Loading vehicles…</span>';
    try {
      vehicles = (await api(`/api/vehicles?shop=${state.shopId}&customerId=${c.id}`)).vehicles;
      list.innerHTML = vehicles.length ? vehicles.map((v, i) => `<label class="opt"><input type="radio" name="vehicle" value="${v.id}" ${vehicles.length === 1 || i === 0 ? 'checked' : ''} required><span class="t" style="flex:1">${esc(v.text)}</span>${v.plate ? `<span class="muted">${esc(v.plate)}</span>` : ''}</label>`).join('')
        : '<span class="muted">No vehicles on file. Add the vehicle in Tekmetric first.</span>';
    } catch (e) { list.innerHTML = `<span class="error">${esc(e.message)}</span>`; }
    form.querySelector('input[name=category]')?.focus();
  }
  picked.querySelector('[data-change]').addEventListener('click', () => { customer = null; picked.hidden = true; vbox.hidden = true; q.hidden = false; q.focus(); q.select(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    if (!customer) { q.focus(); return toast('Pick a customer first.', true); }
    const vehicle = vehicles.find((v) => v.id === Number(f.get('vehicle')));
    if (!vehicle) return toast('Pick a vehicle.', true);
    const start = fromHM(f.get('time')); const drop = fromHM(f.get('drop'));
    if (drop != null && drop > start) return toast('Drop-off should be at or before the appointment time.', true);
    const pick = fromHM(f.get('pick'));
    if (f.get('ride') !== 'NONE' && pick == null) return toast('Add a pick-up time for the loaner or ride.', true);
    const body = {
      shopId: state.shopId, customerId: customer.id, vehicleId: vehicle.id, title: `${customer.lastName} – ${vehicle.model}`,
      category: f.get('category'), concern: f.get('concern'), date: f.get('date'), startHour: start, dropHour: drop,
      hours: Number(f.get('hours')), techId: f.get('tech') || null, advisorId: f.get('advisor') || null, rideOption: f.get('ride'), pickupHour: pick,
    };
    const btn = form.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = 'Booking…';
    try {
      const r = await api('/api/appointments', json('POST', body));
      close();
      const tech = allT.find((t) => t.id === Number(body.techId))?.name;
      if (body.date === state.date) state.flash = `appt-${r.appointmentId}`;
      toast(`Booked ${customer.lastName} · ${whenText(body.date, start)}${tech ? ` · ${tech}` : ''} — in Tekmetric now`);
      await load(true);
    } catch (err) { btn.disabled = false; btn.textContent = 'Book'; if (err.message !== 'signed out') toast(err.message, true); }
  });
  dlg.showModal();
  q.focus();
}

// ---------- Day – Service Advisor ----------
const advisorList = () => (state.board?.advisorView?.columns ?? []).filter((c) => c.type === 'advisor');
async function bookFrom(pre) {
  try { await ensureBoard(); openBook(pre); } catch (e) { if (e.message !== 'signed out') toast(e.message, true); }
}
const sinceText = (iso) => {
  if (!iso) return '';
  const h = (Date.now() - Date.parse(iso)) / 3600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 24 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
};

function advisorSummary(b) {
  const cols = b.advisorView.columns;
  const all = cols.flatMap((c) => c.cards);
  const waiting = cols.reduce((t, c) => t + c.waiting.length, 0);
  const un = cols.find((c) => c.type === 'unassigned');
  return `<section class="summary" aria-label="Advisor summary">
    <div class="stat"><span class="k">Customers due</span><span class="v">${all.length}</span><span class="x">${all.filter((k) => k.waiter).length} waiters · ${all.filter((k) => k.kind === 'appt' && k.state === 'notArrived').length} not arrived</span></div>
    <div class="stat"><span class="k">Waiting on authorization</span><span class="v" ${waiting ? 'style="color:var(--red)"' : ''}>${waiting}</span><span class="x">ROs to call on</span></div>
    ${b.advisorView.missing?.length ? `<div class="stat"><span class="k">Not found in Tekmetric</span><span class="v" style="font-size:16px">${esc(b.advisorView.missing.join(', '))}</span><span class="x">Check the name in settings</span></div>` : ''}
    <div class="stat"><span class="k">No advisor yet</span><span class="v">${un.cards.length}</span><span class="x">${un.waiting.length ? `${un.waiting.length} waiting RO${un.waiting.length === 1 ? '' : 's'} too` : 'Click a card to assign'}</span></div>
    <div class="legend">${['red', 'yellow', 'blue', 'green', 'purple'].map((c) => `<span class="chip" style="background:var(--c-${c}-bg);color:var(--c-${c}-tx)"><i style="background:var(--c-${c}-dot)"></i>${CAT[c]}</span>`).join('')}</div>
  </section>`;
}

function advisorToolbar(b) {
  const n = b.advisorView.columns.filter((c) => c.type === 'advisor').length;
  const other = b.advisorView.columns.find((c) => c.type === 'other');
  return `<div class="toolbar">
    <span style="font-size:13px;font-weight:600">Advisors</span>
    <span class="muted" style="font-size:12px">${n} on the board${other ? ` · ${other.cards.length + other.waiting.length} RO${other.cards.length + other.waiting.length === 1 ? '' : 's'} by other writers` : ''}</span>
    <button type="button" class="btn" data-manage-adv style="margin-left:auto">Manage advisors</button>
  </div>`;
}

// drag a row or use its arrows to reorder a list in a dialog
function bindReorder(listEl, rowSel) {
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mv]'); if (!btn) return;
    const row = btn.closest(rowSel);
    if (btn.dataset.mv === '-1' && row.previousElementSibling) row.previousElementSibling.before(row);
    if (btn.dataset.mv === '1' && row.nextElementSibling) row.nextElementSibling.after(row);
    btn.focus();
  });
  let dragRow = null;
  listEl.addEventListener('dragstart', (e) => { dragRow = e.target.closest(rowSel); dragRow?.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  listEl.addEventListener('dragend', () => { dragRow?.classList.remove('dragging'); dragRow = null; });
  listEl.addEventListener('dragover', (e) => {
    if (!dragRow) return; e.preventDefault();
    const over = e.target.closest(rowSel); if (!over || over === dragRow) return;
    const r = over.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) over.before(dragRow); else over.after(dragRow);
  });
}

async function openManageAdvisors() {
  let list;
  try { list = (await api(`/api/advisors?shop=${state.shopId}`)).advisors; } catch (e) { return toast(e.message, true); }
  const shop = state.shops.find((x) => x.id === state.shopId)?.name ?? '';
  const dlg = document.createElement('dialog');
  dlg.className = 'assign wide';
  dlg.innerHTML = `<form method="dialog">
    <h2>Manage advisors${shop ? ` · ${esc(shop)}` : ''}</h2>
    <p class="muted" style="margin:0;font-size:13px">Check who gets a column on the Service Advisor view, and set the order (drag a row or use the arrows). ROs written by anyone unchecked go in one "Other writers" column.</p>
    <input type="search" placeholder="Search names" aria-label="Search people" style="height:44px;border:1px solid var(--line);border-radius:8px;padding:0 10px;font:inherit">
    <div class="techlist">${list.map((a) => `<div class="techrow" draggable="true" data-id="${a.id}" data-name="${esc(a.name.toLowerCase())}">
      <span class="grip" aria-hidden="true">⋮⋮</span>
      <span class="moves"><button type="button" class="mv" data-mv="-1" aria-label="Move ${esc(a.name)} up">▲</button><button type="button" class="mv" data-mv="1" aria-label="Move ${esc(a.name)} down">▼</button></span>
      <label style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;min-height:44px"><input type="checkbox" name="show" value="${a.id}" ${a.show ? 'checked' : ''}><span class="t">${esc(a.name)}</span><small class="muted">${esc(a.role || (a.tech ? 'Technician' : ''))}</small></label>
    </div>`).join('')}</div>
    <div class="actions"><span style="flex:1"></span><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button></div>
  </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form'); const listEl = dlg.querySelector('.techlist');
  const close = () => { const t = dlg.querySelector('.toast'); if (t) document.body.appendChild(t); dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.addEventListener('cancel', () => dlg.remove());
  bindReorder(listEl, '.techrow');
  dlg.querySelector('input[type=search]').addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); dlg.querySelectorAll('.techrow').forEach((r) => { r.hidden = !r.dataset.name.includes(q); }); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const order = [...listEl.querySelectorAll('.techrow')].map((r) => Number(r.dataset.id));
    const show = [...form.querySelectorAll('input[name=show]:checked')].map((c) => Number(c.value));
    try {
      const r = await api('/api/advisors', json('POST', { shopId: state.shopId, order, show }));
      close(); toast(`Saved · ${r.shown} advisor${r.shown === 1 ? '' : 's'} on the board`); await load(true);
    } catch (err) { if (err.message !== 'signed out') toast(err.message, true); }
  });
  dlg.showModal();
}

// SA cards: appointments can always get an advisor; an RO only if it has no service writer yet
const saPickable = (k) => k.kind === 'appt' || (k.kind === 'ro' && !k.advisorId && k.state !== 'done');
function saCard(k, col, start) {
  const c = k.category; const width = 100 / col.lanes;
  const status = k.noShow ? '<span class="status warn"><span class="t">No-show? 1 h past</span></span>'
    : k.kind === 'appt' ? `<span class="status dashed"><span class="t">${esc(k.label)}${k.advisorId ? ' · sets RO advisor on arrival' : ''}</span></span>`
    : `<span class="status"><i style="background:${statusDot(k)}"></i><span class="t">RO ${esc(k.roNumber)} · ${esc(k.label)}</span></span>`;
  const attrs = saPickable(k) ? `role="button" tabindex="0" draggable="true" data-sa="${esc(k.key)}" aria-label="${esc(`Pick advisor for ${k.customer} · ${k.vehicle}`)}"` : '';
  return `<div class="card ${k.state} ${k.noShow ? 'noshow' : ''}" ${attrs} data-key="${esc(k.key)}" style="top:${(k.top - start) * HOUR + 2}px;height:${k.span * HOUR - 4}px;left:calc(${k.lane * width}% + 6px);width:calc(${width}% - 12px);background:var(--c-${c}-bg);border-color:var(--c-${c}-bd)"
    title="${esc(`${k.customer} · ${k.vehicle}\n${k.work}\n${k.techs.length ? `Tech: ${k.techs.join(', ')}` : 'No tech yet'} · ${k.hours} h`)}">
    <div class="top t" style="color:var(--c-${c}-tx)"><i style="background:var(--c-${c}-dot)"></i>${k.waiter ? 'Waiting' : 'Drop-off'} ${fmtHour(k.dropHour)} · ${esc(CAT[c])}</div>
    <div class="cust t">${esc(k.customer)} · ${esc(k.vehicle)}</div>
    ${status}
  </div>`;
}

function advisorBoard(b) {
  const cols = b.advisorView.columns;
  const tops = cols.flatMap((c) => c.cards.map((k) => [k.top, k.top + k.span]));
  const start = Math.min(b.hours.open, ...tops.map(([t]) => Math.floor(t)));
  const end = Math.max(b.hours.close, ...tops.map(([, e]) => Math.ceil(e)));
  const height = (end - start) * HOUR;
  const template = `64px ${cols.map((c) => `minmax(${c.lanes > 1 ? 200 + (Math.min(c.lanes, 3) - 1) * 110 : 220}px, ${Math.min(c.lanes, 3)}fr)`).join(' ')}`;
  const nowLine = b.nowHour != null && b.nowHour >= start && b.nowHour <= end ? `<div class="now" style="top:${(b.nowHour - start) * HOUR}px" aria-hidden="true"></div>` : '';
  const band = (end > b.hours.close ? `<div class="closed-band" style="top:${(b.hours.close - start) * HOUR}px;height:${(end - b.hours.close) * HOUR}px" aria-hidden="true"></div>` : '')
    + (start < b.hours.open ? `<div class="closed-band" style="top:0;height:${(b.hours.open - start) * HOUR}px" aria-hidden="true"></div>` : '');
  let times = ''; for (let h = start; h < end; h++) times += `<span style="top:${(h - start) * HOUR}px">${fmtHour(h)}</span>`;
  const head = (c) => c.type === 'other'
    ? `<div class="colhead"><span class="nm" style="font-weight:600">Other writers</span><span class="sub">${c.appts} customer${c.appts === 1 ? '' : 's'}${c.waiting.length ? ` · ${c.waiting.length} waiting` : ''}</span><span class="sub">ROs written by people not on the advisor list. Change the list in Manage advisors.</span></div>`
    : c.type === 'unassigned'
    ? `<div class="colhead un ${'pin1'}"><span class="nm" style="font-weight:600">No advisor yet</span><span class="sub">${c.appts} customer${c.appts === 1 ? '' : 's'}</span><span class="sub">Click a card or drag it onto an advisor. It's written to the RO's service writer when the RO opens.</span></div>`
    : `<div class="colhead"><div class="who"><div class="avatar">${esc(c.initials)}</div><div style="min-width:0"><span class="nm t" style="display:block">${esc(c.name)}</span><small>${c.appts} customer${c.appts === 1 ? '' : 's'} · ${c.waiters} waiter${c.waiters === 1 ? '' : 's'}</small></div>${c.waiting.length ? `<span class="pill over">${c.waiting.length} to call</span>` : ''}</div>
      <span class="sub">${c.notArrived ? `${c.notArrived} not arrived yet` : 'Everyone has arrived'}</span></div>`;
  const waiting = (c) => c.waiting.length
    ? c.waiting.map((w) => `<div class="item wait" title="${esc(`${w.customer} · ${w.vehicle} — ${w.label}`)}"><i></i><span class="t"><b>RO ${esc(w.roNumber)}</b> · ${esc(w.customer)} · ${esc(w.vehicle)}</span><span class="since">${sinceText(w.since)}</span></div>`).join('')
    : '<span class="muted">Nothing waiting</span>';
  return `<section class="board" aria-label="Service advisor board">
    <div class="grid" style="grid-template-columns:${template}">
      <div class="pin0 corner"></div>
      ${cols.map(head).join('')}
      <div class="times pin0" style="height:${height}px">${times}</div>
      ${cols.map((c) => `<div class="lane ${c.type === 'unassigned' ? 'un pin1' : ''}" data-sadrop="${c.id}" style="height:${height}px">${band}${nowLine}${c.cards.map((k) => saCard(k, c, start)).join('')}</div>`).join('')}
      <div class="parked-label pin0">Waiting on<br>authorization</div>
      ${cols.map((c) => `<div class="parked ${c.type === 'unassigned' ? 'un pin1' : ''}">${waiting(c)}</div>`).join('')}
    </div>
  </section>`;
}

async function setAdvisor(k, advisorId) {
  const body = k.kind === 'appt' ? { shopId: state.shopId, appointmentId: k.appointmentId, advisorId } : { shopId: state.shopId, roId: k.roId, advisorId };
  try {
    await api('/api/advisor', json('POST', body));
    const name = advisorList().find((a) => a.id === advisorId)?.name;
    state.flash = k.key;
    toast(!advisorId ? `${k.customer}: no advisor` : k.kind === 'ro' ? `RO ${k.roNumber}: service writer set to ${name} in Tekmetric` : `${k.customer} → ${name} · RO advisor is set when it opens`);
    await load(true);
  } catch (e) { if (e.message !== 'signed out') toast(e.message, true); }
}

function openAdvisorPick(k) {
  const dlg = document.createElement('dialog');
  dlg.className = 'assign';
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(k.customer)} · ${esc(k.vehicle)}</h2>
    <p class="muted" style="margin:0">${esc(k.work)}${k.techs.length ? ` · Tech: ${esc(k.techs.join(', '))}` : ''}</p>
    <fieldset><legend>Service advisor</legend>
      ${advisorList().map((a) => `<label class="opt"><input type="radio" name="adv" value="${a.id}" ${a.id === k.advisorId ? 'checked' : ''} required><span class="t" style="flex:1">${esc(a.name)}</span><span class="muted" style="font-size:12px">${a.appts} today</span></label>`).join('')}
    </fieldset>
    <p class="note">${k.kind === 'appt' ? 'Written to the RO\'s service writer in Tekmetric when the RO opens (only if it has none).' : `Sets the service writer on RO ${esc(k.roNumber)} in Tekmetric now.`}</p>
    <div class="actions">
      ${k.kind === 'appt' ? '<button type="button" class="btn" data-openappt>Tech, time & no-show…</button>' : ''}
      ${k.kind === 'appt' && k.advisorId ? '<button type="button" class="btn" data-clear>No advisor</button>' : ''}
      <span style="flex:1"></span>
      <button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">Save</button>
    </div>
  </form>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.addEventListener('cancel', () => dlg.remove());
  dlg.querySelector('[data-clear]')?.addEventListener('click', () => { close(); setAdvisor(k, null); });
  dlg.querySelector('[data-openappt]')?.addEventListener('click', () => { close(); const card = findCard(k.key.replace(/^sa-/, '')); if (card) openAssign(card); });
  dlg.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); const id = Number(new FormData(e.target).get('adv')); close(); if (id !== k.advisorId) setAdvisor(k, id); });
  dlg.showModal();
}

// ---------- Week ----------
function loadBar(d) {
  const pct = d.capacity ? Math.min(100, Math.round((d.hours / d.capacity) * 100)) : 0;
  return `<div class="bar" role="img" aria-label="${pct}% of capacity booked"><div class="${d.status === 'over' ? 'over' : ''}" style="width:${pct}%"></div></div>`;
}
function weekView(w) {
  const t = w.totals;
  const pct = t.capacity ? Math.round((t.hours / t.capacity) * 100) : 0;
  return `<section class="summary" aria-label="Week summary">
      <div class="stat"><span class="k">Appointments</span><span class="v">${t.appointments}</span><span class="x">${t.waiters} waiters</span></div>
      <div class="stat"><span class="k">Booked hours</span><span class="v">${t.hours.toFixed(1)} <small>/ ${t.capacity.toFixed(1)} h</small></span><span class="x">${pct}% of tech capacity</span></div>
      <div class="legend">${['red', 'yellow', 'blue', 'green', 'purple'].map((c) => `<span class="chip" style="background:var(--c-${c}-bg);color:var(--c-${c}-tx)"><i style="background:var(--c-${c}-dot)"></i>${CAT[c]}</span>`).join('')}</div>
    </section>
    <section class="weekview" aria-label="Week planner">${w.days.map((d) => d.closed && !d.count ? `<div class="wday closed"><div class="whead"><span class="d">${esc(dayName(d.date))}</span><span class="muted">Closed</span></div></div>` : `
      <div class="wday ${d.date === w.today ? 'today' : ''}" data-wdrop="${d.date}">
        <div class="whead">
          <button type="button" class="dlink" data-openday="${d.date}">${esc(longDate(d.date))}</button>
          <div class="wnums"><span class="n">${d.count} <small>appts</small></span><span class="pill ${d.status}">${d.hours.toFixed(1)} / ${d.capacity.toFixed(1)} h</span></div>
          ${loadBar(d)}
          <span class="sub">${d.waiters} waiter${d.waiters === 1 ? '' : 's'}${d.status === 'over' ? ' · <b class="heavy">Over capacity</b>' : d.status === 'near' ? ' · <b class="heavy">Near full</b>' : ''}${d.out.length ? ` · Out: ${esc(d.out.join(', '))}` : ''}</span>
          <button type="button" class="btn small" data-bookday="${d.date}">+ Book</button>
        </div>
        <div class="wlist">${d.appts.length ? d.appts.map((a) => `
          <div class="qcard ${a.arrived ? 'arrived' : ''}" role="button" tabindex="0" draggable="${!a.arrived}" data-wcard="${esc(a.key)}" data-date="${d.date}" style="background:var(--c-${a.category}-bg);border-color:var(--c-${a.category}-bd)" title="${esc(`${a.customer} · ${a.vehicle}\n${a.work}`)}">
            <div class="top t" style="color:var(--c-${a.category}-tx)"><i style="background:var(--c-${a.category}-dot)"></i>${a.waiter ? 'Waiting' : 'Drop-off'} ${fmtHour(a.dropHour)}${a.dropHour !== a.startHour ? ` · appt ${fmtHour(a.startHour)}` : ''}</div>
            <div class="cust t">${esc(a.customer)} · ${esc(a.vehicle)}</div>
            <div class="work t">${a.tech ? esc(a.tech) : '<span style="color:var(--red)">No tech</span>'} · ${a.hours.toFixed(1)} h${a.hoursEstimated ? ' est.' : ''}${a.roNumber ? ` · RO ${esc(a.roNumber)}` : ''}</div>
          </div>`).join('') : '<span class="muted" style="font-size:12px;padding:4px">No appointments</span>'}</div>
      </div>`).join('')}</section>
    <p class="foot">Booked hours = sold hours on the RO once it's open, otherwise the hours set when booking or assigning (1.0 h if none). Capacity = each tech's daily hours, minus Out / Leaves early / Limit work for that day. Drag a not-arrived appointment to another day to move it in Tekmetric (same time). Click a day to open it.</p>`;
}

// ---------- Month ----------
function monthView(m) {
  const t = m.totals;
  const pct = t.capacity ? Math.round((t.hours / t.capacity) * 100) : 0;
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return `<section class="summary" aria-label="Month summary">
      <div class="stat"><span class="k">Appointments</span><span class="v">${t.appointments}</span><span class="x">${t.waiters} waiters</span></div>
      <div class="stat"><span class="k">Booked hours</span><span class="v">${t.hours.toFixed(1)} <small>/ ${t.capacity.toFixed(1)} h</small></span><span class="x">${pct}% of tech capacity</span></div>
    </section>
    <section class="month" aria-label="Month calendar">
      ${names.map((n) => `<div class="mname">${n}</div>`).join('')}
      ${m.days.map((d) => `<button type="button" class="mday ${d.inMonth ? '' : 'out'} ${d.closed ? 'closed' : ''} ${d.date === m.today ? 'today' : ''} ${d.status}" data-openday="${d.date}" aria-label="${esc(`${longDate(d.date)}: ${d.closed ? 'closed' : `${d.count} appointments, ${d.hours} of ${d.capacity} hours booked`}`)}">
        <span class="dn">${Number(d.date.slice(8))}</span>
        ${d.closed && !d.count ? '' : `<span class="n">${d.count} <small>appts</small></span>${loadBar(d)}<span class="s">${d.hours.toFixed(0)} / ${d.capacity.toFixed(0)} h${d.status === 'over' ? ' · <b class="heavy">Over</b>' : d.status === 'near' ? ' · <b class="heavy">Near full</b>' : ''}</span>`}
      </button>`).join('')}
    </section>
    <p class="foot">Each day: appointments booked, and booked hours vs. tech capacity (bar turns red when over). Click a day to open it.</p>`;
}

function bindViews() {
  app.querySelector('[data-manage-adv]')?.addEventListener('click', openManageAdvisors);
  // advisor view: click or drag a card onto an advisor
  app.querySelectorAll('[data-sa]').forEach((el) => {
    const k = () => state.board.advisorView.columns.flatMap((c) => c.cards).find((x) => x.key === el.dataset.sa);
    el.addEventListener('click', () => { const x = k(); if (x) openAdvisorPick(x); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const x = k(); if (x) openAdvisorPick(x); } });
    el.addEventListener('dragstart', (e) => { state.drag = { sa: el.dataset.sa }; e.dataTransfer.setData('text/plain', el.dataset.sa); e.dataTransfer.effectAllowed = 'move'; });
  });
  app.querySelectorAll('[data-sadrop]').forEach((lane) => {
    lane.addEventListener('dragover', (e) => { if (!state.drag?.sa) return; e.preventDefault(); lane.classList.add('drop'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('drop'));
    lane.addEventListener('drop', (e) => {
      lane.classList.remove('drop'); if (!state.drag?.sa) return; e.preventDefault();
      const k = state.board.advisorView.columns.flatMap((c) => c.cards).find((x) => x.key === state.drag.sa); state.drag = null;
      if (!k) return;
      if (lane.dataset.sadrop === 'other') return toast('Drop it on an advisor instead.', true);
      const id = lane.dataset.sadrop === 'unassigned' ? null : Number(lane.dataset.sadrop);
      if (id === (k.advisorId ?? null)) return;
      if (id == null && k.kind === 'ro') return toast('An open RO keeps its service writer in Tekmetric. Change it there.', true);
      setAdvisor(k, id);
    });
  });
  // week and month: open a day, book on a day, drag to another day
  app.querySelectorAll('[data-openday]').forEach((el) => el.addEventListener('click', () => { state.date = el.dataset.openday; setView('tech'); }));
  app.querySelectorAll('[data-bookday]').forEach((el) => el.addEventListener('click', () => { const d = el.dataset.bookday; const keep = state.date; state.date = d; bookFrom({ date: d }).finally(() => { state.date = keep; }); }));
  const wcard = (el) => state.week?.days.flatMap((d) => d.appts.map((a) => ({ ...a, date: d.date, kind: 'appt' }))).find((a) => a.key === el.dataset.wcard);
  app.querySelectorAll('[data-wcard]').forEach((el) => {
    const open = () => { state.date = el.dataset.date; state.flash = el.dataset.wcard; setView('tech'); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    el.addEventListener('dragstart', (e) => { state.drag = { week: el.dataset.wcard }; e.dataTransfer.setData('text/plain', el.dataset.wcard); e.dataTransfer.effectAllowed = 'move'; });
  });
  app.querySelectorAll('[data-wdrop]').forEach((col) => {
    col.addEventListener('dragover', (e) => { if (!state.drag?.week) return; e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
    col.addEventListener('drop', (e) => {
      col.classList.remove('drop'); if (!state.drag?.week) return; e.preventDefault();
      const el = app.querySelector(`[data-wcard="${state.drag.week}"]`); state.drag = null;
      const a = el && wcard(el); const date = col.dataset.wdrop;
      if (!a || a.date === date) return;
      changeAppt(a, { date }, `${a.customer} moved to ${longDate(date)} at ${fmtHour(a.startHour)} in Tekmetric`, wasAt(a));
    });
  });
}

function toast(msg, isError, action) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast ${isError ? 'err' : ''}`;
  t.setAttribute('role', 'status');
  const text = document.createElement('span'); text.textContent = msg; t.appendChild(text);
  if (action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label;
    b.addEventListener('click', () => { t.remove(); action.fn(); });
    t.appendChild(b);
  }
  (document.querySelector('dialog[open]') ?? document.body).appendChild(t); // above an open window, not hidden behind it
  setTimeout(() => t.remove(), action ? 9000 : 5000);
}

// briefly highlight the card that was just moved, and bring it into view if it's off to the side
function flashCard() {
  if (!state.flash) return;
  const el = [...document.querySelectorAll('[data-key]')].find((x) => x.dataset.key === state.flash);
  state.flash = null;
  if (!el) return;
  const board = document.querySelector('.board');
  const r = el.getBoundingClientRect(); const br = board.getBoundingClientRect();
  if (r.left < br.left + 314 || r.right > br.right) board.scrollLeft += r.left - br.left - 340; // keep clear of the pinned columns
  const headH = board.querySelector('.colhead')?.offsetHeight ?? 0;
  if (r.top < br.top + headH || r.bottom > br.bottom) board.scrollTop += r.top - br.top - headH - 40; // and of the header row
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2200);
}

function bind() {
  app.querySelectorAll('[data-avail]').forEach((el) => el.addEventListener('click', () => { const c = state.board.columns.find((x) => String(x.id) === el.dataset.avail); if (c) openAvailability(c); }));
  app.querySelectorAll('[data-techs]').forEach((el) => el.addEventListener('click', () => { state.allTechs = el.dataset.techs === 'all'; remember('td-alltechs', state.allTechs ? '1' : ''); render(); }));
  app.querySelector('[data-manage]')?.addEventListener('click', openManageTechs);
  app.querySelectorAll('[data-assign]').forEach((el) => {
    const open = () => { const card = findCard(el.dataset.assign); if (card) openAssign(card); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  app.querySelectorAll('[data-key]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      state.drag = { key: el.dataset.key, grab: el.closest('.lane.queue') ? 0 : e.clientY - el.getBoundingClientRect().top };
      e.dataTransfer.setData('text/plain', el.dataset.key);
      e.dataTransfer.effectAllowed = 'move';
    });
  });
  app.querySelectorAll('[data-drop]').forEach((lane) => {
    lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('drop'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('drop'));
    lane.addEventListener('drop', async (e) => {
      e.preventDefault(); lane.classList.remove('drop');
      const key = e.dataTransfer.getData('text/plain') || state.drag?.key;
      const card = findCard(key);
      if (!card) return;
      const from = colOf(key);
      const target = lane.dataset.drop === 'unassigned' ? null : Number(lane.dataset.drop);
      // the time where the top of the card was dropped, to the nearest 15 minutes
      const y = e.clientY - lane.getBoundingClientRect().top - (state.drag?.grab ?? 0);
      const { start, end } = state.board.hours;
      const hour = Math.min(Math.max(Math.round((start + y / HOUR) * 4) / 4, start), end - 0.25);
      state.drag = null;
      if (target == null) {
        if (card.kind === 'ro') return toast('An open RO needs a tech in Tekmetric. Drop it on another tech instead.', true);
        if (from?.type === 'unassigned') return;
        return assign(card, null);
      }
      if (from?.id === target) {
        try { await plan(card.key, hour); state.flash = card.key; toast(`${card.customer} planned for ${fmtHour(hour)}`); await load(true); }
        catch (err) { if (err.message !== 'signed out') toast(err.message, true); }
        return;
      }
      if (!canAssign(card)) return toast('This RO is complete, so its tech stays as it is.', true);
      assign(card, target, card.hours, hour);
    });
  });
  app.querySelectorAll('[data-shop]').forEach((el) => el.addEventListener('click', () => setShop(Number(el.dataset.shop))));
  app.querySelectorAll('[data-date]').forEach((el) => el.addEventListener('click', () => go(el.dataset.date)));
  app.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => step(Number(el.dataset.go))));
  app.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => setView(el.dataset.view)));
  app.querySelector('[data-today]')?.addEventListener('click', () => go(state.today));
  app.querySelector('[data-refresh]')?.addEventListener('click', () => load(true));
  app.querySelector('[data-signout]')?.addEventListener('click', signOut);
  bindBooking();
  bindViews();
}

// booking, no-show buttons, and moving appointments to another day
function bindBooking() {
  app.querySelector('[data-book]')?.addEventListener('click', () => bookFrom({}));
  app.querySelectorAll('[data-ns]').forEach((el) => el.addEventListener('click', () => {
    const card = findCard(`appt-${el.dataset.id}`);
    if (!card) return toast('That appointment is no longer on the board. Refresh and try again.', true);
    ({ noshow: markNoShow, keep: keepComing, resched: openAssign })[el.dataset.ns](card);
  }));

  // click an open time in a tech's column to book there; a hint follows the pointer
  const hourAt = (lane, y) => { const { start, end } = state.board.hours; return Math.min(Math.max(Math.floor((start + y / HOUR) * 4) / 4, start), end - 0.25); };
  const open = (e) => e.target.classList.contains('lane') || e.target.classList.contains('closed-band');
  app.querySelectorAll('[data-bookat]').forEach((lane) => {
    let ghost = null;
    lane.addEventListener('mousemove', (e) => {
      if (!open(e) || state.drag) { ghost?.remove(); ghost = null; return; }
      const y = e.clientY - lane.getBoundingClientRect().top;
      const h = hourAt(lane, y);
      if (!ghost) { ghost = document.createElement('div'); ghost.className = 'ghost'; ghost.setAttribute('aria-hidden', 'true'); lane.appendChild(ghost); }
      ghost.style.top = `${(h - state.board.hours.start) * HOUR}px`;
      ghost.textContent = `+ Book ${fmtHour(h)}`;
    });
    lane.addEventListener('mouseleave', () => { ghost?.remove(); ghost = null; });
    lane.addEventListener('click', (e) => {
      if (!open(e)) return;
      openBook({ techId: Number(lane.dataset.bookat), hour: hourAt(lane, e.clientY - lane.getBoundingClientRect().top) });
    });
  });

  // drag a booked appointment onto another day in the week strip to move it (same time)
  app.querySelectorAll('[data-dropday]').forEach((day) => {
    const ok = () => state.drag?.key?.startsWith('appt-') && day.dataset.date !== state.date;
    day.addEventListener('dragover', (e) => { if (!ok()) return; e.preventDefault(); day.classList.add('drop'); });
    day.addEventListener('dragleave', () => day.classList.remove('drop'));
    day.addEventListener('drop', (e) => {
      day.classList.remove('drop');
      if (!ok()) return;
      e.preventDefault();
      const card = findCard(state.drag.key); state.drag = null;
      if (!card) return;
      const date = day.dataset.date;
      changeAppt(card, { date }, `${card.customer} moved to ${longDate(date)} at ${fmtHour(card.startHour)} in Tekmetric`, wasAt(card));
    });
  });
  app.querySelectorAll('[data-key]').forEach((el) => el.addEventListener('dragend', () => { state.drag = null; app.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop')); }));
}

addEventListener('resize', () => document.documentElement.style.setProperty('--hdr', `${document.querySelector('header')?.offsetHeight ?? 70}px`));
start().catch((e) => { app.innerHTML = `<div class="loading error">${esc(e.message)}</div>`; });
