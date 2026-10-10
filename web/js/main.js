// Boot, hash router, nav and the role switcher.
//
// View contract: each file in ./views/ exports `render(container, ctx)` and may return a
// cleanup function. ctx = { session, role, params, go(hash), store, api, skewMs() }.
import { el, clear, svgIcon } from "./dom.js";
import * as auth from "./auth.js";
import * as store from "./store.js";
import { toast } from "./ui.js";
import { exceptionKinds } from "./logic.js";

const MOCK = new URLSearchParams(location.search).has("mock");
if (!window.PP_CONFIG) {
  window.PP_CONFIG = { apiUrl: "", region: "ap-south-1", clientId: "", people: [
    { name: "Asha (donor)", username: "donor1", role: "donor", sub: "sub-donor" },
    { name: "Ravi (receiver)", username: "receiver1", role: "receiver", sub: "sub-receiver" },
    { name: "Meera (coordinator)", username: "coordinator1", role: "coordinator", sub: "sub-coordinator" },
  ] };
}
let api;
let cleanup = null;
const wide = window.matchMedia("(min-width: 960px)");
wide.addEventListener("change", () => { if (routeOf().name === "lot") route(); });

const ICONS = {
  lots: "M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4",
  exceptions: "M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  history: "M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 7v5l3 2",
};

const ROLE_LABEL = { donor: "Donor", receiver: "Receiver", coordinator: "Coordinator" };

function routeOf() {
  const h = location.hash.replace(/^#/, "") || "/";
  const parts = h.split("/").filter(Boolean);
  if (!parts.length) return { name: "lots", params: {} };
  if (parts[0] === "signin") return { name: "signin", params: { role: parts[1] } };
  if (parts[0] === "lot" && parts[1]) return { name: "lot", params: { id: decodeURIComponent(parts[1]) } };
  if (parts[0] === "exceptions") return { name: "exceptions", params: {} };
  if (parts[0] === "history") return { name: "history", params: {} };
  return { name: "lots", params: {} };
}

export const go = (hash) => { location.hash = hash; };

function renderNav(session, route) {
  const nav = document.getElementById("nav");
  clear(nav);
  if (!session) return;
  const items = [["lots", "Lots", "#/"]];
  if (session.role === "coordinator") items.push(["exceptions", "Exceptions", "#/exceptions"]);
  items.push(["history", "History", "#/history"]);
  const active = route.name === "lot" ? "lots" : route.name;
  for (const [key, label, href] of items) {
    const count = key === "exceptions" ? store.allLots().filter((l) => exceptionKinds(l).length).length : 0;
    nav.append(el("a", { class: "nav-item" + (active === key ? " is-active" : ""), href, "aria-current": active === key ? "page" : null },
      svgIcon(ICONS[key], 22), el("span", { text: label }),
      count ? el("span", { class: "nav-badge", "aria-label": `${count} need attention`, text: String(count) }) : null));
  }
}

function renderSwitcher(session) {
  const box = document.getElementById("role-switcher");
  clear(box);
  const all = auth.sessions();
  for (const role of ["donor", "receiver", "coordinator"]) {
    const s = all[role];
    const isActive = session && session.role === role;
    box.append(el("button", {
      class: "role-pill" + (isActive ? " is-active" : ""),
      type: "button",
      "aria-pressed": String(!!isActive),
      title: s ? `Switch to ${s.name}` : `Sign in as ${ROLE_LABEL[role]}`,
      onclick: () => {
        if (s) { auth.setActive(role); boot(); go("#/"); }
        else go(`#/signin/${role}`);
      },
    }, ROLE_LABEL[role]));
  }
  if (session) {
    box.append(el("button", { class: "role-pill", type: "button", "aria-label": `Sign out ${session.name}`, onclick: () => {
      auth.signOut(session.role);
      boot();
      go(auth.activeRole() ? "#/" : "#/signin");
    } }, "Sign out"));
  }
}

let session = null;

async function boot() {
  const asRole = MOCK && new URLSearchParams(location.search).get("as");
  if (asRole && !auth.sessions()[asRole]) {
    const person = window.PP_CONFIG.people.find((x) => x.role === asRole);
    if (person) auth.mockSignIn(person);
  }
  session = MOCK ? (auth.sessions()[auth.activeRole()] || null) : await auth.currentSession();
  store.stopPolling();
  if (session) {
    api = MOCK ? (await import("./mock.js")).api : (await import("./api.js")).api;
    const m = MOCK ? await import("./mock.js") : await import("./api.js");
    m.setSession(session);
    store.configure(api, session);
    store.refreshList();
    store.startPolling();
  }
  renderSwitcher(session);
  await route();
}

async function route() {
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const r = routeOf();
  const view = document.getElementById("view");
  clear(view);
  if (!session && r.name !== "signin") { go("#/signin"); return; }
  if (r.name === "exceptions" && session.role !== "coordinator") { go("#/"); return; }
  renderNav(session, r);
  const mod = await import(`./views/${r.name}.js`);
  const ctx = {
    session, role: session ? session.role : null, params: r.params, go, store, api,
    mock: MOCK, skewMs: store.getSkewMs, signedInAs: auth.sessions(),
    afterSignIn: async () => { await boot(); go("#/"); },
  };
  let out;
  if (r.name === "lot" && wide.matches) {
    // Desktop two-pane: list on the left, the lot in the detail pane.
    const lotsMod = await import("./views/lots.js");
    const outList = await lotsMod.render(view, { ...ctx, params: {}, selectedId: r.params.id });
    const pane = view.querySelector(".split-detail");
    let outLot;
    if (pane) { clear(pane); outLot = await mod.render(pane, ctx); }
    out = () => { [outList, outLot].forEach((f) => typeof f === "function" && f()); };
  } else {
    out = await mod.render(view, ctx);
  }
  if (typeof out === "function") cleanup = out;
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

store.subscribe(() => { if (session) renderNav(session, routeOf()); });

window.addEventListener("hashchange", route);
window.addEventListener("offline", () => { document.getElementById("offline-banner").hidden = false; });
window.addEventListener("online", () => { document.getElementById("offline-banner").hidden = true; toast("Back online", "success"); store.refreshList(); });
if (!navigator.onLine) document.getElementById("offline-banner").hidden = false;

boot();
