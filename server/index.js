// Toy Doctor Scheduler — web server.
// Serves the board UI and a small API that reads Tekmetric and applies the shop's rules.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createTekmetricClient } from './tekmetric.js';
import { createMockClient, demoNow } from './mock.js';
import { createAuth } from './auth.js';
import { buildBoard, pickAdvisors, sortTechs } from './board.js';
import { buildMonth, buildWeek } from './views.js';
import { settings, shopLabel } from './config.js';
import { localDate } from './time.js';
import { createStore } from './store.js';
import { assignOpenRO, reassignRO } from './sync.js';
import { saveAvailability } from './availability.js';
import { bookAppointment, changeAppointment, customerVehicles, keepNoShow, searchCustomers, UserError } from './appointments.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load a local .env file if there is one (Cloud Run sets real environment variables instead).
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const env = process.env;
const MOCK = env.TEKMETRIC_MOCK === 'true';
const now = () => (MOCK ? demoNow() : new Date());

const client = MOCK
  ? createMockClient()
  : createTekmetricClient({ clientId: env.TEKMETRIC_CLIENT_ID, clientSecret: env.TEKMETRIC_CLIENT_SECRET, environment: env.TEKMETRIC_ENV });
const auth = createAuth({
  clientId: env.GOOGLE_CLIENT_ID,
  allowedDomain: env.ALLOWED_DOMAIN || 'toydoctorinc.com',
  sessionSecret: env.SESSION_SECRET,
  disabled: env.AUTH_DISABLED === 'true',
});

const store = await createStore({ useFirestore: env.STORE === 'firestore', file: path.join(root, 'data', MOCK ? 'demo-store.json' : 'store.json') });

const app = express();
app.use(express.json());

app.get('/auth/config', auth.config);
app.post('/auth/google', auth.signIn);
app.post('/auth/logout', auth.signOut);

app.get('/api/shops', auth.require, async (req, res, next) => {
  try {
    const shops = await client.getShops();
    res.json({
      demo: MOCK,
      today: localDate(now(), settings.timeZone),
      shops: shops.map((s) => ({ id: s.id, name: shopLabel(s, shops), tekmetricName: s.nickname || s.name || '', city: s.address?.city ?? '' })),
    });
  } catch (e) { next(e); }
});

app.get('/api/board', auth.require, async (req, res, next) => {
  try {
    const shopId = Number(req.query.shop);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date : localDate(now(), settings.timeZone);
    if (!shopId) return res.status(400).json({ error: 'shop is required' });
    const b = await buildBoard(client, { shopId, date, now: now(), store });
    // the signed-in person's Tekmetric employee id (default advisor when booking)
    const email = (req.user?.email ?? '').toLowerCase();
    b.me = email ? (await client.getEmployees(shopId)).find((e) => (e.email ?? '').toLowerCase() === email && !e.disabled)?.id ?? null : null;
    res.json(b);
  } catch (e) { next(e); }
});

// Week and Month planners
for (const [route, build] of [['/api/week', buildWeek], ['/api/month', buildMonth]]) {
  app.get(route, auth.require, async (req, res, next) => {
    try {
      const shopId = Number(req.query.shop);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date : localDate(now(), settings.timeZone);
      if (!shopId) return res.status(400).json({ error: 'shop is required' });
      res.json({ ...(await build(client, { shopId, date, store })), today: localDate(now(), settings.timeZone) });
    } catch (e) { next(e); }
  });
}

// Assign a booked appointment (stored; written to the RO on arrival) or an open RO (written now).
app.post('/api/assign', auth.require, async (req, res, next) => {
  try {
    const { shopId, appointmentId, roId } = req.body ?? {};
    const techId = req.body?.techId == null ? null : Number(req.body.techId);
    const hours = Math.min(Math.max(Number(req.body?.hours) || 1, 0.1), 24);
    if (!shopId || (!appointmentId && !roId)) return res.status(400).json({ error: 'shopId and appointmentId or roId are required' });
    const techs = (await client.getEmployees(shopId)).filter((e) => e.canPerformWork && !e.disabled);
    if (techId != null && !techs.some((t) => t.id === techId)) return res.status(400).json({ error: 'That tech was not found at this shop.' });

    if (appointmentId) {
      // back to Unassigned keeps the estimated hours
      if (techId == null) await store.setAssignment(shopId, Number(appointmentId), { techId: null, hours, by: req.user.email });
      else await store.setAssignment(shopId, Number(appointmentId), { techId, hours, by: req.user.email });
      return res.json({ ok: true });
    }
    if (techId == null) return res.status(400).json({ error: 'Pick a tech for this RO.' });
    const ros = (await Promise.all([1, 2].map((st) => client.getRepairOrders(shopId, { repairOrderStatusId: String(st) })))).flat();
    const ro = ros.find((r) => r.id === Number(roId));
    if (!ro) return res.status(404).json({ error: 'That RO is no longer open.' });
    const fromTechId = req.body?.fromTechId == null ? null : Number(req.body.fromTechId);
    // a card already on a tech: move that tech's work on the RO to the new tech (written now)
    if (fromTechId != null) return res.json({ ok: true, ...(await reassignRO({ client, ro, fromTechId, toTechId: techId })) });
    res.json({ ok: true, ...(await assignOpenRO({ client, ro, techId })) });
  } catch (e) { next(e); }
});

