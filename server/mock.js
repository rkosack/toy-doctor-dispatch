// Demo mode: a fake Tekmetric with the same response shapes the sandbox returned,
// so the board can be previewed without credentials. Data is generated the same way
// every run for a given day.

import { settings } from './config.js';
import { addDays, localDate, weekday, zonedTime } from './time.js';

const TZ = settings.timeZone;

function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

const SHOPS = [
  { id: 101, name: 'Toy Doctor Denver', nickname: 'Denver', address: { city: 'Denver', state: 'CO' }, roCustomLabelEnabled: true },
  { id: 102, name: 'Toy Doctor Littleton', nickname: 'Littleton', address: { city: 'Littleton', state: 'CO' }, roCustomLabelEnabled: true },
];
const STAFF = {
  101: { techs: ['Marcus Reyes', 'Jordan Tate', 'Tyler Brooks', 'Andre Moss', 'Sam Kline', 'Luis Pena'], advisors: ['Erin Walsh', 'Chris Dunn'] },
  102: { techs: ['Nate Ortiz', 'Kyle Bauer', 'Devin Shaw', 'Ray Lindqvist', 'Omar Haddad'], advisors: ['Paige Rowe', 'Ben Cole'] },
};
const LAST = ['Nguyen', 'Brooks', 'Allen', 'Kim', 'Lopez', 'Walsh', 'Garcia', 'Reed', 'Ortiz', 'Chen', 'Davis', 'Murphy', 'Foster', 'Ito', 'Young', 'Patel', 'Hernandez', 'Price', 'Bennett', 'Sato', 'Morales', 'Hughes', 'Fischer', 'Ramos', 'Coleman', 'Tanaka', 'Novak', 'Grant', 'Shah', 'Lindgren'];
const FIRST = ['Ana', 'Ben', 'Carla', 'Dan', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivan', 'June', 'Kurt', 'Lena', 'Mo', 'Nia', 'Owen', 'Pam'];
const CARS = [['Toyota', '4Runner'], ['Toyota', 'Tundra'], ['Toyota', 'Camry'], ['Toyota', 'RAV4'], ['Toyota', 'Tacoma'], ['Toyota', 'Sienna'], ['Toyota', 'Highlander'], ['Toyota', 'Prius'], ['Toyota', 'Corolla'], ['Toyota', 'Land Cruiser'], ['Lexus', 'RX 350'], ['Lexus', 'ES 350'], ['Lexus', 'GX 460'], ['Scion', 'tC'], ['Toyota', 'Avalon']];

// Tekmetric's appointment palette, as hex
const COLORS = { red: '#D50000', yellow: '#F6BF26', blue: '#039BE5', green: '#33B679', purple: '#8E24AA', navy: '#0D4A80' };
const NAMED = { red: '#D50000', pink: '#E67C73', yellow: '#F6BF26', orange: '#F4511E', 'light green': '#7CB342', green: '#33B679', blue: '#039BE5', navy: '#0D4A80', lavender: '#7986CB', purple: '#8E24AA' };
// what Tekmetric does with an appointment write: color names become hex, "status" becomes appointmentStatus
const fromBody = ({ color, status, ...rest }) => ({ ...rest, ...(color ? { color: NAMED[color] ?? color } : {}), ...(status ? { appointmentStatus: status } : {}) });
const WORK = {
  red: [['Trans shudder diag', 3], ['No-start diag + repair', 4], ['Head gasket', 5], ['Timing belt + water pump', 4.5]],
  yellow: [['Check engine light', 1], ['Hybrid warning light', 1], ['Front-end noise', 1], ['ABS light', 1.5]],
  blue: [['60k service', 2], ['30k service', 1.6], ['Oil + rotate', 1], ['Brake fluid + coolant', 1.8]],
  green: [['Oil + rotate', 1], ['Rotate + inspect', 1.2], ['Oil + brake check', 1]],
  purple: [['Front brakes', 2], ['Air suspension', 2.5], ['Struts + alignment', 3]],
};
const LABELS = {
  notStarted: { id: 12, code: 'WORKNOTSTRTD', name: 'Waiting On Diag/ Insp' },
  inProgress: { id: 13, code: 'INPROGRESS', name: 'Work In Progress 50%' },
  balanceDue: { id: 31, code: 'BALANCEDUE', name: 'Balance Due' },
};
const CUSTOM = ['Parts Here WIP 0%', 'Onsite- Parts Hold', 'Off Site-Parts Ordered', 'Pending Authorization'];
const STATUS = { 2: 'WORKINPROGRESS', 3: 'COMPLETE', 5: 'POSTED' };

let customers = new Map(); let vehicles = new Map(); let employees = {};
const pools = new Map(); // shop -> { appts, ros } generated for the window around "today"
const patches = { ro: new Map(), job: new Map(), appt: new Map() };
const events = new Map();

// Demo clock: on a weekday during shop hours it's the real time; otherwise the next
// workday at 10:15 am, so the demo always shows a day in progress.
export function demoNow() {
  if (process.env.DEMO_NOW) return new Date(process.env.DEMO_NOW); // for testing a specific moment
  const real = new Date();
  let d = localDate(real, TZ);
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit' }).format(real));
  if (settings.workDays.includes(weekday(d)) && h >= settings.openHour && h < settings.closeHour) return real;
  if (settings.workDays.includes(weekday(d)) && h >= settings.closeHour) d = addDays(d, 1);
  while (!settings.workDays.includes(weekday(d))) d = addDays(d, 1);
  return zonedTime(d, 10, 15, TZ);
}

function people(shop) {
  if (employees[shop]) return employees[shop];
  let id = shop * 1000;
  const mk = (full, techy) => { const [firstName, lastName] = full.split(' '); return { id: ++id, firstName, lastName, email: `${firstName.toLowerCase()}@toydoctorinc.com`, employeeRole: { id: techy ? 3 : 2, code: techy ? '3' : '2', name: techy ? 'Technician' : 'Service Advisor' }, canPerformWork: techy, disabled: false }; };
  employees[shop] = [...STAFF[shop].techs.map((n) => mk(n, true)), ...STAFF[shop].advisors.map((n) => mk(n, false))];
  return employees[shop];
}

function generate(shop) {
  const nowDate = demoNow();
  const today = localDate(nowDate, TZ);
  const key = `${shop}:${today}:${Math.floor(nowDate.getTime() / 900_000)}`;
  if (pools.get(shop)?.key === key) return pools.get(shop);
  const staff = people(shop);
  const techs = staff.filter((e) => e.canPerformWork);
  const advisors = staff.filter((e) => !e.canPerformWork);
  const now = nowDate.getTime();
  const appts = []; const ros = [];
  let apptId = shop * 100000; let roId = shop * 100000; let roNum = 48000 + (shop - 101) * 5000; let jobId = shop * 1000000;

  for (let d = addDays(today, -25); d <= addDays(today, 30); d = addDays(d, 1)) {
    if (!settings.workDays.includes(weekday(d))) continue;
    const r = rng(`${shop}-${d}`);
    const count = (shop === 101 ? 16 : 13) + Math.floor(r() * 7);
    let noShowLeft = d === today;
    for (let i = 0; i < count; i++) {
      const cat = pick(r, ['red', 'yellow', 'yellow', 'blue', 'blue', 'blue', 'green', 'green', 'purple']);
      const [work, hours] = pick(r, WORK[cat]);
      const [make, model] = pick(r, CARS);
      const custId = shop * 10000 + Math.floor(r() * 400);
      const vehId = custId * 10;
      // draw every value even when the customer already exists, so the day's sequence never shifts
      const first = pick(r, FIRST), last = pick(r, LAST), year = 2005 + Math.floor(r() * 18);
      if (!customers.has(custId)) customers.set(custId, { id: custId, firstName: first, lastName: last, email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, phone: [{ number: `303-555-${String(custId % 10000).padStart(4, '0')}`, type: 'Mobile', primary: true }] });
      if (!vehicles.has(vehId)) vehicles.set(vehId, { id: vehId, customerId: custId, year, make, model });
      const slot = Math.floor(r() * 15); // 8:00 … 15:00 in half hours
      const start = zonedTime(d, 8 + Math.floor(slot / 2), (slot % 2) * 30, TZ);
      const end = new Date(start.getTime() + 3600_000);
      const appt = { id: shop * 100000 + (Math.round(Date.parse(d) / 864e5) % 900) * 100 + i, shopId: shop, customerId: custId, vehicleId: vehId, startTime: start.toISOString().replace('.000', ''), endTime: end.toISOString().replace('.000', ''), title: `${customers.get(custId).lastName} – ${model}`, description: work, color: COLORS[cat], arrived: null, appointmentStatus: 'NONE', dropoffTime: cat !== 'green' && i % 2 === 0 ? new Date(start.getTime() - 3600_000).toISOString() : null, appointmentOption: cat === 'green' ? { id: 1, code: 'STAY', name: 'Stay With Vehicle' } : { id: 2, code: 'DROP', name: 'Drop-off Vehicle' }, deletedDate: null, _hours: hours, _work: work };
      appts.push(appt);
      const r2 = rng(`${shop}-${d}-${i}-ro`); // separate stream so the day's appointments never change with the clock

      // Has the customer arrived? Past days: yes. Today: if start is past (one no-show left on purpose).
      const isPast = d < today;
      let arrived = isPast || (d === today && start.getTime() < now);
      if (arrived && noShowLeft && !isPast && start.getTime() < now - 3600_000) { arrived = false; noShowLeft = false; }
      // Written up the night before: about half of today's and tomorrow's booked customers
      // already have an RO open (no tech yet) before they arrive.
      const writtenUpEarly = r2() < 0.5; // always drawn, so the same appointments are pre-written at any hour
      const preOpen = !arrived && writtenUpEarly && (d === today || d === addDays(today, 1));
      if (!arrived && !preOpen) continue;
      if (arrived) { appt.arrived = true; appt.appointmentStatus = 'ARRIVED'; }

      const lead = pick(r2, techs);
      const multi = r2() < 0.2;
      const jobs = [{ name: work, hours, tech: lead }];
      if (multi) jobs.push({ name: pick(r2, ['Starter replace', 'Alignment', 'Battery + terminals']), hours: 1.2, tech: pick(r2, techs.filter((t) => t !== lead)) });
      const created = preOpen ? zonedTime(addDays(d, -1), 17, 30, TZ).toISOString() : start.toISOString();
      const daysAgo = Math.round((Date.parse(today) - Date.parse(d)) / 864e5);
      let status = 5; let label = LABELS.balanceDue; let custom = null; let completed = null;
      if (preOpen) { status = 2; label = LABELS.notStarted; custom = null; }
      else if (isPast && daysAgo <= 3 && r2() < 0.35) { status = 2; label = LABELS.inProgress; custom = pick(r2, ['Onsite- Parts Hold', 'Off Site-Parts Ordered', 'Parts Here WIP 0%', 'Parts Here WIP 0%', 'Parts Here WIP 0%']); }
      else if (isPast) { completed = new Date(start.getTime() + (hours + 1) * 3600_000).toISOString(); }
      else {
        const roll = r2();
        if (roll < 0.2) { status = 3; label = LABELS.balanceDue; completed = new Date(Math.min(now, start.getTime() + (hours + 0.5) * 3600_000)).toISOString(); }
        else if (roll < 0.55) { status = 2; label = LABELS.inProgress; custom = 'Parts Here WIP 0%'; }
        else if (roll < 0.75) { status = 2; label = LABELS.inProgress; custom = null; }
        else if (roll < 0.88) { status = 2; label = LABELS.notStarted; custom = 'Pending Authorization'; }
        else { status = 2; label = LABELS.inProgress; custom = 'Onsite- Parts Hold'; }
      }
      const noTechYet = preOpen || (d === today && r2() < 0.4);
      const promise = zonedTime(status === 2 && isPast && r2() < 0.5 ? today : d, 17, 0, TZ).toISOString();
      const id = appt.id + 5_000_000; // one RO per appointment, same id every time it's generated
      ros.push({
        id, repairOrderNumber: roNum + (appt.id % 100000), shopId: shop,
        repairOrderStatus: { id: status, code: STATUS[status], name: STATUS[status] },
        repairOrderLabel: { ...label, status: { id: status, code: STATUS[status] } },
        repairOrderCustomLabel: custom ? { name: custom } : null,
        appointmentId: appt.id, customerId: custId, vehicleId: vehId,
        technicianId: noTechYet ? null : lead.id, serviceWriterId: pick(r2, advisors).id,
        completedDate: completed, postedDate: status === 5 ? completed : null,
        customerTimeOut: promise, createdDate: created, updatedDate: completed ?? (preOpen ? created : new Date(Math.min(now, start.getTime() + 1800_000)).toISOString()), deletedDate: null,
        jobs: jobs.map((j, k) => ({ id: id * 10 + k, repairOrderId: id, name: j.name, authorized: true, selected: true, technicianId: noTechYet ? null : j.tech.id, laborHours: j.hours, completedDate: completed, labor: [{ hours: j.hours, technicianId: j.tech.id }] })),
      });
    }
  }
  // re-apply changes made through the API (patches survive regeneration)
  for (const a of appts) if (patches.appt.has(a.id)) Object.assign(a, patches.appt.get(a.id));
  for (const ro of ros) {
    if (patches.ro.has(ro.id)) Object.assign(ro, patches.ro.get(ro.id));
    for (const j of ro.jobs) if (patches.job.has(j.id)) Object.assign(j, patches.job.get(j.id));
  }
  const pool = { key, appts, ros };
  pools.set(shop, pool);
  return pool;
}

const strip = ({ _hours, _work, ...a }) => a;

export function createMockClient() {
  return {
    getShops: async () => SHOPS,
    getEmployees: async (shop) => people(Number(shop)),
    getAppointments: async (shop, startIso, endIso) => {
      const { appts } = generate(Number(shop));
      return [...appts, ...[...events.values()].filter((e) => e.shopId === Number(shop))].filter((a) => a.startTime >= startIso.replace('.000', '') && a.startTime <= endIso.replace('.000', '')).map(strip);
    },
    getRepairOrders: async (shop, params = {}) => {
      const { ros } = generate(Number(shop));
      const statuses = params.repairOrderStatusId ? String(params.repairOrderStatusId).split(',').map(Number) : null;
      return ros.filter((ro) => (!statuses || statuses.includes(ro.repairOrderStatus.id)) && (!params.updatedDateStart || ro.updatedDate >= params.updatedDateStart));
    },
    peekCustomer: (id) => customers.get(Number(id)),
    peekVehicle: (id) => vehicles.get(Number(id)),
    warmNames: () => {},
    getCustomer: async (id) => customers.get(Number(id)) ?? { id, firstName: '', lastName: 'Customer' },
    getVehicle: async (id) => vehicles.get(Number(id)) ?? { id, year: null, make: '', model: 'Vehicle' },
    patchRepairOrder: async (id, body) => {
      patches.ro.set(Number(id), { ...(patches.ro.get(Number(id)) ?? {}), ...body });
      for (const p of pools.values()) for (const ro of p.ros) if (ro.id === Number(id)) Object.assign(ro, body);
      return { type: 'SUCCESS', message: 'Repair Order Saved', data: {} };
    },
    patchJob: async (id, body) => {
      patches.job.set(Number(id), { ...(patches.job.get(Number(id)) ?? {}), ...body });
      for (const p of pools.values()) for (const ro of p.ros) for (const j of ro.jobs) if (j.id === Number(id)) Object.assign(j, body);
      return { type: 'SUCCESS' };
    },
    patchLog: () => ({ ro: [...patches.ro], job: [...patches.job], events: [...events.values()] }),
    // appointments and custom events created through the API
    createAppointment: async (body) => { const id = 9_000_000 + events.size + 1 + Math.floor(Math.random() * 1000) * 1000; events.set(id, { id, customerId: null, vehicleId: null, appointmentStatus: 'NONE', deletedDate: null, color: NAMED.navy, ...fromBody(body), shopId: body.shopId }); return { type: 'SUCCESS', message: 'Appointment Saved', data: id }; },
    patchAppointment: async (id, body) => {
      id = Number(id);
      if (events.has(id)) { Object.assign(events.get(id), fromBody(body)); return { type: 'SUCCESS', data: id }; }
      const a = [...pools.values()].flatMap((p) => p.appts).find((x) => x.id === id);
      if (!a) throw new Error('Tekmetric PATCH /api/v1/appointments failed (404)');
      const change = fromBody(body);
      patches.appt.set(id, { ...(patches.appt.get(id) ?? {}), ...change });
      for (const p of pools.values()) for (const x of p.appts) if (x.id === id) Object.assign(x, change);
      return { type: 'SUCCESS', data: id };
    },
    getAppointment: async (id) => { id = Number(id); const a = events.get(id) ?? [...pools.values()].flatMap((p) => p.appts).find((x) => x.id === id); return a ? strip({ ...a }) : null; },
    deleteAppointment: async (id) => { if (!events.delete(Number(id))) throw new Error('404'); return { type: 'SUCCESS', data: id }; },
    searchCustomers: async (shop, q) => { generate(Number(shop)); const t = String(q).toLowerCase().replace(/\D/g, '') || null; const s = String(q).toLowerCase(); return [...customers.values()].filter((c) => Math.floor(c.id / 10000) === Number(shop) && (`${c.firstName} ${c.lastName}`.toLowerCase().includes(s) || (t && c.phone[0].number.replace(/\D/g, '').includes(t)))).slice(0, 25); },
    getVehicles: async (shop, customerId) => [...vehicles.values()].filter((v) => v.customerId === Number(customerId)),
    clearCache: () => {},
  };
}
