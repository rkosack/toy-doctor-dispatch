// Builds the Day – Technician board for one shop and one date from Tekmetric data.
// All business rules from the build spec live here.

import { settings } from './config.js';
import { addDays, localDate, localHours, payPeriod, weekday, workDaysBetween, zonedTime } from './time.js';
import { syncAssignments } from './sync.js';
import { availableHours } from './availability.js';

const TZ = settings.timeZone;
const DEFAULT_APPT_HOURS = 1; // estimate for a booked appointment until the booking panel stores one
const round1 = (n) => Math.round(n * 10) / 10;
const lc = (s) => (s ?? '').toLowerCase();
const matches = (text, list) => list.some((w) => lc(text).includes(w));

// ---- colors: Tekmetric appointment hex → our five categories ----
export function colorCategory(hex) {
  if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return 'other';
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d < 0.08) return 'other'; // gray
  const s = d / (1 - Math.abs(2 * l - 1));
  if (l < 0.3 && s < 0.9) return 'other'; // navy = Tekmetric's default, i.e. not categorized
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 330) return 'red';
  if (h < 70) return 'yellow';
  if (h < 170) return 'green';
  if (h < 228) return 'blue';
  return 'purple';
}

// ---- RO state from its labels ----
function roLabel(ro) {
  return ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || ro.repairOrderStatus?.name || '';
}
const norm = (s) => lc(s).replace(/[^a-z0-9]/g, '');
const RULES = Object.fromEntries(Object.entries(settings.labelRules).map(([k, list]) => [k, new Set(list.map(norm))]));
function roState(ro) {
  const statusId = ro.repairOrderStatus?.id;
  if ([3, 5, 6].includes(statusId) || ro.completedDate) return 'done';
  for (const text of [ro.repairOrderCustomLabel?.name, ro.repairOrderLabel?.name]) {
    const n = norm(text);
    if (!n) continue;
    if (RULES.active.has(n)) return 'active';
    if (RULES.partsHold.has(n)) return 'parts';
    if (RULES.offsite.has(n)) return 'offsite';
    if (RULES.done.has(n)) return 'done';
  }
  return 'pending';
}

// When the car is due in: Tekmetric's drop-off time if set (and on that day), else the appointment time.
export function dropHour(appt, date) {
  const t = appt.dropoffTime && localDate(new Date(appt.dropoffTime), TZ) === date ? appt.dropoffTime : appt.startTime;
  return localHours(new Date(t), TZ);
}

// A waiter: Tekmetric's "Stay with vehicle", or green (Toy Doctor's waiter color; the API can't set "Stay").
// Tech columns in the order set in "Manage techs"; anyone not placed yet goes after, in Tekmetric's order.
export const sortTechs = (list, techSettings) => list
  .map((t, i) => ({ t, i, o: techSettings.get(t.id)?.order }))
  .sort((a, b) => (a.o ?? 1e6 + a.i) - (b.o ?? 1e6 + b.i))
  .map((x) => x.t);
export const isWaiter = (a) => a?.appointmentOption?.code === 'STAY' || colorCategory(a?.color) === 'green';
const str = (x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : x?.name ?? '');
export const vehicleText = (v) => [str(v?.year), str(v?.model) || str(v?.make)].filter(Boolean).join(' ');

// Customer and vehicle names for a card. Never blocks: shows "Loading name…" until the background load
// finishes, and nothing (rather than a placeholder forever) if Tekmetric refused the lookup.
export function nameOf(client, x) {
  const c = x.customerId ? client.peekCustomer(x.customerId) : null;
  const v = x.vehicleId ? client.peekVehicle(x.vehicleId) : null;
  return {
    customer: c ? (c.lastName || c.firstName || c.companyName || 'Customer')
      : !x.customerId || client.nameFailed('customers', x.customerId) ? 'Customer' : 'Loading name…',
    vehicle: v ? vehicleText(v) : !x.vehicleId || client.nameFailed('vehicles', x.vehicleId) ? '' : 'vehicle…',
  };
}
const slim = (key, d) => (key.startsWith('customers/')
  ? { id: d.id, firstName: d.firstName ?? '', lastName: d.lastName ?? '', companyName: d.companyName ?? '' }
  : { id: d.id, year: str(d.year), make: str(d.make), model: str(d.model), subModel: str(d.subModel) });
