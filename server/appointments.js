// Booking, rescheduling and status changes for customer appointments in Tekmetric.
//
// Tekmetric's API notes that shape this file:
// - Create and update take a color NAME (red, yellow, …) but reads return a HEX color.
//   The board learns which hex Tekmetric uses for each name once ("color check") and keeps it,
//   so a reschedule never changes an appointment's color.
// - Update requires shopId, startTime, endTime and title, so every update re-sends the
//   appointment's current fields with only the changed ones replaced.
// - The API can't set "Stay with vehicle", so waiters booked here are marked by the green color.

import { settings } from './config.js';
import { addDays, localDate, localHours, zonedTime } from './time.js';

const TZ = settings.timeZone;
export const COLOR_NAMES = ['red', 'pink', 'yellow', 'orange', 'light green', 'green', 'blue', 'navy', 'lavender', 'purple'];
const STATUSES = ['NONE', 'ARRIVED', 'NO_SHOW', 'CANCELED'];
// Board categories → Tekmetric color names (Toy Doctor's color code)
export const CATEGORY_COLOR = { red: 'red', yellow: 'yellow', blue: 'blue', green: 'green', purple: 'purple' };
// Starting estimate for each kind of work, used when booking
export const CATEGORY_HOURS = { red: 3, yellow: 1, blue: 1.5, green: 1, purple: 2 };

// Rough hexes, only used until the color check has run (and in demo mode)
const APPROX = { red: '#D50000', pink: '#E67C73', yellow: '#F6BF26', orange: '#F4511E', 'light green': '#7CB342', green: '#33B679', blue: '#039BE5', navy: '#3F51B5', lavender: '#7986CB', purple: '#8E24AA' };

