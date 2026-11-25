// A stand-in for the store's database with the same promises EmDash's plugin storage makes: filtered
// (with ranges), ordered, paged queries and a write that only lands when nobody wrote in between.
function matches(data, where = {}) {
  return Object.entries(where).every(([key, want]) => {
    const value = data[key];
    if (want !== null && typeof want === "object") {
      if ("in" in want) return want.in.includes(value);
      if (value === undefined) return false;
      return (want.gt === undefined || value > want.gt) && (want.gte === undefined || value >= want.gte) &&
        (want.lt === undefined || value < want.lt) && (want.lte === undefined || value <= want.lte);
    }
    return value === want;
  });
}

function collection() {
  const rows = new Map();
  let clock = 0;
  const api = {
    rows,
    async get(id) { return rows.get(id)?.data ?? null; },
    async put(id, data) { rows.set(id, { data: structuredClone(data), revision: String(++clock) }); },
    async delete(id) { return rows.delete(id); },
    async deleteMany(ids) { let gone = 0; for (const id of ids) if (rows.delete(id)) gone++; return gone; },
    async count(where) { return [...rows.values()].filter(row => matches(row.data, where)).length; },
    async query({ where, orderBy, limit = 50, cursor } = {}) {
      let all = [...rows.entries()].filter(([, row]) => matches(row.data, where));
      const [[field, direction] = []] = Object.entries(orderBy ?? {});
      if (field) all.sort(([, a], [, b]) => String(a.data[field]).localeCompare(String(b.data[field])) * (direction === "desc" ? -1 : 1));
      const start = cursor ? Number(cursor) : 0;
      const items = all.slice(start, start + limit).map(([id, row]) => ({ id, data: structuredClone(row.data) }));
      const hasMore = start + limit < all.length;
      return { items, hasMore, ...(hasMore ? { cursor: String(start + limit) } : {}) };
    },
    async getVersioned(id) { const row = rows.get(id); return row ? { value: structuredClone(row.data), revision: row.revision } : null; },
    async compareAndSet(id, expected, data) {
      if ((rows.get(id)?.revision ?? null) !== expected) return { applied: false };
      rows.set(id, { data: structuredClone(data), revision: String(++clock) });
      return { applied: true };
    },
    async compareAndDelete(id, expected) {
      if (rows.get(id)?.revision !== expected) return { applied: false };
      return { applied: rows.delete(id) };
    },
  };
  return api;
}

export function store() {
  const kv = new Map();
  let turn = 0;
  const tasks = new Map();
  return {
    site: { name: "Camp Store", url: "https://store.example.test", locale: "en" },
    url: path => `https://store.example.test${path}`,
    log: { warn() {}, info() {}, error() {}, debug() {} },
    tasks,
    cron: {
      async schedule(name, opts) { tasks.set(name, opts.schedule); },
      async cancel(name) { tasks.delete(name); },
      async list() { return [...tasks].map(([name, schedule]) => ({ name, schedule, nextRunAt: "", lastRunAt: null })); },
    },
    storage: { coupons: collection(), holds: collection(), uses: collection(), guesses: collection() },
    kv: {
      async get(key) { return kv.get(key)?.value ?? null; },
      async set(key, value) { kv.set(key, { value, revision: String(++turn) }); },
      async delete(key) { return kv.delete(key); },
      async getVersioned(key) { return kv.get(key) ?? null; },
      async compareAndSet(key, expected, value) {
        if ((kv.get(key)?.revision ?? null) !== expected) return { applied: false };
        kv.set(key, { value, revision: String(++turn) });
        return { applied: true };
      },
    },
  };
}

export const owner = (input, role = 50, surface = "admin-page") => ({
  input, ui: { surface, locale: "en", direction: "ltr" },
  user: { id: "u1", email: "owner@example.test", name: "Owner", role, createdAt: "" },
  request: { url: "", method: "POST", headers: {} },
});

/** The store's own server code calling a private door, with nobody signed in. */
export const storeCode = input => ({ input, request: { url: "", method: "POST", headers: {} } });
export const courier = input => storeCode({ courier: 1, ...input });

/** Checkout lines as the store's code sends them: Commerce's order, prices in whole cents. */
export const lines = () => [
  { item: "boots", product: "boots", price: "8000", quantity: 1, categories: ["footwear"] },
  { item: "mug", product: "mug", price: "1500", quantity: 2, categories: ["kitchen"] },
  { item: "socks-m", product: "socks", price: "1000", quantity: 3, sale: true, categories: ["footwear"] },
];
