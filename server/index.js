// Toy Doctor Scheduler — web server.
// Serves the board UI and a small API that reads Tekmetric and applies the shop's rules.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createTekmetricClient } from './tekmetric.js';
import { createMockClient, demoNow } from './mock.js';
import { createAuth } from './auth.js';
import { buildBoard } from './board.js';
import { settings } from './config.js';
import { localDate } from './time.js';
import { createStore } from './store.js';
import { assignOpenRO } from './sync.js';
import { saveAvailability } from './availability.js';

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
      shops: shops.map((s) => ({ id: s.id, name: settings.shopNames[s.id] ?? s.nickname ?? s.name })),
    });
  } catch (e) { next(e); }
});

app.get('/api/board', auth.require, async (req, res, next) => {
  try {
    const shopId = Number(req.query.shop);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date : localDate(now(), settings.timeZone);
    if (!shopId) return res.status(400).json({ error: 'shop is required' });
    res.json(await buildBoard(client, { shopId, date, now: now(), store }));
  } catch (e) { next(e); }
});

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
      if (techId == null) await store.removeAssignment(shopId, Number(appointmentId));
      else await store.setAssignment(shopId, Number(appointmentId), { techId, hours, by: req.user.email });
      return res.json({ ok: true });
    }
    if (techId == null) return res.status(400).json({ error: 'Pick a tech for this RO.' });
    const ros = (await Promise.all([1, 2].map((st) => client.getRepairOrders(shopId, { repairOrderStatusId: String(st) })))).flat();
    const ro = ros.find((r) => r.id === Number(roId));
    if (!ro) return res.status(404).json({ error: 'That RO is no longer open.' });
    res.json({ ok: true, ...(await assignOpenRO({ client, ro, techId })) });
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
    const [list, settingsMap] = await Promise.all([techList(shopId), store.getTechSettings(shopId)]);
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
      return [Number(c.techId), v];
    });
    await store.setTechSettings(shopId, entries);
    res.json({ ok: true, changed: entries.length });
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

app.use(express.static(path.join(root, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong loading data from Tekmetric. Try again in a minute.' });
});

const port = Number(env.PORT) || 8080;
app.listen(port, () => console.log(`Toy Doctor Scheduler on http://localhost:${port}${MOCK ? ' (demo data)' : ` (Tekmetric ${env.TEKMETRIC_ENV || 'sandbox'})`}`));
