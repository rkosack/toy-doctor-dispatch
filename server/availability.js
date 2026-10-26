// Tech availability for a day (Out / Leaves early / Limit work / capacity today) and the
// matching Tekmetric custom event, so advisors working only in Tekmetric see it too.
//
// Rules (from the build spec):
// - Every tech defaults to In at their daily capacity.
// - The board writes the event title itself, so naming is consistent: "OFF – Sam K.",
//   "LEAVES 3:00 – Sam K.", "LIMIT 4h – Sam K." (+ " · note").
// - The board only edits or deletes events it created (it keeps their ids).

import { settings } from './config.js';
import { zonedTime } from './time.js';

const TZ = settings.timeZone;
const STATUSES = ['in', 'out', 'leave', 'limit'];
const fmt = (h) => { const hh = Math.floor(h); const mm = Math.round((h - hh) * 60); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}`; };
const at = (date, hour) => zonedTime(date, Math.floor(hour), Math.round((hour % 1) * 60), TZ).toISOString().replace('.000', '');
export const personName = (e) => (e ? `${e.firstName ?? ''} ${(e.lastName ?? '').slice(0, 1)}.`.trim() : '');

// Hours a tech can work today, given their capacity and availability.
export function availableHours(capacity, a) {
  if (!a || a.status === 'in') return a?.capacityToday ?? capacity;
  const base = a.capacityToday ?? capacity;
  if (a.status === 'out') return 0;
  if (a.status === 'limit') return Math.min(base, a.limitHours ?? base);
  if (a.status === 'leave') {
    const onSite = (a.leaveHour ?? settings.closeHour) - settings.openHour;
    const lunch = a.leaveHour > 12.5 ? 1 : 0; // a lunch hour only if they're here past midday
    return Math.max(0, Math.min(base, onSite - lunch));
  }
  return base;
}

export function eventFor(a, tech, date) {
  if (!a || a.status === 'in') return null;
  const who = personName(tech);
  const note = a.note ? ` · ${a.note}` : '';
  if (a.status === 'out') return { title: `OFF – ${who}${note}`, startTime: at(date, settings.openHour), endTime: at(date, settings.closeHour) };
  if (a.status === 'leave') return { title: `LEAVES ${fmt(a.leaveHour)} – ${who}${note}`, startTime: at(date, a.leaveHour), endTime: at(date, Math.max(a.leaveHour + 0.5, settings.closeHour)) };
  if (a.status === 'limit') return { title: `LIMIT ${a.limitHours}h – ${who}${note}`, startTime: at(date, settings.openHour), endTime: at(date, settings.openHour + 0.5) };
  return null;
}

export function cleanAvailability(input) {
  const status = STATUSES.includes(input?.status) ? input.status : 'in';
  const out = { status };
  if (status === 'leave') {
    const h = Math.round(Number(input.leaveHour) * 4) / 4;
    if (!(h > settings.openHour && h < settings.closeHour + 3)) throw new Error('Pick a leave time during the work day.');
    out.leaveHour = h;
  }
  if (status === 'limit') {
    const h = Math.round(Number(input.limitHours) * 10) / 10;
    if (!(h > 0 && h <= 16)) throw new Error('Pick a work limit between 0.1 and 16 hours.');
    out.limitHours = h;
  }
  if (input?.capacityToday != null && input.capacityToday !== '') {
    const c = Math.round(Number(input.capacityToday) * 10) / 10;
    if (!(c >= 0 && c <= 16)) throw new Error('Capacity must be between 0 and 16 hours.');
    out.capacityToday = c;
  }
  const note = String(input?.note ?? '').trim().slice(0, 60);
  if (note) out.note = note;
  return out;
}

// Saves a tech's availability for a day and keeps the Tekmetric event in step with it.
export async function saveAvailability({ client, store, shopId, date, tech, input, by }) {
  const value = cleanAvailability(input);
  const existing = (await store.getAvailability(shopId, date)).get(tech.id);
  const event = eventFor(value, tech, date);
  let eventId = existing?.eventId ?? null;
  let syncError = null;
  try {
    if (event && eventId) {
      await client.patchAppointment(eventId, { shopId, ...event, color: 'navy' });
    } else if (event) {
      const res = await client.createAppointment({ shopId, ...event, color: 'navy', description: 'Set from the Toy Doctor dispatch board' });
      eventId = res?.data ?? null;
    } else if (eventId) {
      await client.deleteAppointment(eventId);
      eventId = null;
    }
    client.clearCache();
  } catch (e) {
    syncError = 'Saved on the board, but the Tekmetric event could not be updated. It will try again next time this tech is changed.';
    console.error(`Tekmetric event for tech ${tech.id} on ${date}: ${e.message}`);
  }
  const isDefault = value.status === 'in' && value.capacityToday == null && !value.note;
  await store.setAvailability(shopId, date, tech.id, isDefault && !eventId ? null : { ...value, eventId, by, at: new Date().toISOString() });
  return { ok: true, eventId, syncError };
}