// Fills in names from what's been saved before, and starts loading the rest. Returns how many are still loading.
export async function loadNames(client, store, pairs) {
  const want = [];
  for (const [c, v] of pairs) { if (c && !client.peekCustomer(c)) want.push(`customers/${c}`); if (v && !client.peekVehicle(v)) want.push(`vehicles/${v}`); }
  if (want.length && store?.getNames) client.primeNames(await store.getNames([...new Set(want)]).catch(() => []));
  const missing = pairs.filter(([c, v]) => (c && !client.peekCustomer(c) && !client.nameFailed('customers', c)) || (v && !client.peekVehicle(v) && !client.nameFailed('vehicles', v)));
  if (missing.length) client.warmNames(missing, (key, data) => { store?.setName?.(key, slim(key, data)).catch(() => {}); });
  return missing.length;
}
export const personName = (e) => (e ? `${e.firstName ?? ''} ${(e.lastName ?? '').slice(0, 1)}.`.trim() : '');
const initials = (e) => `${(e.firstName ?? ' ')[0]}${(e.lastName ?? ' ')[0]}`.toUpperCase();

// The shop's service advisors: the names in settings.advisors for this location, matched to Tekmetric
// employees by first name (exact, else the first 3 letters, e.g. Nick = Nicholas). Without a list for the
// location, everyone who isn't set up to do work.
async function pickAdvisors(client, shopId, employees) {
  const active = employees.filter((e) => !e.disabled);
  const shop = (await client.getShops()).find((x) => x.id === Number(shopId));
  const label = lc([settings.shopNames[shopId], shop?.nickname, shop?.name].filter(Boolean).join(' '));
  const names = Object.entries(settings.advisors ?? {}).find(([loc]) => label.includes(lc(loc)))?.[1];
  if (!names) return { list: active.filter((e) => !e.canPerformWork), missing: [] };
  const first = (e) => lc(e.firstName).trim();
  const list = []; const missing = [];
  for (const n of names) {
    const want = lc(n);
    const pool = [active.filter((e) => !e.canPerformWork), active];
    const hit = pool.map((p) => p.find((e) => first(e) === want)).find(Boolean)
      ?? pool.map((p) => p.find((e) => first(e).slice(0, 3) === want.slice(0, 3))).find(Boolean);
    if (hit && !list.includes(hit)) list.push(hit); else if (!hit) missing.push(n);
  }
  return { list, missing };
}

