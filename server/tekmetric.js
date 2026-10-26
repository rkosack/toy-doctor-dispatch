// Tekmetric API client: token, paging, short cache, and backoff on rate limits.

const BASES = { sandbox: 'https://sandbox.tekmetric.com', production: 'https://shop.tekmetric.com' };
const CACHE_MS = 60_000;
// Stay under Tekmetric's rate limits (sandbox 300/min, production 600/min) by spacing requests.
const GAP_MS = { sandbox: 230, production: 115 };

export function createTekmetricClient({ clientId, clientSecret, environment = 'sandbox' }) {
  const base = BASES[environment] ?? BASES.sandbox;
  let token = null;
  const cache = new Map();
  const gap = GAP_MS[environment] ?? GAP_MS.sandbox;
  let nextAt = 0;
  const pace = async () => {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };

  async function getToken() {
    if (token) return token;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(`${base}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`Tekmetric token request failed (${res.status})`);
    token = (await res.json()).access_token;
    return token;
  }

  async function request(method, path, body, attempt = 0) {
    await pace();
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${await getToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      console.warn(`Tekmetric rate limit hit; waiting before retrying (${path.split('?')[0]})`);
      await new Promise((r) => setTimeout(r, Math.min(2 ** (attempt + 1) * 1000 + Math.random() * 1000, 60_000)));
      return request(method, path, body, attempt + 1);
    }
    if (res.status === 401 && attempt === 0) { token = null; return request(method, path, body, 1); }
    const text = await res.text();
    if (!res.ok) throw new Error(`Tekmetric ${method} ${path.split('?')[0]} failed (${res.status}): ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  async function get(path, ttl = CACHE_MS) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    const data = await request('GET', path);
    cache.set(path, { at: Date.now(), data });
    return data;
  }

  // Follows Tekmetric's page/size paging until the last page.
  async function getAll(path, params = {}) {
    const out = [];
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ ...params, size: '100', page: String(page) });
      const data = await get(`${path}?${qs}`);
      const content = Array.isArray(data) ? data : data?.content ?? [];
      out.push(...content);
      if (Array.isArray(data) || data?.last !== false || content.length === 0) break;
    }
    return out;
  }

  // Customer and vehicle names: the board never waits on these. Whatever isn't cached yet
  // is fetched in the background, and shows up on the next refresh.
  // One name at a time, so board requests never queue behind a long list of names.
  const queued = new Set();
  const queue = [];
  let working = false;
  const peek = (path) => cache.get(path)?.data;
  async function work() {
    if (working) return;
    working = true;
    while (queue.length) {
      const p = queue.shift();
      await get(p, 3_600_000).catch(() => {});
      queued.delete(p);
    }
    working = false;
  }
  function warm(paths) {
    for (const p of paths) if (!queued.has(p) && !cache.has(p)) { queued.add(p); queue.push(p); }
    work();
  }

  return {
    peekCustomer: (id) => peek(`/api/v1/customers/${id}`),
    peekVehicle: (id) => peek(`/api/v1/vehicles/${id}`),
    warmNames: (custIds, vehIds) => warm([...custIds.map((id) => `/api/v1/customers/${id}`), ...vehIds.map((id) => `/api/v1/vehicles/${id}`)]),
    getShops: () => get('/api/v1/shops'),
    getEmployees: (shop) => getAll('/api/v1/employees', { shop }),
    getAppointments: (shop, startIso, endIso) =>
      getAll('/api/v1/appointments', { shop, start: startIso, end: endIso, includeDeleted: 'false' }),
    // statusIds: 1 Estimate, 2 WIP, 3 Complete, 4 Saved, 5 Posted, 6 A/R
    getRepairOrders: (shop, params = {}) => getAll('/api/v1/repair-orders', { shop, ...params }),
    // Names change rarely, so these are cached for an hour.
    getCustomer: (id) => get(`/api/v1/customers/${id}`, 3_600_000),
    getVehicle: (id) => get(`/api/v1/vehicles/${id}`, 3_600_000),
    // booking form: never cached, so new customers and vehicles show up right away
    searchCustomers: async (shop, search) => {
      const data = await request('GET', `/api/v1/customers?${new URLSearchParams({ shop, search, size: '25' })}`);
      return Array.isArray(data) ? data : data?.content ?? [];
    },
    getVehicles: async (shop, customerId) => {
      const data = await request('GET', `/api/v1/vehicles?${new URLSearchParams({ shop, customerId, size: '50' })}`);
      return Array.isArray(data) ? data : data?.content ?? [];
    },
    // One appointment, fresh from Tekmetric. Falls back to that day's list if the single read isn't available.
    getAppointment: async (id, shop, startIso) => {
      try {
        const data = await request('GET', `/api/v1/appointments/${id}`);
        const a = data?.data && typeof data.data === 'object' ? data.data : data;
        if (a?.id) return a;
      } catch (e) { if (!startIso) throw e; }
      const day = new Date(startIso).getTime();
      const qs = new URLSearchParams({ shop, start: new Date(day - 864e5).toISOString(), end: new Date(day + 864e5).toISOString(), size: '100' });
      const data = await request('GET', `/api/v1/appointments?${qs}`);
      return (data?.content ?? []).find((a) => a.id === Number(id)) ?? null;
    },
    patchRepairOrder: (id, body) => request('PATCH', `/api/v1/repair-orders/${id}`, body),
    patchJob: (id, body) => request('PATCH', `/api/v1/jobs/${id}`, body),
    createAppointment: (body) => request('POST', '/api/v1/appointments', body),
    patchAppointment: (id, body) => request('PATCH', `/api/v1/appointments/${id}`, body),
    deleteAppointment: (id) => request('DELETE', `/api/v1/appointments/${id}`),
    // after a change: drop cached board data, keep customer and vehicle names
    clearCache: () => { for (const k of cache.keys()) if (!/^\/api\/v1\/(customers|vehicles)\/\d+$/.test(k)) cache.delete(k); },
  };
}
