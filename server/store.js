// Scheduler-owned data that Tekmetric has no field for:
//   assignments: which tech an appointment is booked with, and its estimated hours
//   synced:      ROs whose tech the scheduler has already written, so it only happens once
// On your computer this is a JSON file (data/store.json). On Cloud Run it's Firestore,
// because Cloud Run's disk is wiped on every restart.

import fs from 'node:fs';
import path from 'node:path';

function createFileStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = { assignments: {}, synced: {}, plans: {}, techs: {}, availability: {}, meta: {} };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  const save = () => fs.writeFileSync(file, JSON.stringify(db, null, 2));
  const key = (shopId, apptId) => `${shopId}_${apptId}`;
  return {
    async getAssignments(shopId, apptIds) {
      const out = new Map();
      for (const id of apptIds) { const a = db.assignments[key(shopId, id)]; if (a) out.set(id, a); }
      return out;
    },
    async setAssignment(shopId, apptId, value) { db.assignments[key(shopId, apptId)] = { ...value, at: new Date().toISOString() }; save(); },
    async removeAssignment(shopId, apptId) { delete db.assignments[key(shopId, apptId)]; save(); },
    async getSynced(roIds) { return new Set(roIds.filter((id) => db.synced[id])); },
    // planned start times on the board (per shop, per day): { cardKey: hour }
    async getPlans(shopId, date) { return new Map(Object.entries(db.plans?.[`${shopId}_${date}`] ?? {})); },
    async setPlan(shopId, date, cardKey, hour) {
      db.plans ??= {};
      const k = `${shopId}_${date}`;
      db.plans[k] ??= {};
      if (hour == null) delete db.plans[k][cardKey]; else db.plans[k][cardKey] = hour;
      save();
    },
    async markSynced(roId, value) { db.synced[roId] = { ...value, at: new Date().toISOString() }; save(); },
    // standing settings per tech: { show, capacity }
    async getTechSettings(shopId) { return new Map(Object.entries(db.techs?.[shopId] ?? {}).map(([k, v]) => [Number(k), v])); },
    async setTechSettings(shopId, entries) { // entries: [[techId, partial settings], …]
      db.techs ??= {}; db.techs[shopId] ??= {};
      for (const [id, v] of entries) db.techs[shopId][id] = { ...(db.techs[shopId][id] ?? {}), ...v };
      save();
    },
    // one day's availability per tech: { status, leaveHour, limitHours, note, capacityToday, eventId }
    async getAvailability(shopId, date) { return new Map(Object.entries(db.availability?.[`${shopId}_${date}`] ?? {}).map(([k, v]) => [Number(k), v])); },
    async setAvailability(shopId, date, techId, value) {
      db.availability ??= {};
      const k = `${shopId}_${date}`;
      db.availability[k] ??= {};
      if (value == null) delete db.availability[k][techId]; else db.availability[k][techId] = value;
      save();
    },
    // small settings and notes kept by the board (learned colors, "still coming" no-shows): merged on save
    async getMeta(id) { return db.meta?.[id] ?? null; },
    async setMeta(id, value) { db.meta ??= {}; db.meta[id] = { ...(db.meta[id] ?? {}), ...value }; save(); },
  };
}

async function createFirestoreStore() {
  const { Firestore, FieldValue } = await import('@google-cloud/firestore');
  // FIRESTORE_DATABASE: the database ID created in Google Cloud (e.g. "dispatch"); omit for "(default)"
  const fsdb = new Firestore(process.env.FIRESTORE_DATABASE ? { databaseId: process.env.FIRESTORE_DATABASE } : {});
  const A = fsdb.collection('assignments');
  const S = fsdb.collection('synced');
  const P = fsdb.collection('plans');
  const T = fsdb.collection('techSettings');
  const V = fsdb.collection('availability');
  const M = fsdb.collection('meta');
  const key = (shopId, apptId) => `${shopId}_${apptId}`;
  return {
    async getAssignments(shopId, apptIds) {
      const out = new Map();
      if (!apptIds.length) return out;
      const snaps = await fsdb.getAll(...apptIds.map((id) => A.doc(key(shopId, id))));
      snaps.forEach((s, i) => { if (s.exists) out.set(apptIds[i], s.data()); });
      return out;
    },
    async setAssignment(shopId, apptId, value) { await A.doc(key(shopId, apptId)).set({ ...value, at: new Date().toISOString() }); },
    async removeAssignment(shopId, apptId) { await A.doc(key(shopId, apptId)).delete(); },
    async getSynced(roIds) {
      if (!roIds.length) return new Set();
      const snaps = await fsdb.getAll(...roIds.map((id) => S.doc(String(id))));
      return new Set(roIds.filter((id, i) => snaps[i].exists));
    },
    async markSynced(roId, value) { await S.doc(String(roId)).set({ ...value, at: new Date().toISOString() }); },
    async getPlans(shopId, date) {
      const snap = await P.doc(`${shopId}_${date}`).get();
      return new Map(Object.entries(snap.exists ? snap.data() : {}));
    },
    async setPlan(shopId, date, cardKey, hour) {
      await P.doc(`${shopId}_${date}`).set({ [cardKey]: hour == null ? FieldValue.delete() : hour }, { merge: true });
    },
    async getTechSettings(shopId) {
      const snap = await T.doc(String(shopId)).get();
      return new Map(Object.entries(snap.exists ? snap.data() : {}).map(([k, v]) => [Number(k), v]));
    },
    async setTechSettings(shopId, entries) {
      const cur = Object.fromEntries(await this.getTechSettings(shopId));
      const patch = {};
      for (const [id, v] of entries) patch[id] = { ...(cur[id] ?? {}), ...v };
      await T.doc(String(shopId)).set(patch, { merge: true });
    },
    async getAvailability(shopId, date) {
      const snap = await V.doc(`${shopId}_${date}`).get();
      return new Map(Object.entries(snap.exists ? snap.data() : {}).map(([k, v]) => [Number(k), v]));
    },
    async setAvailability(shopId, date, techId, value) {
      await V.doc(`${shopId}_${date}`).set({ [techId]: value == null ? FieldValue.delete() : value }, { merge: true });
    },
    async getMeta(id) { const s = await M.doc(id).get(); return s.exists ? s.data() : null; },
    async setMeta(id, value) { await M.doc(id).set(value, { merge: true }); },
  };
}

export async function createStore({ useFirestore, file }) {
  return useFirestore ? createFirestoreStore() : createFileStore(file);
}
