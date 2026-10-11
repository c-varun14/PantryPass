// History: lots that are ACCOUNTED_FOR, with their final totals.
import { el, clear } from "../dom.js";
import { chip } from "../ui.js";

const FOOTNOTE = "Accounted for means the receiver reported every item and no counts disagree. It does not prove food was eaten or safe.";

function personName(sub) {
  const p = ((window.PP_CONFIG && window.PP_CONFIG.people) || []).find((x) => x.sub === sub);
  if (p) return p.name;
  if (!sub) return "Unknown";
  return sub.length > 12 ? sub.slice(0, 8) + "…" : sub;
}

const shortId = (id) => String(id || "").slice(-6);

function dateOf(epoch) {
  if (epoch == null) return "";
  return new Date(Number(epoch) * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function bigItem(n, caption) {
  return el("div", { class: "qty-big-item" },
    el("span", { class: "qty-num", text: String(n || 0) }),
    el("span", { class: "qty-cap", text: caption }));
}

function historyCard(lot) {
  const closed = dateOf(lot.created_epoch);
  return el("a", { class: "card card-link", href: `#/lot/${encodeURIComponent(lot.lot_id)}` },
    el("div", { class: "card-head" },
      el("span", { class: "card-title", text: `Lot ${shortId(lot.lot_id)}` }),
      chip(lot)),
    el("div", { class: "card-meta", text: `${personName(lot.donor_sub)} → ${personName(lot.receiver_sub)}${closed ? " · Closed " + closed : ""}` }),
    el("div", { class: "qty-big" },
      bigItem(lot.received, "Received"),
      bigItem(lot.distributed, "Given out"),
      bigItem(lot.returned, "Returned"),
      bigItem(lot.disposed, "Thrown away")));
}

export function render(container, ctx) {
  clear(container);
  const { store } = ctx;
  const listBox = el("div", { class: "stack" });

  container.append(el("div", { class: "stack" },
    el("header", { class: "stack" },
      el("h1", { class: "page-title", text: "History" }),
      el("p", { class: "page-sub", text: "Lots that are accounted for: every item reported, and the counts agree." })),
    listBox,
    el("p", { class: "card-meta", text: FOOTNOTE })));

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
      listBox.append(el("div", { class: "empty-state" },
        el("p", { class: "empty-title", text: "Nothing accounted for yet" }),
        el("p", { class: "empty-text", text: "A lot lands here once the receiver has reported every item and the counts agree." })));
      return;
    }
    listBox.append(...done.map(historyCard));
  }

  const unsub = store.subscribe(draw);
  draw();
  return () => unsub();
}
