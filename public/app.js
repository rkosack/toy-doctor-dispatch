// Toy Doctor Dispatch — board UI

const app = document.getElementById('app');
const HOUR = 88; // px per hour, matches --hour
const REFRESH_MS = 60_000;
const state = { user: null, shops: [], shopId: null, date: null, today: null, demo: false, board: null, error: null, timer: null, allTechs: false };

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
    await load();
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden) load(true); }, REFRESH_MS);
  } catch (e) { if (e.message !== 'signed out') { state.error = e.message; render(); } }
}

async function load(quiet) {
  if (!quiet) { state.board = null; render(); }
  try {
    state.board = await api(`/api/board?shop=${state.shopId}&date=${state.date}`);
    state.error = null;
    clearTimeout(state.namesTimer);
    if (state.board.namesPending) state.namesTimer = setTimeout(() => load(true), 8000); // names still loading
  } catch (e) { if (e.message === 'signed out') return; state.error = e.message; }
  render();
}

function go(date) { state.date = date; load(); }
function setShop(id) { state.shopId = id; remember('td-shop', String(id)); load(); }

// ---------- rendering ----------
function render() {
  const b = state.board;
  // keep the sideways scroll on the board (and the page scroll) across redraws
  const prevLeft = document.querySelector('.board')?.scrollLeft ?? state.boardLeft ?? 0;
  const prevTop = window.scrollY;
  app.innerHTML = `${header()}
  <main>
    ${state.demo ? `<div class="banner demo"><b>Demo data</b><span class="muted">This is sample data so you can try the board. Real Tekmetric data shows once credentials are added.</span></div>` : ''}
    ${state.error ? `<div class="error" role="alert">${esc(state.error)}</div>` : ''}
    ${b ? `${weekStrip(b)}${noShowBanners(b)}${summary(b)}${techToolbar(b)}${board(b)}
      <p class="foot">Active load counts sold hours on ROs labeled All Parts Here or In Progress, or promised today. Today's not-arrived appointments always count (1.0 h unless hours were set when assigning). An assigned tech is written to the RO when it opens, only if the RO has no tech yet. Parts hold and offsite hours show separately. Pay period = sold hours on ROs marked Complete, 1st–15th and 16th–end of month. Pace = completed − days worked × daily capacity. Carry-over work starts in the afternoon (1:00) so mornings stay open for incoming cars; drag any card to the time a tech will work on it. That plan is for the board only and never moves the customer's appointment in Tekmetric. To move the appointment itself, open the card and change its time, or drag it onto a day above. Click an open time in a tech's column to book there. Updates every minute.</p>`
      : state.error ? '' : '<div class="loading">Loading the board…</div>'}
  </main>`;
  bind();
  const boardEl = document.querySelector('.board');
  if (boardEl) {
    boardEl.scrollLeft = prevLeft;
    boardEl.addEventListener('scroll', () => { state.boardLeft = boardEl.scrollLeft; }, { passive: true });
  }
  window.scrollTo(0, prevTop);
  flashCard();
  const now = document.querySelector('.now');
  if (now && !state.scrolled) { state.scrolled = true; }
}

function header() {
  return `<header>
    <div class="brand"><div class="logo">TD</div><div><b>Toy Doctor</b><span>Dispatch</span></div></div>
    ${state.shops.length > 1 ? `<div class="seg" role="group" aria-label="Location">${state.shops.map((s) => `<button type="button" data-shop="${s.id}" aria-pressed="${s.id === state.shopId}">${esc(s.name)}</button>`).join('')}</div>` : ''}
    <nav class="views" aria-label="Views">
      <button type="button" aria-current="page">Day – Technician</button>
      <button type="button" disabled title="Coming in a later step">Day – Service Advisor</button>
      <button type="button" disabled title="Coming in a later step">Week</button>
      <button type="button" disabled title="Coming in a later step">Month</button>
    </nav>
    <div class="datenav">
      <button type="button" class="icon-btn" data-go="-1" aria-label="Previous day">${icon('M10 3L5 8l5 5')}</button>
      <span class="date">${state.date ? esc(longDate(state.date)) : ''}</span>
      <button type="button" class="icon-btn" data-go="1" aria-label="Next day">${icon('M6 3l5 5-5 5')}</button>
      <button type="button" class="btn" data-today ${state.date === state.today ? 'disabled' : ''}>Today</button>
      <button type="button" class="btn" data-refresh aria-label="Refresh">Refresh</button>
      <button type="button" class="btn primary" data-book>+ Book appointment</button>
    </div>
    ${state.user && !state.authCfg?.disabled ? `<div class="user"><span>${esc(state.user.name)}</span><button type="button" data-signout>Sign out</button></div>` : ''}
  </header>`;
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
const canAssign = (card) => card.kind === 'appt' || (card.kind === 'ro' && !card.assignedTechId && card.state !== 'done');
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
      <div class="pin0" style="border-bottom:1px solid var(--line);background:var(--soft)"></div>
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
    <p class="muted" style="margin:0;font-size:13px">Choose who shows on the board and their usual daily capacity. Everyone Tekmetric lists as able to do work is here.</p>
    <div class="chips"><button type="button" class="btn" data-all="1">Show all</button><button type="button" class="btn" data-all="0">Hide all</button><input type="search" placeholder="Search names" aria-label="Search techs" style="flex:1;height:44px;border:1px solid var(--line);border-radius:8px;padding:0 10px;font:inherit"></div>
    <div class="techlist">${list.map((t) => `<div class="techrow" data-name="${esc(t.name.toLowerCase())}">
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
  dlg.querySelector('input[type=search]').addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); dlg.querySelectorAll('.techrow').forEach((r) => { r.hidden = !r.dataset.name.includes(q); }); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const changes = list.map((t) => ({ techId: t.id, show: form.querySelector(`input[name=show][value="${t.id}"]`).checked, capacity: Number(form.querySelector(`input[name="cap-${t.id}"]`).value) }))
      .filter((c, i) => c.show !== list[i].show || c.capacity !== list[i].capacity);
    try {
      if (changes.length) await api('/api/techs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shopId: state.shopId, changes }) });
      close(); toast(changes.length ? `Saved ${changes.length} change${changes.length === 1 ? '' : 's'}` : 'No changes'); await load(true);
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

async function assign(card, techId, hours, atHour) {
  const body = card.kind === 'appt'
    ? { shopId: state.shopId, appointmentId: card.appointmentId, techId, hours }
    : { shopId: state.shopId, roId: card.roId, techId };
  try {
    await api('/api/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (atHour != null && techId != null) await plan(card.kind === 'ro' ? `ro-${card.roId}-${techId}` : card.key, atHour);
    state.flash = techId == null ? card.key : card.kind === 'ro' ? `ro-${card.roId}-${techId}` : card.key;
    if (techId == null && card.kind === 'appt') await plan(card.key, null);
    const tech = techCols().find((c) => c.id === techId)?.name;
    toast(techId == null ? `${card.customer} moved back to Unassigned`
      : card.kind === 'ro' ? `RO ${card.roNumber}: technician set to ${tech} in Tekmetric`
      : `${card.customer} → ${tech} · RO tech is set when it opens`);
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
const wasAt = (card) => ({ date: state.date, startHour: card.startHour, dropHour: card.dropHour != null && card.dropHour < card.startHour ? card.dropHour : null });
const markNoShow = (card) => changeAppt(card, { status: 'NO_SHOW' }, `${card.customer} marked no-show in Tekmetric · off today's hours`, { status: 'NONE' });
const cancelAppt = (card) => changeAppt(card, { status: 'CANCELED' }, `${card.customer}'s appointment canceled in Tekmetric`, { status: 'NONE' });
async function keepComing(card) {
  try { await api('/api/noshow/keep', json('POST', { shopId: state.shopId, date: state.date, appointmentId: card.appointmentId })); toast(`OK — ${card.customer} stays on today's board`); await load(true); }
  catch (e) { if (e.message !== 'signed out') toast(e.message, true); }
}

function openAssign(card) {
  const isAppt = card.kind === 'appt';
  const current = card.assignedTechId;
  const was = isAppt ? wasAt(card) : null;
  const dlg = document.createElement('dialog');
  dlg.className = `assign ${isAppt ? 'wide' : ''}`;
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(card.customer)} · ${esc(card.vehicle)}</h2>
    <p class="muted" style="margin:0">${esc(card.work)}${card.waiter ? ' · Waiter' : ''}</p>
    ${isAppt ? `<fieldset class="when"><legend>Appointment in Tekmetric</legend>
      <div class="row3">
        <label>Date<input type="date" name="date" value="${state.date}" required></label>
        <label>Time<input type="time" name="time" step="900" value="${toHM(card.startHour)}" required></label>
        <label>Drop-off <span class="muted">(optional)</span><input type="time" name="drop" step="900" value="${was.dropHour != null ? toHM(was.dropHour) : ''}"></label>
      </div>
      <span class="note">Changing these moves the customer's appointment in Tekmetric.</span>
    </fieldset>` : ''}
    <fieldset><legend>Technician</legend>
      ${techCols().map((t) => `<label class="opt"><input type="radio" name="tech" value="${t.id}" ${t.id === current ? 'checked' : ''} ${isAppt ? '' : 'required'}>
        <span class="t" style="flex:1">${esc(t.name)}</span><span class="pill ${t.status}">${t.active.toFixed(1)} / ${t.capacity.toFixed(1)} h</span></label>`).join('')}
    </fieldset>
    ${isAppt ? `<label class="hrs-in">Estimated hours <input type="number" name="hours" min="0.1" max="24" step="0.1" value="${card.hours.toFixed(1)}"></label>` : ''}
    <p class="note">${isAppt
      ? 'When the customer arrives and the RO opens, this tech is set as the RO\'s technician in Tekmetric (only if no tech is set yet).'
      : `Sets this tech on RO ${esc(card.roNumber)} and on any of its jobs without a tech, in Tekmetric, right away.`}</p>
    ${isAppt ? `<div class="actions minor">
      <button type="button" class="btn" data-noshow>Mark no-show</button>
      <button type="button" class="btn" data-cancelappt>Cancel appointment</button>
      ${current ? '<button type="button" class="btn" data-unassign>Move to Unassigned</button>' : ''}
    </div>` : ''}
    <div class="actions">
      <span style="flex:1"></span>
      <button type="button" class="btn" data-cancel>Close</button>
      <button type="submit" class="btn primary">${isAppt || current ? 'Save' : 'Assign'}</button>
    </div>
  </form>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.querySelector('[data-unassign]')?.addEventListener('click', () => { close(); assign(card, null, card.hours); });
  dlg.querySelector('[data-noshow]')?.addEventListener('click', () => { close(); markNoShow(card); });
  dlg.querySelector('[data-cancelappt]')?.addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Click again to cancel it in Tekmetric'; b.classList.add('danger'); return; }
    close(); cancelAppt(card);
  });
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const techId = f.get('tech') ? Number(f.get('tech')) : current ?? null;
    if (!isAppt) { close(); return assign(card, techId); }
    const hours = Number(f.get('hours')) || card.hours;
    const date = f.get('date'); const startHour = fromHM(f.get('time')); const dropHour = fromHM(f.get('drop'));
    if (dropHour != null && dropHour > startHour) return toast('Drop-off should be at or before the appointment time.', true);
    const moved = date !== was.date || Math.abs(startHour - was.startHour) > 0.01 || (dropHour ?? null) !== (was.dropHour ?? null);
    const retech = techId !== current || Math.abs(hours - card.hours) > 0.01;
    close();
    if (retech) {
      try { await api('/api/assign', json('POST', { shopId: state.shopId, appointmentId: card.appointmentId, techId, hours })); }
      catch (err) { if (err.message !== 'signed out') toast(err.message, true); return; }
    }
    const who = techCols().find((c) => c.id === techId)?.name;
    if (moved) return changeAppt(card, { date, startHour, dropHour }, `${card.customer} moved to ${whenText(date, startHour)} in Tekmetric${retech && who ? ` · ${who}` : ''}`, was);
    if (retech) { state.flash = card.key; toast(techId ? `${card.customer} → ${who} · ${hours.toFixed(1)} h` : 'Saved'); await load(true); }
  });
  dlg.addEventListener('cancel', () => dlg.remove());
  dlg.showModal();
}

