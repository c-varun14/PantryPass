// Boot, hash router, nav and the role switcher.
//
// View contract: each file in ./views/ exports `render(container, ctx)` and may return a
// cleanup function. ctx = { session, role, params, go(hash), store, api, skewMs() }.
import { el, clear, svgIcon } from "./dom.js";
import * as auth from "./auth.js";
import * as store from "./store.js";
import { toast, openSheet, avatar } from "./ui.js";
import { icon } from "./icons.js";
import { exceptionKinds, ROLE_LABEL } from "./logic.js";
import { displayName } from "./views/welcome.js";

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

// Lucide has no "history" glyph in the vendored set, so that one keeps its hand-drawn path.
const NAV_ICON = {
  lots: () => icon("layers", 22),
  exceptions: () => icon("triangle-alert", 22),
  history: () => svgIcon("M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 7v5l3 2", 22),
  fund: () => icon("coins", 22),
};

function routeOf() {
  const h = location.hash.replace(/^#/, "") || "/";
  const parts = h.split("/").filter(Boolean);
  if (!parts.length) return { name: "lots", params: {} };
  if (parts[0] === "signin") return { name: "signin", params: { role: parts[1] } };
  if (parts[0] === "about") return { name: "about", params: {} };
  if (parts[0] === "lot" && parts[1]) return { name: "lot", params: { id: decodeURIComponent(parts[1]) } };
  if (parts[0] === "exceptions") return { name: "exceptions", params: {} };
  if (parts[0] === "history") return { name: "history", params: {} };
  if (parts[0] === "fund") return { name: "fund", params: {} };
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
  items.push(["fund", "Fund", "#/fund"]);
  const active = route.name === "lot" ? "lots" : route.name;
  for (const [key, label, href] of items) {
    const count = key === "exceptions" ? store.allLots().filter((l) => exceptionKinds(l).length).length : 0;
    nav.append(el("a", { class: "nav-item" + (active === key ? " is-active" : ""), href, "aria-current": active === key ? "page" : null },
      NAV_ICON[key](), el("span", { text: label }),
      count ? el("span", { class: "nav-badge", "aria-label": `${count} need attention`, text: String(count) }) : null));
  }
}

// Top-right account chip: who you are acting as. Tapping it opens the role menu.
function renderAccount(session) {
  const box = document.getElementById("account");
  clear(box);
  if (!session) {
    box.append(el("a", { class: "header-link", href: "#/about", text: "How it works" }));
    return;
  }
  box.append(el("button", {
    class: `account-chip role-${session.role}`, type: "button",
    "aria-label": `You are ${displayName(session.name)}, ${ROLE_LABEL[session.role]}. Open menu`,
    onclick: openAccountMenu,
  }, avatar(session.name, session.role, "s"),
  el("span", { class: "account-text" },
    el("strong", { text: displayName(session.name) }),
    el("span", { text: ROLE_LABEL[session.role] })),
  icon("chevron-down", 16)));
}

function openAccountMenu() {
  const all = auth.sessions();
  let handle = null;
  const rows = ["donor", "receiver", "coordinator"].map((role) => {
    const s = all[role];
    const person = window.PP_CONFIG.people.find((p) => p.role === role);
    const name = s ? s.name : person ? person.name : ROLE_LABEL[role];
    const active = session && session.role === role;
    return el("button", {
      class: `menu-row role-${role}` + (active ? " is-active" : ""), type: "button",
      "aria-current": active ? "true" : null,
      onclick: () => {
        handle.close();
        if (s) { auth.setActive(role); boot(); go("#/"); } else go(`#/signin/${role}`);
      },
    }, avatar(name, role),
    el("span", { class: "menu-text" }, el("strong", { text: displayName(name) }), el("span", { text: ROLE_LABEL[role] })),
    active ? el("span", { class: "menu-state", text: "Active" }) : s ? null : el("span", { class: "menu-state is-muted", text: "Sign in" }));
  });
  const links = el("div", { class: "menu-links" },
    el("a", { class: "menu-link", href: "#/about", onclick: () => handle.close(), text: "How it works" }),
    session ? el("button", { class: "menu-link", type: "button", onclick: () => {
      handle.close();
      auth.signOut(session.role);
      boot();
      go(auth.activeRole() ? "#/" : "#/signin");
    }, text: "Sign out" }) : null);
  handle = openSheet({ title: "Switch role", body: el("div", { class: "stack" }, ...rows, links) });
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
  renderAccount(session);
  await route();
}

let lastRoute = null;
let routeSeq = 0; // a newer route() call wins; older ones stop before they render over it

async function route() {
  const mySeq = ++routeSeq;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const r = routeOf();
  const view = document.getElementById("view");
  clear(view);
  // #/about is public; everything else needs a session (signed out, it lands on the welcome page).
  if (!session && r.name !== "signin" && r.name !== "about") { go("#/signin"); return; }
  if (r.name === "exceptions" && session.role !== "coordinator") { go("#/"); return; }
  renderNav(session, r);
  const mod = await import(`./views/${r.name}.js`);
  if (mySeq !== routeSeq) return;
  const ctx = {
    session, role: session ? session.role : null, params: r.params, go, store, api,
    mock: MOCK, skewMs: store.getSkewMs, signedInAs: auth.sessions(),
    afterSignIn: async () => { await boot(); go("#/"); },
  };
  let out;
  if (r.name === "lot" && wide.matches) {
    // Desktop two-pane: list on the left, the lot in the detail pane.
    const lotsMod = await import("./views/lots.js");
    if (mySeq !== routeSeq) return;
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
  // Picking another lot in the desktop two-pane keeps your place; every other navigation starts at the top.
  if (!(wide.matches && r.name === "lot" && lastRoute === "lot")) window.scrollTo(0, 0);
  lastRoute = r.name;
}

store.subscribe(() => { if (session) renderNav(session, routeOf()); });

window.addEventListener("hashchange", route);
window.addEventListener("offline", () => { document.getElementById("offline-banner").hidden = false; });
window.addEventListener("online", () => { document.getElementById("offline-banner").hidden = true; toast("Back online", "success"); store.refreshList(); });
if (!navigator.onLine) document.getElementById("offline-banner").hidden = false;

boot();
