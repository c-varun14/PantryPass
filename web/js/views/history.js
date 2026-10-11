// History: lots that are ACCOUNTED_FOR, one row each (counterpart avatar, lot, final numbers, date and status),
// grouped by month under sentence-case headers. Works for any signed-in role.
import { el, clear } from "../dom.js";
import { avatar, chip, img3d } from "../ui.js";
import { displayName } from "./welcome.js";

const FOOTNOTE = "Accounted for means every item was reported and the counts agree. It does not prove food was eaten or safe.";

function personFor(sub) {
  const people = (window.PP_CONFIG && window.PP_CONFIG.people) || [];
  return people.find((x) => x.sub === sub) || null;
}

function nameFor(sub) {
  const p = personFor(sub);
  if (p) return displayName(p.name);
  if (!sub) return "Unknown";
  return sub.length > 12 ? sub.slice(0, 8) + "…" : sub;
}

const shortId = (id) => String(id || "").slice(-6);

function dayOf(epoch) {
  if (epoch == null) return "";
  return new Date(Number(epoch) * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function monthOf(epoch) {
  if (epoch == null) return { key: "", label: "Earlier" };
  const d = new Date(Number(epoch) * 1000);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return { key, label: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
}

// The other party in the lot: a donor sees the receiver; everyone else sees the donor.
function historyRow(lot, role) {
  const otherSub = role === "donor" ? lot.receiver_sub : lot.donor_sub;
  const other = personFor(otherSub);
  const name = nameFor(otherSub);
  const numbers = `${lot.received || 0} received · ${lot.distributed || 0} given out`;
  return el("a", { class: "hist-row", href: `#/lot/${encodeURIComponent(lot.lot_id)}` },
    avatar(name, other ? other.role : null, "m"),
    el("span", { class: "hist-main" },
      el("span", { class: "hist-title", text: `Lot ${shortId(lot.lot_id)}` }),
      el("span", { class: "hist-meta", text: numbers })),
    el("span", { class: "hist-side" },
      el("span", { class: "hist-date", text: dayOf(lot.created_epoch) }),
      chip(lot)));
}

export function render(container, ctx) {
  clear(container);
  const { store } = ctx;
  const role = ctx.session ? ctx.session.role : null;
  const listBox = el("div", { class: "stack hist" });

  container.append(el("div", { class: "stack hist-page" },
    el("h1", { class: "page-title display", text: "History" }),
    listBox,
    el("p", { class: "about-note", text: FOOTNOTE })));

  function draw() {
    clear(listBox);
    if (!store.getLastUpdated()) {
      listBox.append(el("div", { class: "skeleton-card" },
        el("div", { class: "skeleton skeleton-line" }),
        el("div", { class: "skeleton skeleton-line" })));
      return;
    }
    const done = store.allLots().filter((l) => l.stage === "ACCOUNTED_FOR");
    if (!done.length) {
      listBox.append(el("div", { class: "empty-state hist-empty" },
        img3d("hourglass_not_done", 120),
        el("p", { class: "empty-title", text: "Nothing accounted for yet" })));
      return;
    }

    // Lots arrive newest first, so each month's rows are contiguous.
    const groups = [];
    for (const lot of done) {
      const m = monthOf(lot.created_epoch);
      const last = groups[groups.length - 1];
      if (last && last.key === m.key) last.lots.push(lot);
      else groups.push({ key: m.key, label: m.label, lots: [lot] });
    }
    listBox.append(el("div", { class: "card hist-list" }, groups.map((g) => el("section", { class: "hist-group" },
      el("h2", { class: "hist-month", text: g.label }),
      g.lots.map((lot) => historyRow(lot, role))))));
  }

  const unsub = store.subscribe(draw);
  draw();
  return () => unsub();
}