// ---------- booking ----------
const KIND_HOURS = { red: 3, yellow: 1, blue: 1.5, green: 1, purple: 2 };
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
      <label>Date<input type="date" name="date" value="${state.date}" required></label>
      <label>Appointment<input type="time" name="time" step="900" value="${toHM(startHour)}" required></label>
      <label>Drop-off <span class="muted">(optional)</span><input type="time" name="drop" step="900"></label>
    </div>
    <div class="row3">
      <label>Pick-up <span class="muted" data-pickreq>(optional)</span><input type="time" name="pick" step="900"></label>
    </div>
    <div class="row3">
      <label>Est. hours<input type="number" name="hours" min="0.1" max="24" step="0.1" value="1.0"></label>
      <label style="grid-column:span 2">Technician<select name="tech">${techOpts(state.date)}</select></label>
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
      hours: Number(f.get('hours')), techId: f.get('tech') || null, rideOption: f.get('ride'), pickupHour: pick,
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
        if (card.kind === 'ro') return toast('An open RO keeps its tech in Tekmetric. Change it there.', true);
        if (from?.type === 'unassigned') return;
        return assign(card, null);
      }
      if (from?.id === target) {
        try { await plan(card.key, hour); state.flash = card.key; toast(`${card.customer} planned for ${fmtHour(hour)}`); await load(true); }
        catch (err) { if (err.message !== 'signed out') toast(err.message, true); }
        return;
      }
      if (!canAssign(card) && !(card.kind === 'appt')) return toast('This RO\'s tech is set in Tekmetric. Change the tech there.', true);
      assign(card, target, card.hours, hour);
    });
  });
  app.querySelectorAll('[data-shop]').forEach((el) => el.addEventListener('click', () => setShop(Number(el.dataset.shop))));
  app.querySelectorAll('[data-date]').forEach((el) => el.addEventListener('click', () => go(el.dataset.date)));
  app.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => go(addDays(state.date, Number(el.dataset.go)))));
  app.querySelector('[data-today]')?.addEventListener('click', () => go(state.today));
  app.querySelector('[data-refresh]')?.addEventListener('click', () => load(true));
  app.querySelector('[data-signout]')?.addEventListener('click', signOut);
  bindBooking();
}

// booking, no-show buttons, and moving appointments to another day
function bindBooking() {
  app.querySelector('[data-book]')?.addEventListener('click', () => openBook());
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

start().catch((e) => { app.innerHTML = `<div class="loading error">${esc(e.message)}</div>`; });
