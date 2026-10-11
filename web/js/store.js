// Lot cache, polling and the "known ids" fallback used until GET /lots exists on the live API.
import { skewFromDate } from "./logic.js";

let api = null;
let session = null;
let skewMs = 0;
let listSupported = null; // null = unknown, true/false after the first probe
const lots = new Map();       // lot_id -> lot
const offers = new Map();     // receivers only: open offers they may claim (kept out of `lots`), lot_id -> lot
const eventsBy = new Map();   // lot_id -> events[]
const subs = new Set();
let timer = null;
let lastUpdated = 0;

export function configure(apiImpl, sess) {
  api = apiImpl;
  session = sess;
  lots.clear();
  offers.clear();
  eventsBy.clear();
  listSupported = null;
  lastUpdated = 0;
  emit();
}

export const getSkewMs = () => skewMs;
export const getLastUpdated = () => lastUpdated;
export const allLots = () => [...lots.values()].sort((a, b) => (b.created_epoch || 0) - (a.created_epoch || 0));
export const lotById = (id) => lots.get(id) || offers.get(id) || null;
// Open offers waiting to be claimed, newest first. Only the receiver's Open offers list reads this.
export const openOffersList = () => [...offers.values()]
  .filter((l) => l.stage === "OFFERED" && l.open_offer === true)
  .sort((a, b) => (b.created_epoch || 0) - (a.created_epoch || 0));
export const eventsOf = (id) => eventsBy.get(id) || [];

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
const isReceiver = () => !!session && session.role === "receiver";

// A receiver's unclaimed lot lives in `offers`, so it never shows up among their own lots.
function place(lot) {
  if (isReceiver() && lot.open_offer === true && !lot.receiver_sub) {
    offers.set(lot.lot_id, lot);
    lots.delete(lot.lot_id);
  } else {
    lots.set(lot.lot_id, lot);
    offers.delete(lot.lot_id);
  }
}

// Receivers: replace the open offers still waiting. Entries that are no longer listed are dropped only while
// they still read OFFERED, so a lot the page is showing does not vanish between polls.
async function refreshOffers() {
  if (!api || !isReceiver()) return;
  const r = await api.openOffers();
  noteDate(r);
  if (!r.ok || !r.body || !Array.isArray(r.body.lots)) return;
  const fresh = new Map(r.body.lots.map((l) => [l.lot_id, l]));
  for (const [id, l] of [...offers]) if (!fresh.has(id) && l.stage === "OFFERED") offers.delete(id);
  for (const [id, l] of fresh) offers.set(id, l);
}
function emit() { subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

function noteDate(res) {
  if (res.serverDate) skewMs = skewFromDate(res.serverDate);
}

// ---- known ids fallback (per signed-in sub) ----
const idsKey = () => `pp.ids.${session && session.sub}`;
function knownIds() {
  try { return JSON.parse(localStorage.getItem(idsKey()) || "[]"); } catch { return []; }
}
export function rememberId(id) {
  const ids = new Set(knownIds());
  ids.add(id);
  try { localStorage.setItem(idsKey(), JSON.stringify([...ids])); } catch { /* ignore */ }
}

// Returns {ok, status}. Updates the cache and notifies subscribers.
export async function refreshList() {
  if (!api) return { ok: false, status: 0 };
  if (listSupported !== false) {
    const r = await api.listLots();
    noteDate(r);
    if (r.ok && Array.isArray(r.body.lots)) {
      listSupported = true;
      const seen = new Set();
      for (const l of r.body.lots) { lots.set(l.lot_id, l); seen.add(l.lot_id); offers.delete(l.lot_id); }
      for (const id of [...lots.keys()]) if (!seen.has(id)) lots.delete(id);
      await refreshOffers();
      lastUpdated = Date.now();
      emit();
      return { ok: true, status: 200 };
    }
    if (r.status === 0) return { ok: false, status: 0 };
    if (r.status === 404 || r.status === 403) listSupported = false; // route not live yet
    else return { ok: false, status: r.status, body: r.body };
  }
  // fallback: fetch each remembered lot
  const results = await Promise.all(knownIds().map((id) => api.getLot(id)));
  let offline = false;
  results.forEach((r) => {
    noteDate(r);
    if (r.status === 0) offline = true;
    else if (r.ok && r.body.lot) { place(r.body.lot); eventsBy.set(r.body.lot.lot_id, r.body.events || []); }
  });
  if (!offline) { lastUpdated = Date.now(); emit(); }
  return { ok: !offline, status: offline ? 0 : 200 };
}

export async function refreshLot(id) {
  const r = await api.getLot(id);
  noteDate(r);
  if (r.ok && r.body.lot) {
    place(r.body.lot);
    eventsBy.set(id, r.body.events || []);
    lastUpdated = Date.now();
    rememberId(id);
    emit();
  }
  return r;
}

// Apply a mutating response: refresh the lot afterwards so numbers come from the server.
export async function mutate(fnName, id, body) {
  const r = await api[fnName](id, body);
  noteDate(r);
  if (id) await refreshLot(id);
  return r;
}

export async function create(body) {
  const r = await api.createLot(body);
  noteDate(r);
  if (r.ok && r.body.lot) {
    rememberId(r.body.lot.lot_id);
    place(r.body.lot);
    emit();
  }
  return r;
}

// Poll every 5s while visible. `extra` runs each tick (e.g. refresh the open lot).
export function startPolling(extra) {
  stopPolling();
  const tick = async () => {
    if (document.hidden) return;
    await refreshList();
    if (extra) await extra();
  };
  timer = setInterval(tick, 5000);
  document.addEventListener("visibilitychange", onVis);
  function onVis() { if (!document.hidden) tick(); }
  startPolling._onVis = onVis;
}
export function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
  if (startPolling._onVis) document.removeEventListener("visibilitychange", startPolling._onVis);
}
