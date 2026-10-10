// Real API client. Every method resolves to {ok, status, body, serverDate}; none throw.
// status 0 means the network failed (request never completed).
let session = null;
export function setSession(s) { session = s; }

function base() { return (window.PP_CONFIG && window.PP_CONFIG.apiUrl || "").replace(/\/$/, ""); }

async function call(method, path, payload) {
  const headers = { Accept: "application/json" };
  if (session && session.idToken) headers.Authorization = `Bearer ${session.idToken}`;
  const init = { method, headers };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  try {
    const r = await fetch(base() + path, init);
    let body = {};
    try { body = await r.json(); } catch { /* empty or non-JSON body */ }
    return { ok: r.ok, status: r.status, body, serverDate: r.headers.get("date") };
  } catch {
    return { ok: false, status: 0, body: {}, serverDate: null };
  }
}

const enc = encodeURIComponent;
const post = (id, action, b) => call("POST", `/lots/${enc(id)}/${action}`, b);

export const api = {
  listLots: () => call("GET", "/lots"),
  getLot: (id) => call("GET", `/lots/${enc(id)}`),
  createLot: (b) => call("POST", "/lots", b),
  accept: (id, b) => post(id, "accept", b),
  handoff: (id, b) => post(id, "handoff", b),
  receipt: (id, b) => post(id, "receipt", b),
  distribution: (id, b) => post(id, "distribution", b),
  disposition: (id, b) => post(id, "disposition", b),
  close: (id, b) => post(id, "close", b),
  resolveDispute: (id, b) => post(id, "resolve-dispute", b),
  retryCallbacks: (lot_id) => call("POST", "/retry-callbacks", lot_id ? { lot_id } : {}),
  verifyLot: (id) => call("GET", `/lots/${enc(id)}/verify`),
  impact: () => call("GET", "/impact"),
};