const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const at = (date, hour) => iso(zonedTime(date, Math.floor(hour), Math.round((hour % 1) * 60), TZ));
const rgb = (hex) => { const n = parseInt(String(hex).replace('#', ''), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const isHex = (h) => /^#?[0-9a-f]{6}$/i.test(h ?? '');
const str = (x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : x?.name ?? '');
const code = (v) => (typeof v === 'string' ? v : v?.code ?? v?.name ?? null);

export function colorName(hex, palette) {
  if (!hex) return null;
  if (COLOR_NAMES.includes(String(hex).toLowerCase())) return String(hex).toLowerCase();
  if (!isHex(hex)) return null;
  const table = { ...APPROX, ...(palette ?? {}) };
  const exact = Object.entries(table).find(([, h]) => h.toLowerCase() === (hex.startsWith('#') ? hex : `#${hex}`).toLowerCase());
  if (exact) return exact[0];
  const [r, g, b] = rgb(hex);
  let best = null; let bestD = Infinity;
  for (const [name, h] of Object.entries(table)) {
    const [r2, g2, b2] = rgb(h);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

// The update body: everything the appointment has now, with `changes` on top.
export function updateBody(appt, changes, palette) {
  const body = {
    shopId: appt.shopId,
    customerId: appt.customerId ?? undefined,
    vehicleId: appt.vehicleId ?? undefined,
    startTime: appt.startTime, endTime: appt.endTime,
    title: appt.title || 'Appointment',
    description: appt.description ?? undefined,
    color: colorName(appt.color, palette) ?? undefined,
    dropoffTime: appt.dropoffTime ?? undefined,
    pickupTime: appt.pickupTime ?? undefined,
    rideOption: ['LOANER', 'RIDE'].includes(code(appt.rideOption)) && appt.dropoffTime && appt.pickupTime ? code(appt.rideOption) : undefined,
    status: STATUSES.includes(code(appt.appointmentStatus)) ? code(appt.appointmentStatus) : undefined,
    leadSource: typeof appt.leadSource === 'string' && appt.leadSource ? appt.leadSource : undefined,
    ...changes,
  };
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
}

// Saves an appointment. Tekmetric refuses customer and vehicle on follow-up appointments (ones made from an
// RO), even unchanged, so when it says so the save is retried without them (they can't change anyway).
export async function patchAppt(client, id, body, vehicleChanged) {
  try { return await client.patchAppointment(id, body); }
  catch (e) {
    if (!/follow-up/i.test(e.message)) throw e;
    if (vehicleChanged) throw new UserError('This is a follow-up appointment from an RO, so Tekmetric doesn\'t allow changing its vehicle.');
    const { customerId, vehicleId, ...rest } = body;
    return client.patchAppointment(id, rest);
  }
}

// ---- color check: learn Tekmetric's hex for each color name, once ----
let paletteCache = null;
export async function getPalette({ client, store, env }) {
  if (paletteCache) return paletteCache;
  const saved = await store.getMeta(`colors-${env}`);
  if (saved?.palette) { paletteCache = saved.palette; return paletteCache; }
  return null;
}

export async function runColorCheck({ client, store, env, shopId }) {
  // A short event far in the future (a year out, 6:00 am), recolored through every color, then deleted.
  const day = addDays(localDate(new Date(), TZ), 371);
  const base = { shopId, startTime: at(day, 6), endTime: at(day, 6.25), title: 'Dispatch board color check – safe to delete', description: 'Created and removed automatically by the Toy Doctor dispatch board.' };
  const created = await client.createAppointment({ ...base, color: COLOR_NAMES[0] });
  const id = created?.data;
  if (!id) throw new Error('Color check: Tekmetric did not return an appointment id.');
  const palette = {};
  try {
    for (const name of COLOR_NAMES) {
      if (name !== COLOR_NAMES[0]) await client.patchAppointment(id, { ...base, color: name });
      const a = await client.getAppointment(id, shopId, base.startTime);
      if (isHex(a?.color)) palette[name] = a.color.startsWith('#') ? a.color : `#${a.color}`;
    }
  } finally {
    await client.deleteAppointment(id).catch((e) => console.error(`Color check: could not delete test event ${id} on ${day} at 6:00 am: ${e.message}`));
    client.clearCache();
  }
  if (Object.keys(palette).length < COLOR_NAMES.length) throw new Error('Color check: Tekmetric did not return every color.');
  await store.setMeta(`colors-${env}`, { palette, at: new Date().toISOString() });
  paletteCache = palette;
  return palette;
}

async function paletteOrCheck(ctx, shopId) {
  return (await getPalette(ctx)) ?? (await runColorCheck({ ...ctx, shopId }));
}

// ---- searches for the booking form ----
const phoneOf = (c) => {
  const list = Array.isArray(c.phone) ? c.phone : [];
  const p = list.find((x) => x.primary) ?? list[0];
  return p?.number ?? (typeof c.phone === 'string' ? c.phone : '');
};
export async function searchCustomers(client, shopId, q) {
  const list = await client.searchCustomers(shopId, q);
  return list.filter((c) => !c.deletedDate).slice(0, 12).map((c) => ({
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.companyName || 'Customer',
    lastName: c.lastName || c.firstName || c.companyName || 'Customer',
    phone: phoneOf(c), email: c.email ?? '',
  }));
}
export async function customerVehicles(client, shopId, customerId) {
  const list = await client.getVehicles(shopId, customerId);
  return list.filter((v) => !v.deletedDate).map((v) => ({
    id: v.id, model: str(v.model) || str(v.make) || 'Vehicle',
    text: [v.year, v.make, v.model, v.subModel].map(str).filter(Boolean).join(' ') || `Vehicle #${v.id}`,
    plate: v.licensePlate ?? '',
  }));
}

// ---- book ----
export async function bookAppointment(ctx, input) {
  const { client, store, user } = ctx;
  const shopId = Number(input.shopId);
  const category = CATEGORY_COLOR[input.category] ? input.category : null;
  if (!shopId || !input.customerId || !input.vehicleId) throw new UserError('Pick a customer and a vehicle.');
  if (!category) throw new UserError('Pick the type of work.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) throw new UserError('Pick a date.');
  const startHour = quarter(input.startHour);
  if (!(startHour >= 6 && startHour <= 20)) throw new UserError('Pick an appointment time between 6:00 am and 8:00 pm.');
  const dropHour = input.dropHour == null || input.dropHour === '' ? null : quarter(input.dropHour);
  if (dropHour != null && !(dropHour >= 5 && dropHour <= startHour)) throw new UserError('Drop-off should be at or before the appointment time.');
  const hours = clamp(Number(input.hours) || CATEGORY_HOURS[category], 0.1, 24);
  const concern = String(input.concern ?? '').trim().slice(0, 500);
  if (!concern) throw new UserError('Add the concern or work requested.');
  // Tekmetric wants drop-off and pick-up times whenever a ride option is sent, so "None" sends nothing
  const ride = ['LOANER', 'RIDE'].includes(input.rideOption) ? input.rideOption : null;
  const pickHour = input.pickupHour == null || input.pickupHour === '' ? null : quarter(input.pickupHour);
  if (ride && pickHour == null) throw new UserError('Add a pick-up time for the loaner or ride.');
  if (pickHour != null && !(pickHour > (dropHour ?? startHour) && pickHour <= 22)) throw new UserError('Pick-up should be after drop-off.');

  const body = {
    shopId, customerId: Number(input.customerId), vehicleId: Number(input.vehicleId),
    startTime: at(input.date, startHour), endTime: at(input.date, startHour + 0.5),
    title: taggedTitle(String(input.title ?? '').trim().slice(0, 80) || 'Appointment', input.techName ?? '', []),
    description: concern, color: CATEGORY_COLOR[category],
    ...(dropHour != null && dropHour < startHour ? { dropoffTime: at(input.date, dropHour) } : {}),
    ...(pickHour != null ? { pickupTime: at(input.date, pickHour) } : {}),
    ...(ride ? { rideOption: ride, dropoffTime: at(input.date, dropHour ?? startHour) } : {}),
  };
  const res = await client.createAppointment(body);
  const id = Number(res?.data);
  if (!id) throw new Error('Tekmetric did not return the new appointment id.');
  const techId = input.techId == null || input.techId === '' ? null : Number(input.techId);
  const advisorId = input.advisorId == null || input.advisorId === '' ? null : Number(input.advisorId);
  await store.setAssignment(shopId, id, { techId, hours, advisorId, by: user });
  client.clearCache();
  return { ok: true, appointmentId: id, techId, hours };
}

// ---- reschedule / status ----
export async function changeAppointment(ctx, id, input) {
  const { client, store } = ctx;
  const shopId = Number(input.shopId);
  const appt = await client.getAppointment(Number(id), shopId, input.knownStart);
  if (!appt || appt.deletedDate) throw new UserError('That appointment was not found. It may have been deleted in Tekmetric.');
  if (Number(appt.shopId) !== shopId) throw new UserError('That appointment belongs to the other location.');
  const palette = await paletteOrCheck(ctx, shopId);
  const changes = {};
  const oldDate = localDate(new Date(appt.startTime), TZ);
  let newDate = oldDate;

  if (input.status != null) {
    if (!['NO_SHOW', 'CANCELED', 'NONE'].includes(input.status)) throw new UserError('Unknown status.');
    changes.status = input.status;
  }
  if (input.date != null || input.startHour != null) {
    newDate = input.date ?? oldDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) throw new UserError('Pick a date.');
    const oldStart = new Date(appt.startTime).getTime();
    const startHour = input.startHour != null ? quarter(input.startHour) : localHours(new Date(appt.startTime), TZ);
    if (!(startHour >= 6 && startHour <= 20)) throw new UserError('Pick a time between 6:00 am and 8:00 pm.');
    const start = zonedTime(newDate, Math.floor(startHour), Math.round((startHour % 1) * 60), TZ).getTime();
    const shift = start - oldStart;
    const length = Math.max(new Date(appt.endTime).getTime() - oldStart, 15 * 60_000);
    changes.startTime = iso(start);
    changes.endTime = iso(start + length);
    // drop-off and pick-up move with the appointment
    if (appt.dropoffTime) changes.dropoffTime = iso(new Date(appt.dropoffTime).getTime() + shift);
    // pick-up keeps its time of day on the new date (e.g. 5:00), unless that's no longer after the appointment
    if (appt.pickupTime) {
      const ph = localHours(new Date(appt.pickupTime), TZ);
      const same = zonedTime(newDate, Math.floor(ph), Math.round((ph % 1) * 60), TZ).getTime();
      changes.pickupTime = iso(same > start ? same : new Date(appt.pickupTime).getTime() + shift);
    }
    if (input.dropHour !== undefined) {
      const d = input.dropHour == null || input.dropHour === '' ? null : quarter(input.dropHour);
      if (d != null && !(d >= 5 && d <= startHour)) throw new UserError('Drop-off should be at or before the appointment time.');
      if (d != null && d < startHour) changes.dropoffTime = at(newDate, d);
      else if (appt.dropoffTime) changes.dropoffTime = changes.startTime; // no separate drop-off: same as the appointment
    }
  }
  // ---- the rest of the appointment: type of work, concern, vehicle, ride ----
  if (input.category != null) {
    if (!CATEGORY_COLOR[input.category]) throw new UserError('Pick the type of work.');
    changes.color = CATEGORY_COLOR[input.category];
  }
  if (input.concern != null) {
    const concern = String(input.concern).trim().slice(0, 500);
    if (!concern) throw new UserError('Add the concern or work requested.');
    if (concern !== (appt.description ?? '')) changes.description = concern;
  }
  if (input.vehicleId != null && Number(input.vehicleId) !== Number(appt.vehicleId)) {
    const list = appt.customerId ? await client.getVehicles(shopId, appt.customerId) : [];
    if (!list.some((v) => v.id === Number(input.vehicleId))) throw new UserError('That vehicle isn\'t on this customer\'s account.');
    changes.vehicleId = Number(input.vehicleId);
  }
  if (input.rideOption != null) {
    const ride = ['LOANER', 'RIDE', 'NONE'].includes(input.rideOption) ? input.rideOption : 'NONE';
    const had = code(appt.rideOption);
    const start = changes.startTime ?? appt.startTime;
    const day = localDate(new Date(start), TZ);
    const pick = input.pickupHour == null || input.pickupHour === '' ? null : quarter(input.pickupHour);
    if (ride !== 'NONE') {
      if (pick == null) throw new UserError('Add a pick-up time for the loaner or ride.');
      // Tekmetric needs both times with a ride option
      changes.rideOption = ride;
      changes.pickupTime = at(day, pick);
      changes.dropoffTime = changes.dropoffTime ?? appt.dropoffTime ?? start;
      if (new Date(changes.pickupTime) <= new Date(changes.dropoffTime)) throw new UserError('Pick-up should be after drop-off.');
    } else if (['LOANER', 'RIDE'].includes(had)) {
      changes.rideOption = 'NONE';
      changes.dropoffTime = changes.dropoffTime ?? appt.dropoffTime ?? start;
      changes.pickupTime = pick != null ? at(day, pick) : changes.pickupTime ?? appt.pickupTime ?? changes.endTime ?? appt.endTime;
    } else if (pick != null) changes.pickupTime = at(day, pick);
  }
  if (!Object.keys(changes).length) return { ok: true, unchanged: true };
  const body = updateBody(appt, changes, palette);
  if (changes.rideOption) body.rideOption = changes.rideOption; // an explicit change is always sent
  await patchAppt(client, appt.id, body, Boolean(changes.vehicleId));
  client.clearCache();
  // a board plan belongs to the day it was made for
  if (newDate !== oldDate || changes.status === 'NO_SHOW' || changes.status === 'CANCELED') await store.setPlan(shopId, oldDate, `appt-${appt.id}`, null);
  return { ok: true, appointmentId: appt.id, date: newDate, status: body.status ?? 'NONE' };
}

// "Still coming": stop asking about this appointment today. Board only.
export async function keepNoShow({ store }, shopId, date, appointmentId) {
  await store.setMeta(`noshow-keep-${shopId}_${date}`, { [appointmentId]: new Date().toISOString() });
}

export class UserError extends Error {}
const quarter = (h) => Math.round(Number(h) * 4) / 4;
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// ---- the assigned tech, shown in Tekmetric ----
// Tekmetric's API has no employee field on appointments, so the board puts the tech's name at the front of
// the appointment title: "[Sam K.] Nguyen – 4Runner". It only touches a leading tag that is a tech's name,
// so anything else an advisor typed in brackets stays.
export const techTag = (e) => (e ? `${e.firstName ?? ''} ${(e.lastName ?? '').trim().slice(0, 1)}.`.replace(/\s+/g, ' ').trim() : '');
export function taggedTitle(title, techName, employees) {
  const names = new Set(employees.map(techTag).filter(Boolean).map((n) => n.toLowerCase()));
  let base = String(title ?? '').trim();
  const m = /^\[([^\]]{1,40})\]\s*/.exec(base);
  if (m && names.has(m[1].trim().toLowerCase())) base = base.slice(m[0].length);
  return (techName ? `[${techName}] ${base}` : base).trim().slice(0, 120) || 'Appointment';
}
export async function tagAppointment(ctx, { shopId, appointmentId, techId, employees }) {
  const { client } = ctx;
  try {
    const appt = await client.getAppointment(Number(appointmentId), Number(shopId));
    if (!appt || appt.deletedDate) return { tagged: false };
    const tech = techId ? employees.find((e) => e.id === Number(techId)) : null;
    const title = taggedTitle(appt.title, techTag(tech), employees);
    if (title === appt.title) return { tagged: true, unchanged: true };
    const palette = await paletteOrCheck(ctx, Number(shopId));
    await patchAppt(client, appt.id, updateBody(appt, { title }, palette), false);
    client.clearCache();
    return { tagged: true, title };
  } catch (e) {
    console.error(`Could not tag appointment ${appointmentId} with its tech: ${e.message}`);
    return { tagged: false, error: 'The tech was saved on the board, but the name could not be added to the Tekmetric appointment title.' };
  }
}
