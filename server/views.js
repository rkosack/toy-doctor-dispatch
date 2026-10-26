// Week and Month views: a booking planner. For each day: appointments, waiters, and booked hours
// against the shop's tech capacity that day (standing capacity, adjusted for Out / Leaves early / Limit).

import { settings } from './config.js';
import { addDays, localDate, localHours, weekday, zonedTime } from './time.js';
import { colorCategory, dropHour, isWaiter, personName, vehicleText } from './board.js';
import { availableHours } from './availability.js';

const TZ = settings.timeZone;
const round1 = (n) => Math.round(n * 10) / 10;
const live = (a) => !a.deletedDate && a.customerId && !['CANCELED', 'CANCELLED', 'NO_SHOW'].includes(a.appointmentStatus);

// sold hours on an RO (or estimated hours if nothing is sold yet)
function roHours(ro) {
  const jobs = (ro.jobs ?? []).filter((j) => !j.archived);
  const sold = jobs.filter((j) => j.authorized !== false);
  return round1((sold.length ? sold : jobs).reduce((t, j) => t + (Number(j.laborHours) || 0), 0));
}

async function gather(client, store, shopId, first, last, withNames) {
  const start = zonedTime(first, 0, 0, TZ).toISOString();
  const end = new Date(zonedTime(addDays(last, 1), 0, 0, TZ).getTime() - 1000).toISOString();
  const [employees, appts, open, recent, techSettings] = await Promise.all([
    client.getEmployees(shopId),
    client.getAppointments(shopId, start, end),
    Promise.all([1, 2].map((st) => client.getRepairOrders(shopId, { repairOrderStatusId: String(st) }))).then((a) => a.flat()),
    client.getRepairOrders(shopId, { updatedDateStart: start }),
    store.getTechSettings(shopId),
  ]);
  const days = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  const avail = new Map(await Promise.all(days.map(async (d) => [d, await store.getAvailability(shopId, d)])));
  const roByAppt = new Map();
  for (const ro of [...open, ...recent]) if (ro.appointmentId && !ro.deletedDate) roByAppt.set(ro.appointmentId, ro);
  const liveAppts = appts.filter(live);
  const assignments = await store.getAssignments(shopId, liveAppts.map((a) => a.id));
  const techs = employees.filter((e) => e.canPerformWork && !e.disabled && techSettings.get(e.id)?.show !== false);
  const empById = new Map(employees.map((e) => [e.id, e]));

  let namesPending = 0; let name = () => ({ customer: '', vehicle: '' });
  if (withNames) {
    const missC = []; const missV = [];
    for (const a of liveAppts) { if (!client.peekCustomer(a.customerId)) missC.push(a.customerId); if (a.vehicleId && !client.peekVehicle(a.vehicleId)) missV.push(a.vehicleId); }
    if (missC.length || missV.length) client.warmNames([...new Set(missC)], [...new Set(missV)]);
    namesPending = missC.length + missV.length;
    name = (a) => { const c = client.peekCustomer(a.customerId); return { customer: c ? c.lastName || c.firstName || 'Customer' : 'Loading name…', vehicle: vehicleText(client.peekVehicle(a.vehicleId)) || 'vehicle…' }; };
  }

  const out = days.map((d) => {
    const closed = !settings.workDays.includes(weekday(d));
    const capacity = closed ? 0 : round1(techs.reduce((t, e) => t + availableHours(techSettings.get(e.id)?.capacity ?? settings.defaultCapacityHours, avail.get(d).get(e.id)), 0));
    const out = techs.filter((e) => avail.get(d).get(e.id)?.status === 'out').map(personName);
    const list = liveAppts.filter((a) => localDate(new Date(a.startTime), TZ) === d).sort((x, y) => x.startTime.localeCompare(y.startTime)).map((a) => {
      const ro = roByAppt.get(a.id); const as = assignments.get(a.id);
      const techId = ro?.technicianId ?? as?.techId ?? null;
      return {
        key: `appt-${a.id}`, appointmentId: a.id, startTime: a.startTime, startHour: localHours(new Date(a.startTime), TZ), dropHour: dropHour(a, d),
        category: colorCategory(a.color), waiter: isWaiter(a), arrived: a.arrived === true || a.appointmentStatus === 'ARRIVED',
        roNumber: ro?.repairOrderNumber ?? null, hours: ro ? roHours(ro) : as?.hours ?? 1, hoursEstimated: !ro,
        tech: techId ? personName(empById.get(techId)) : null, work: a.description || a.title || '', ...name(a),
      };
    });
    const hours = round1(list.reduce((t, a) => t + a.hours, 0));
    return { date: d, closed, count: list.length, waiters: list.filter((a) => a.waiter).length, hours, capacity, out, appts: list };
  });
  for (const d of out) {
    d.ratio = d.capacity ? d.hours / d.capacity : d.hours ? 2 : 0;
    d.status = d.closed ? 'closed' : d.ratio > 1 ? 'over' : d.ratio >= settings.nearFullRatio ? 'near' : 'open';
    d.heavy = d.status === 'near' || d.status === 'over'; // by booked hours vs capacity, not appointment count
  }
  return { days: out, namesPending };
}

export async function buildWeek(client, { shopId, date, store }) {
  const mon = addDays(date, -((weekday(date) + 6) % 7));
  const { days, namesPending } = await gather(client, store, shopId, mon, addDays(mon, 5), true);
  return { shopId, date, start: mon, days, namesPending, totals: totals(days) };
}

export async function buildMonth(client, { shopId, date, store }) {
  const firstOfMonth = `${date.slice(0, 7)}-01`;
  const next = addDays(`${date.slice(0, 7)}-28`, 4).slice(0, 7);
  const lastOfMonth = addDays(`${next}-01`, -1);
  const first = addDays(firstOfMonth, -((weekday(firstOfMonth) + 6) % 7)); // Monday on or before the 1st
  const last = addDays(lastOfMonth, (7 - weekday(lastOfMonth)) % 7); // Sunday on or after the last day
  const { days } = await gather(client, store, shopId, first, last, false);
  for (const d of days) { d.inMonth = d.date.slice(0, 7) === date.slice(0, 7); delete d.appts; }
  return { shopId, date, month: date.slice(0, 7), first, last, days, totals: totals(days.filter((d) => d.inMonth)) };
}

const totals = (days) => ({
  appointments: days.reduce((t, d) => t + d.count, 0), waiters: days.reduce((t, d) => t + d.waiters, 0),
  hours: round1(days.reduce((t, d) => t + d.hours, 0)), capacity: round1(days.reduce((t, d) => t + d.capacity, 0)),
});
