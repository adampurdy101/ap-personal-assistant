// Test double for js/supabase.js: an in-memory Supabase that speaks the subset of the
// supabase-js query builder app.js uses. Seeded from window.__SEED (injected by the
// harness before the page scripts run). Every mutation is appended to window.__FAKE.log.
const OWNER = "30cbcbfa-7261-47de-8c91-3d97557fc5f9";
const seed = window.__SEED || { tasks: [], jobs: [], meetings: [] };
const tables = {
  fm_tasks: seed.tasks.map((r) => ({ ...r })),
  fm_jobs: seed.jobs.map((r) => ({ ...r })),
  fm_meetings: seed.meetings.map((r) => ({ ...r })),
  fm_moves: [],
  fm_meeting_rules: [],
};
const log = [];
let nextId = { fm_tasks: Math.max(0, ...tables.fm_tasks.map((r) => r.id)) + 1, fm_moves: 1, fm_meeting_rules: 1 };
window.__FAKE = { tables, log, nextId };

const cmp = (a, b) => (a == null && b == null ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0);

class Builder {
  constructor(table) { this.table = table; this.filters = []; this.orders = []; this.op = "select"; this.payload = null; this.cols = "*"; this.wantSingle = false; this.maybe = false; this.lim = null; this.returning = false; }
  select(cols) { if (this.op === "select") this.cols = cols || "*"; else this.returning = true; return this; }
  insert(row) { this.op = "insert"; this.payload = row; return this; }
  update(patch) { this.op = "update"; this.payload = patch; return this; }
  delete() { this.op = "delete"; return this; }
  eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
  neq(k, v) { this.filters.push((r) => r[k] !== v); return this; }
  gte(k, v) { this.filters.push((r) => cmp(r[k], v) >= 0); return this; }
  lte(k, v) { this.filters.push((r) => cmp(r[k], v) <= 0); return this; }
  lt(k, v) { this.filters.push((r) => cmp(r[k], v) < 0); return this; }
  gt(k, v) { this.filters.push((r) => cmp(r[k], v) > 0); return this; }
  in(k, arr) { this.filters.push((r) => arr.includes(r[k])); return this; }
  is(k, v) { this.filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return this; }
  or() { return this; }
  order(k, opts = {}) { this.orders.push([k, opts.ascending === false ? -1 : 1, opts.nullsFirst]); return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.wantSingle = true; return this; }
  maybeSingle() { this.wantSingle = true; this.maybe = true; return this; }
  _rows() { let rows = tables[this.table].filter((r) => this.filters.every((f) => f(r))); for (const [k, dir, nf] of this.orders.slice().reverse()) rows = rows.slice().sort((a, b) => { if (a[k] == null && b[k] != null) return nf ? -1 : 1; if (b[k] == null && a[k] != null) return nf ? 1 : -1; return cmp(a[k], b[k]) * dir; }); if (this.lim) rows = rows.slice(0, this.lim); return rows; }
  async _run() {
    const t = this.table;
    if (!tables[t]) return { data: null, error: { message: "no such table " + t } };
    if (this.op === "select") {
      const rows = this._rows().map((r) => ({ ...r }));
      if (this.wantSingle) return { data: rows[0] ?? null, error: rows.length || this.maybe ? null : { message: "no rows" } };
      return { data: rows, error: null };
    }
    if (this.op === "insert") {
      const rowsIn = Array.isArray(this.payload) ? this.payload : [this.payload];
      const out = rowsIn.map((r) => {
        const now = new Date().toISOString();
        const row = { user_id: OWNER, created_at: now, updated_at: now, ...r };
        if (t === "fm_tasks") row.id = row.id ?? nextId.fm_tasks++;
        else if (t === "fm_moves") row.id = nextId.fm_moves++;
        else row.id = row.id ?? nextId.fm_meeting_rules++;
        if (t === "fm_tasks") { row.status ??= "not_started"; row.priority ??= "normal"; row.bucket ??= "work"; row.planned ??= false; row.confirmed ??= false; row.nag_hours ??= 0; row.sort ??= 0; row.deleted_at ??= null; row.done_at ??= null; row.scheduled_date ??= null; row.size ??= null; }
        tables[t].push(row); return row;
      });
      log.push({ table: t, op: "insert", rows: out.map((r) => ({ ...r })) });
      return { data: this.wantSingle ? { ...out[0] } : out.map((r) => ({ ...r })), error: null };
    }
    if (this.op === "update") {
      const rows = this._rows();
      rows.forEach((r) => Object.assign(r, this.payload, { updated_at: new Date().toISOString() }));
      log.push({ table: t, op: "update", patch: { ...this.payload }, ids: rows.map((r) => r.id) });
      if (this.returning && this.wantSingle) return { data: rows[0] ? { ...rows[0] } : null, error: rows[0] ? null : { message: "no rows" } };
      return { data: this.returning ? rows.map((r) => ({ ...r })) : null, error: null };
    }
    if (this.op === "delete") {
      const rows = this._rows(); const ids = new Set(rows.map((r) => r.id));
      tables[t] = tables[t].filter((r) => !ids.has(r.id));
      log.push({ table: t, op: "delete", ids: [...ids] });
      return { data: null, error: null };
    }
    return { data: null, error: { message: "unsupported" } };
  }
  then(res, rej) { return this._run().then(res, rej); }
  catch(rej) { return this._run().catch(rej); }
}

const session = { access_token: "fake-jwt", user: { id: OWNER, email: "adam@example.test" } };
export const db = {
  from: (table) => new Builder(table),
  auth: {
    getSession: async () => ({ data: { session }, error: null }),
    onAuthStateChange: (cb) => { setTimeout(() => cb("SIGNED_IN", session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
    signInWithPassword: async () => ({ data: { session }, error: null }),
    signOut: async () => ({ error: null }),
  },
  channel: () => ({ on() { return this; }, subscribe(cb) { if (cb) setTimeout(() => cb("SUBSCRIBED"), 0); return this; } }),
  removeChannel: () => {},
};