export async function buildBoard(client, { shopId, date, now = new Date(), store = null, capacityOverrides = {} }) {
  const today = localDate(now, TZ);
  const dayStart = zonedTime(date, 0, 0, TZ).toISOString();
  const dayEnd = new Date(zonedTime(addDays(date, 1), 0, 0, TZ).getTime() - 1000).toISOString();
  const mon = addDays(date, -((weekday(date) + 6) % 7));
  const weekStart = zonedTime(mon, 0, 0, TZ).toISOString();
  const weekEnd = new Date(zonedTime(addDays(mon, 7), 0, 0, TZ).getTime() - 1000).toISOString();
  const period = payPeriod(date);
  const periodStart = zonedTime(period.start, 0, 0, TZ).toISOString();

  const [employees, weekAppts, wip, touched, closedInPeriod] = await Promise.all([
    client.getEmployees(shopId),
    client.getAppointments(shopId, weekStart, weekEnd),
    // open ROs: estimates (1) and work in progress (2), incl. ones written up the night before
    Promise.all([1, 2].map((st) => client.getRepairOrders(shopId, { repairOrderStatusId: String(st) }))).then((a) => a.flat()),
    client.getRepairOrders(shopId, { updatedDateStart: dayStart }),
    Promise.all([3, 5, 6].map((s) => client.getRepairOrders(shopId, { repairOrderStatusId: String(s), updatedDateStart: periodStart }))).then((a) => a.flat()),
  ]);

  const empById = new Map(employees.map((e) => [e.id, e]));
  const allTechs = employees.filter((e) => e.canPerformWork && !e.disabled);
  const [techSettings, availability] = store
    ? await Promise.all([store.getTechSettings(shopId), store.getAvailability(shopId, date)])
    : [new Map(), new Map()];
  // "Manage techs" can hide people and set the column order
  const techs = sortTechs(allTechs.filter((t) => techSettings.get(t.id)?.show !== false), techSettings);
  const live = (a) => !a.deletedDate && !['CANCELED', 'CANCELLED', 'NO_SHOW'].includes(a.appointmentStatus);
  const dayAppts = weekAppts.filter((a) => live(a) && localDate(new Date(a.startTime), TZ) === date);
  const apptById = new Map(weekAppts.map((a) => [a.id, a]));

  // ---- ROs that belong on this day ----
  const roById = new Map();
  for (const ro of [...wip, ...touched]) if (!ro.deletedDate) roById.set(ro.id, ro);
  const dayApptIds = new Set(dayAppts.map((a) => a.id));
  const isToday = date === today;
  const dayROs = [...roById.values()].filter((ro) =>
    dayApptIds.has(ro.appointmentId) ||
    (ro.completedDate && localDate(new Date(ro.completedDate), TZ) === date) ||
    (isToday && ro.repairOrderStatus?.id === 2 && !(apptById.get(ro.appointmentId) && localDate(new Date(apptById.get(ro.appointmentId).startTime), TZ) > date)) ||
    (date < today && ro.repairOrderStatus?.id === 2 && localDate(new Date(ro.createdDate), TZ) <= date)
  );
  const linked = new Set(dayROs.map((ro) => ro.appointmentId).filter(Boolean));

  // ---- booked tech → RO, once the RO is open (fills blanks only) ----
  const synced = store ? await syncAssignments({ client, store, shopId, ros: dayROs }) : [];
  const assignments = store ? await store.getAssignments(shopId, dayAppts.filter((a) => !linked.has(a.id)).map((a) => a.id)) : new Map();

  // ---- ROs waiting on the customer's OK (Day – Service Advisor view) ----
  const authROs = wip.filter((ro) => {
    if (ro.deletedDate || !RULES.authorization.has(norm(roLabel(ro)))) return false;
    const appt = ro.appointmentId ? apptById.get(ro.appointmentId) : null;
    const notArrivedToday = appt && localDate(new Date(appt.startTime), TZ) === date && appt.arrived !== true && appt.appointmentStatus !== 'ARRIVED';
    return !notArrivedToday && localDate(new Date(ro.createdDate ?? now), TZ) <= date;
  });

  // ---- names (customers, vehicles): from memory or saved; anything missing loads in the background ----
  const namesPending = await loadNames(client, store, [...dayROs, ...dayAppts, ...authROs].map((x) => [x.customerId, x.vehicleId]));
  const who = (x) => nameOf(client, x);

  // ---- columns ----
  const columns = new Map();
  columns.set('unassigned', { id: 'unassigned', type: 'unassigned', name: 'Unassigned', cards: [], parked: [] });
  for (const t of techs) columns.set(t.id, { id: t.id, type: 'tech', name: personName(t), initials: initials(t), cards: [], parked: [] });
  const col = (techId) => {
    if (columns.has(techId)) return columns.get(techId);
    const e = allTechs.find((t) => t.id === techId); // hidden from the board but has work today: show them anyway
    if (e) { columns.set(e.id, { id: e.id, type: 'tech', name: personName(e), initials: initials(e), cards: [], parked: [], hiddenTech: true }); return columns.get(e.id); }
    return columns.get('unassigned');
  };

  // ---- RO cards: one per tech with sold jobs on the RO ----
  for (const ro of dayROs) {
    const appt = ro.appointmentId ? apptById.get(ro.appointmentId) : null;
    const apptToday = appt && localDate(new Date(appt.startTime), TZ) === date;
    const state = roState(ro);
    const label = roLabel(ro);
    const promisedToday = ro.customerTimeOut && localDate(new Date(ro.customerTimeOut), TZ) === date;
    const live = (ro.jobs ?? []).filter((j) => !j.archived);
    const sold = live.filter((j) => j.authorized !== false);
    // Written up ahead of time but not sold yet: plan with the estimated job hours.
    const estimated = sold.length === 0 && live.length > 0;
    const planned = estimated ? live : sold;
    const notArrived = apptToday && appt.arrived !== true && appt.appointmentStatus !== 'ARRIVED' && state !== 'done';
    const byTech = new Map();
    for (const j of planned) {
      const t = j.technicianId ?? ro.technicianId ?? 'unassigned';
      const g = byTech.get(t) ?? { hours: 0, jobs: [] };
      g.hours += Number(j.laborHours) || 0; g.jobs.push(j.name);
      byTech.set(t, g);
    }
    if (byTech.size === 0) byTech.set(ro.technicianId ?? 'unassigned', { hours: 0, jobs: ['Estimate – not yet sold'] });
    const techIds = [...byTech.keys()];
    for (const [techId, g] of byTech) {
      // Counts: active work, work promised today, or a booked customer who hasn't arrived yet
      // (assumed promised today, same as a booked appointment with no RO).
      const counts = state === 'active' || (promisedToday && state === 'pending') || (notArrived && state === 'pending');
      const card = {
        key: `ro-${ro.id}-${techId}`, kind: 'ro', roId: ro.id, roNumber: ro.repairOrderNumber,
        category: colorCategory(appt?.color), waiter: isWaiter(appt),
        ...who(ro), work: g.jobs.join(', '), hours: round1(g.hours), hoursEstimated: estimated,
        label: notArrived ? `${label} · not arrived` : label, state, counts: Boolean(counts), promisedToday: Boolean(promisedToday),
        startHour: apptToday ? localHours(new Date(appt.startTime), TZ) : null,
        dropHour: apptToday ? dropHour(appt, date) : null,
        alsoOn: techIds.filter((t) => t !== techId).map((t) => personName(empById.get(t)) || 'Unassigned'),
        advisor: personName(empById.get(ro.serviceWriterId)),
        assignedTechId: techId === 'unassigned' ? null : techId,
      };
      if (state === 'parts' || state === 'offsite') col(techId).parked.push(card);
      else col(techId).cards.push(card);
    }
  }

  // ---- booked appointments with no RO yet ----
  const nowMs = now.getTime();
  const events = [];
  const noShows = [];
  const kept = (store?.getMeta ? await store.getMeta(`noshow-keep-${shopId}_${date}`) : null) ?? {}; // "Still coming"
  for (const a of dayAppts) {
    if (linked.has(a.id)) continue;
    if (!a.customerId) { events.push({ id: a.id, title: a.title, startHour: localHours(new Date(a.startTime), TZ), endHour: localHours(new Date(a.endTime), TZ) }); continue; }
    const start = new Date(a.startTime).getTime();
    const arrived = a.arrived === true || a.appointmentStatus === 'ARRIVED';
    const noShow = isToday && !arrived && !kept[a.id] && nowMs > start + settings.noShowGraceMinutes * 60_000;
    const assigned = assignments.get(a.id);
    const techCol = assigned && columns.get(assigned.techId);
    const card = {
      key: `appt-${a.id}`, kind: 'appt', appointmentId: a.id, category: colorCategory(a.color), waiter: isWaiter(a),
      ...who(a), work: a.description || a.title || '', hours: assigned?.hours ?? DEFAULT_APPT_HOURS, hoursEstimated: true,
      label: arrived ? 'Arrived' : 'Not arrived', state: arrived ? 'arrived' : 'notArrived', counts: true, noShow,
      startHour: localHours(new Date(a.startTime), TZ), dropHour: dropHour(a, date), alsoOn: [],
      assignedTechId: techCol ? assigned.techId : null,
      advisorId: assigned?.advisorId ?? null,
      customerId: a.customerId, vehicleId: a.vehicleId ?? null, description: a.description ?? '',
      pickupHour: a.pickupTime && localDate(new Date(a.pickupTime), TZ) === date ? localHours(new Date(a.pickupTime), TZ) : null,
      startTime: a.startTime, rideOption: typeof a.rideOption === 'string' ? a.rideOption : a.rideOption?.code ?? null,
    };
    (techCol ?? columns.get('unassigned')).cards.push(card);
    if (noShow) noShows.push({ appointmentId: a.id, customer: card.customer, vehicle: card.vehicle, startHour: card.startHour, hours: card.hours });
  }

  // ---- lay cards out down the day; overlaps sit side by side ----
  // Order of preference: a time planned on the board (drag) → the booked time → carry-over
  // queued from the afternoon, so mornings stay open for incoming cars.
  const plans = store ? await store.getPlans(shopId, date) : new Map();
  columns.get('unassigned').cards.sort((x, y) => (x.dropHour ?? 99) - (y.dropHour ?? 99));
  for (const c of columns.values()) {
    if (c.type === 'unassigned') continue;
    let cursor = settings.carryOverStartHour;
    for (const card of c.cards) {
      card.span = Math.max(card.hours || 0, 1);
      card.carryOver = card.startHour == null;
      const plan = plans.get(card.key);
      if (plan != null) { card.top = Number(plan); card.planned = true; }
      else if (card.startHour != null) card.top = card.startHour;
    }
    for (const card of c.cards.filter((k) => k.top == null)) { card.top = cursor; cursor += card.span; }
    c.cards.sort((x, y) => x.top - y.top);
    const laneEnds = [];
    for (const card of c.cards) {
      let lane = laneEnds.findIndex((end) => end <= card.top + 0.001);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = card.top + card.span;
      card.lane = lane;
    }
    c.lanes = Math.max(1, laneEnds.length);
  }

  // ---- pay period hours by tech ----
  const periodDone = new Map();
  const seen = new Set();
  for (const ro of closedInPeriod) {
    if (seen.has(ro.id) || ro.deletedDate || !ro.completedDate) continue;
    seen.add(ro.id);
    const d = localDate(new Date(ro.completedDate), TZ);
    if (d < period.start || d > period.end) continue;
    for (const j of ro.jobs ?? []) {
      if (j.authorized === false || j.archived) continue;
      const t = j.technicianId ?? ro.technicianId;
      if (t) periodDone.set(t, (periodDone.get(t) ?? 0) + (Number(j.laborHours) || 0));
    }
  }
  const yesterday = addDays(date, -1);
  const daysWorked = yesterday < period.start ? 0 : workDaysBetween(period.start, yesterday < period.end ? yesterday : period.end, settings.workDays);
  const daysTotal = workDaysBetween(period.start, period.end, settings.workDays);

  // ---- per-tech totals ----
  const out = [];
  for (const c of columns.values()) {
    const active = round1(c.cards.filter((k) => k.counts).reduce((s, k) => s + k.hours, 0));
    const partsHold = round1(c.parked.filter((k) => k.state === 'parts').reduce((s, k) => s + k.hours, 0));
    const offsite = round1(c.parked.filter((k) => k.state === 'offsite').reduce((s, k) => s + k.hours, 0));
    if (c.type === 'tech') {
      const standing = techSettings.get(c.id)?.capacity ?? capacityOverrides[c.id] ?? settings.defaultCapacityHours;
      const avail = availability.get(c.id) ?? null;
      const capacity = round1(availableHours(standing, avail));
      const ratio = capacity ? active / capacity : (active > 0 ? 2 : 0);
      const completed = round1(periodDone.get(c.id) ?? 0);
      Object.assign(c, {
        capacity, standingCapacity: standing, active, open: round1(capacity - active), partsHold, offsite,
        availability: avail ? { status: avail.status, leaveHour: avail.leaveHour ?? null, limitHours: avail.limitHours ?? null, note: avail.note ?? '', capacityToday: avail.capacityToday ?? null, synced: Boolean(avail.eventId) || avail.status === 'in' } : { status: 'in' },
        out: avail?.status === 'out',
        status: active > capacity ? 'over' : ratio >= settings.nearFullRatio ? 'near' : 'open',
        appts: new Set(c.cards.map((k) => k.roId ?? k.appointmentId)).size,
        pay: { start: period.start, end: period.end, completed, pace: round1(completed - daysWorked * standing), daysWorked, daysTotal },
      });
    } else Object.assign(c, { active, partsHold, offsite, appts: c.cards.length });
    out.push(c);
  }
  const techCols = out.filter((c) => c.type === 'tech');

  // ---- week strip ----
  const week = [];
  for (let i = 0; i < 6; i++) {
    const d = addDays(mon, i);
    const list = weekAppts.filter((a) => live(a) && a.customerId && localDate(new Date(a.startTime), TZ) === d);
    week.push({ date: d, closed: !settings.workDays.includes(weekday(d)), count: list.length, waiters: list.filter(isWaiter).length });
  }
  const counts = week.filter((w) => !w.closed).map((w) => w.count);
  const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  for (const w of week) w.heavy = !w.closed && w.count >= avg * 1.15 && w.count > 0;

  const customerAppts = dayAppts.filter((a) => a.customerId);
  const waiters = customerAppts.filter(isWaiter).length;
  const unassigned = columns.get('unassigned');

  // ---- Day – Service Advisor view: one column per advisor ----
  // Today's customers on a timeline at their drop-off / waiter time, one card per RO or appointment,
  // plus each advisor's ROs waiting on authorization.
  const { list: advisors, missing: advisorsMissing } = await pickAdvisors(client, shopId, employees);
  const advCols = new Map([['unassigned', { id: 'unassigned', type: 'unassigned', name: 'Unassigned', cards: [], waiting: [] }]]);
  for (const e of advisors) advCols.set(e.id, { id: e.id, type: 'advisor', name: personName(e), initials: initials(e), cards: [], waiting: [] });
  const advCol = (id) => {
    if (id && advCols.has(id)) return advCols.get(id);
    const e = id && empById.get(id);
    if (e) { advCols.set(e.id, { id: e.id, type: 'advisor', name: personName(e), initials: initials(e), cards: [], waiting: [] }); return advCols.get(e.id); }
    return advCols.get('unassigned');
  };
  const techCards = out.flatMap((c) => [...c.cards, ...c.parked].map((k) => ({ ...k, techName: c.type === 'tech' ? c.name : null })));
  const seenRO = new Set();
  for (const k of techCards) {
    if (k.dropHour == null) continue; // carry-over work isn't on the advisor's timeline
    if (k.kind === 'ro') {
      if (seenRO.has(k.roId)) continue; seenRO.add(k.roId);
      const ro = roById.get(k.roId);
      const techs = techCards.filter((x) => x.roId === k.roId).map((x) => x.techName).filter(Boolean);
      advCol(ro?.serviceWriterId).cards.push({ ...k, key: `sa-ro-${k.roId}`, hours: round1(techCards.filter((x) => x.roId === k.roId).reduce((t, x) => t + x.hours, 0)), techs, advisorId: ro?.serviceWriterId ?? null });
    } else advCol(k.advisorId).cards.push({ ...k, key: `sa-${k.key}`, techs: k.techName ? [k.techName] : [] });
  }
  for (const ro of authROs) {
    const since = ro.updatedDate ?? ro.createdDate;
    advCol(ro.serviceWriterId).waiting.push({ roId: ro.id, roNumber: ro.repairOrderNumber, ...who(ro), label: roLabel(ro), since,
      hours: round1((ro.jobs ?? []).filter((j) => !j.archived).reduce((t, j) => t + (Number(j.laborHours) || 0), 0)) });
  }
  for (const c of advCols.values()) {
    for (const k of c.cards) { k.top = k.dropHour; k.span = 1; }
    c.cards.sort((x, y) => x.top - y.top);
    const ends = [];
    for (const k of c.cards) { let l = ends.findIndex((e) => e <= k.top + 0.001); if (l === -1) { l = ends.length; ends.push(0); } ends[l] = k.top + k.span; k.lane = l; }
    c.lanes = Math.max(1, ends.length);
    c.waiting.sort((x, y) => String(x.since).localeCompare(String(y.since)));
    Object.assign(c, { appts: c.cards.length, waiters: c.cards.filter((k) => k.waiter).length, notArrived: c.cards.filter((k) => k.kind === 'appt' && k.state === 'notArrived').length });
  }
  const advisorView = { missing: advisorsMissing, columns: [...advCols.values()].filter((c) => c.type === 'unassigned' || c.cards.length || c.waiting.length || advisors.some((e) => e.id === c.id)) };

  return {
    advisorView,
    shopId: Number(shopId), date, isToday,
    nowHour: isToday ? localHours(now, TZ) : null,
    hours: (() => {
      const tops = out.filter((c) => c.type === 'tech').flatMap((c) => c.cards.map((k) => [k.top, k.top + k.span]));
      return {
        open: settings.openHour, close: settings.closeHour,
        start: Math.min(settings.openHour, ...tops.map(([t]) => Math.floor(t))),
        end: Math.max(settings.closeHour, ...tops.map(([, e]) => Math.ceil(e))),
      };
    })(),
    week, events, noShows,
    summary: {
      appointments: customerAppts.length, waiters, dropoffs: customerAppts.length - waiters,
      activeHours: round1(techCols.reduce((s, c) => s + c.active, 0)),
      capacityHours: round1(techCols.reduce((s, c) => s + c.capacity, 0)),
      partsHold: round1(out.reduce((s, c) => s + c.partsHold, 0)), partsHoldROs: out.reduce((s, c) => s + c.parked.filter((k) => k.state === 'parts').length, 0),
      offsite: round1(out.reduce((s, c) => s + c.offsite, 0)), offsiteROs: out.reduce((s, c) => s + c.parked.filter((k) => k.state === 'offsite').length, 0),
      unassigned: unassigned.cards.length, unassignedHours: unassigned.active,
    },
    columns: out,
    techCount: allTechs.length, hiddenTechs: allTechs.length - techs.length,
    synced,
    namesPending,
    generatedAt: new Date().toISOString(),
  };
}