// Pick the service advisor: stored for a booked appointment (written to the RO's service writer when it
// opens, blanks only), or written now to an open RO that has no service writer yet.
app.post('/api/advisor', auth.require, async (req, res, next) => {
  try {
    const { shopId, appointmentId, roId } = req.body ?? {};
    const advisorId = req.body?.advisorId == null || req.body.advisorId === '' ? null : Number(req.body.advisorId);
    if (!shopId || (!appointmentId && !roId)) return res.status(400).json({ error: 'shopId and appointmentId or roId are required' });
    if (advisorId != null && !(await client.getEmployees(shopId)).some((e) => e.id === advisorId && !e.disabled)) return res.status(400).json({ error: 'That advisor was not found at this shop.' });
    if (appointmentId) { await store.setAssignment(Number(shopId), Number(appointmentId), { advisorId, by: req.user.email }); return res.json({ ok: true }); }
    if (advisorId == null) return res.status(400).json({ error: 'Pick an advisor for this RO.' });
    const ros = (await Promise.all([1, 2].map((st) => client.getRepairOrders(shopId, { repairOrderStatusId: String(st) })))).flat();
    const ro = ros.find((r) => r.id === Number(roId));
    if (!ro) return res.status(404).json({ error: 'That RO is no longer open.' });
    if (ro.serviceWriterId && ro.serviceWriterId !== advisorId) return res.status(400).json({ error: `RO ${ro.repairOrderNumber} already has a service writer in Tekmetric. Change it there.` });
    await client.patchRepairOrder(ro.id, { serviceWriterId: advisorId });
    client.clearCache();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const techList = async (shopId) => (await client.getEmployees(shopId)).filter((e) => e.canPerformWork && !e.disabled);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');

// A tech's availability for one day (and optionally their every-day capacity).
// Creates / updates / removes the matching Tekmetric custom event.
app.post('/api/availability', auth.require, async (req, res, next) => {
  try {
    const { shopId, date, techId, capacityEveryDay } = req.body ?? {};
    if (!shopId || !isDate(date) || !techId) return res.status(400).json({ error: 'shopId, date and techId are required' });
    const tech = (await techList(shopId)).find((t) => t.id === Number(techId));
    if (!tech) return res.status(404).json({ error: 'That tech was not found at this shop.' });
    if (capacityEveryDay != null && capacityEveryDay !== '') {
      const c = Math.round(Number(capacityEveryDay) * 10) / 10;
      if (!(c >= 0 && c <= 16)) return res.status(400).json({ error: 'Capacity must be between 0 and 16 hours.' });
      await store.setTechSettings(Number(shopId), [[tech.id, { capacity: c }]]);
    }
    let result;
    try { result = await saveAvailability({ client, store, shopId: Number(shopId), date, tech, input: req.body, by: req.user.email }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    res.json(result);
  } catch (e) { next(e); }
});

// Manage techs: who shows on the board, and their every-day capacity.
app.get('/api/techs', auth.require, async (req, res, next) => {
  try {
    const shopId = Number(req.query.shop);
    const [all, settingsMap] = await Promise.all([techList(shopId), store.getTechSettings(shopId)]);
    const list = sortTechs(all, settingsMap);
    res.json({ techs: list.map((t) => ({ id: t.id, name: `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim(), role: t.employeeRole?.name ?? '', show: settingsMap.get(t.id)?.show !== false, capacity: settingsMap.get(t.id)?.capacity ?? settings.defaultCapacityHours })) });
  } catch (e) { next(e); }
});
app.post('/api/techs', auth.require, async (req, res, next) => {
  try {
    const shopId = Number(req.body?.shopId);
    const valid = new Set((await techList(shopId)).map((t) => t.id));
    const entries = (req.body?.changes ?? []).filter((c) => valid.has(Number(c.techId))).map((c) => {
      const v = {};
      if (typeof c.show === 'boolean') v.show = c.show;
      if (c.capacity != null && Number(c.capacity) >= 0 && Number(c.capacity) <= 16) v.capacity = Math.round(Number(c.capacity) * 10) / 10;
      if (Number.isInteger(c.order) && c.order >= 0 && c.order < 500) v.order = c.order;
      return [Number(c.techId), v];
    });
    await store.setTechSettings(shopId, entries);
    res.json({ ok: true, changed: entries.length });
  } catch (e) { next(e); }
});

// Manage advisors: who gets a column on the Day – Service Advisor view, and in what order (per location).
app.get('/api/advisors', auth.require, async (req, res, next) => {
  try {
    const shopId = Number(req.query.shop);
    const employees = await client.getEmployees(shopId);
    const { list } = await pickAdvisors(client, shopId, employees, store);
    const shown = new Set(list.map((e) => e.id));
    const active = employees.filter((e) => !e.disabled);
    // shown first (in order), then everyone else who isn't a tech, then techs
    const rest = active.filter((e) => !shown.has(e.id)).sort((a, b) => Number(a.canPerformWork) - Number(b.canPerformWork) || `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
    res.json({ advisors: [...list, ...rest].map((e) => ({ id: e.id, name: `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim(), role: e.employeeRole?.name ?? '', tech: Boolean(e.canPerformWork), show: shown.has(e.id) })) });
  } catch (e) { next(e); }
});
app.post('/api/advisors', auth.require, async (req, res, next) => {
  try {
    const shopId = Number(req.body?.shopId);
    const valid = new Set((await client.getEmployees(shopId)).map((e) => e.id));
    const people = {};
    (req.body?.order ?? []).filter((id) => valid.has(Number(id))).forEach((id, i) => { people[Number(id)] = { show: (req.body.show ?? []).map(Number).includes(Number(id)), order: i }; });
    if (!Object.values(people).some((p) => p.show)) return res.status(400).json({ error: 'Pick at least one advisor.' });
    await store.setMeta(`advisors-${shopId}`, { people, by: req.user.email, at: new Date().toISOString() });
    res.json({ ok: true, shown: Object.values(people).filter((p) => p.show).length });
  } catch (e) { next(e); }
});

// Plan when a tech works on a card (board only; never changes the appointment time in Tekmetric).
app.post('/api/plan', auth.require, async (req, res, next) => {
  try {
    const { shopId, date, key } = req.body ?? {};
    const hour = req.body?.hour == null ? null : Math.round(Number(req.body.hour) * 4) / 4;
    if (!shopId || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^(appt|ro)-[\w-]+$/.test(key ?? '')) return res.status(400).json({ error: 'shopId, date and key are required' });
    if (hour != null && !(hour >= 0 && hour < 24)) return res.status(400).json({ error: 'Pick a time during the day.' });
    await store.setPlan(Number(shopId), date, key, hour);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- booking, rescheduling, no-shows ----
const tekEnv = MOCK ? 'demo' : env.TEKMETRIC_ENV || 'sandbox';
const ctx = (req) => ({ client, store, env: tekEnv, user: req.user.email });
const userErrors = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof UserError) return res.status(400).json({ error: e.message });
    const tek = /^Tekmetric \w+ \S+ failed \((\d+)\): ?(.*)$/s.exec(e.message ?? '');
    if (tek && tek[1].startsWith('4')) {
      console.error(e.message);
      let why = tek[2];
      try { const j = JSON.parse(tek[2]); why = Object.values(j.details ?? {}).filter((v) => typeof v === 'string').join(' ') || j.message || why; } catch { /* plain text */ }
      return res.status(502).json({ error: `Tekmetric didn't accept that change${why ? `: ${String(why).slice(0, 140)}` : '.'}` });
    }
    next(e);
  }
};

app.get('/api/customers', auth.require, userErrors(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json({ customers: [] });
  res.json({ customers: await searchCustomers(client, Number(req.query.shop), q) });
}));
app.get('/api/vehicles', auth.require, userErrors(async (req, res) => {
  res.json({ vehicles: await customerVehicles(client, Number(req.query.shop), Number(req.query.customerId)) });
}));
// Book a new appointment in Tekmetric (and optionally assign the tech on the board)
app.post('/api/appointments', auth.require, userErrors(async (req, res) => {
  const techId = req.body?.techId;
  if (techId != null && techId !== '' && !(await techList(Number(req.body.shopId))).some((t) => t.id === Number(techId))) throw new UserError('That tech was not found at this shop.');
  res.json(await bookAppointment(ctx(req), req.body ?? {}));
}));
// Reschedule (date / time / drop-off) or set status (NO_SHOW, CANCELED) on an appointment in Tekmetric
app.patch('/api/appointments/:id', auth.require, userErrors(async (req, res) => {
  res.json(await changeAppointment(ctx(req), Number(req.params.id), req.body ?? {}));
}));
// "Still coming": stop flagging this no-show today (board only)
app.post('/api/noshow/keep', auth.require, userErrors(async (req, res) => {
  const { shopId, date, appointmentId } = req.body ?? {};
  if (!shopId || !isDate(date) || !appointmentId) throw new UserError('shopId, date and appointmentId are required');
  await keepNoShow(ctx(req), Number(shopId), date, Number(appointmentId));
  res.json({ ok: true });
}));

app.use(express.static(path.join(root, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong loading data from Tekmetric. Try again in a minute.' });
});

const port = Number(env.PORT) || 8080;
app.listen(port, () => console.log(`Toy Doctor Scheduler on http://localhost:${port}${MOCK ? ' (demo data)' : ` (Tekmetric ${env.TEKMETRIC_ENV || 'sandbox'})`}`));
