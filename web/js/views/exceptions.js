// Coordinator-only Exceptions screen: lots that need a person to decide the next step.
// main.js already redirects non-coordinators away from #/exceptions.
import { el, clear, svgIcon } from "../dom.js";
import { chip, toast } from "../ui.js";
import { exceptionKinds, friendlyError } from "../logic.js";

const SUBTITLE = "Things that need a person. Nothing here is assumed to have happened.";
const EMPTY_TEXT = "Unanswered pickups and count disputes will show up here.";
const CHECK_ICON = "M20 6L9 17l-5-5";
const ALL_KEY = "__all__";

const SECTIONS = [
  { kind: "unanswered", title: "Unanswered pickup" },
  { kind: "dispute", title: "Count dispute" },
  { kind: "callback", title: "Callback stuck" },
];

const COPY = {
  unanswered: () => ({
    happened: "Nobody accepted before the deadline. No distribution or disposal is assumed.",
    next: "Call the receiver or reassign the lot.",
  }),
  dispute: (lot) => ({
    happened: `Donor declared ${lot.donor_handoff ?? "an unknown count"} but receiver reported ${lot.received ?? "an unknown count"}.`,
    next: "Confirm the real count with both, then resolve the dispute.",
  }),
  callback: () => ({
    happened: "The workflow did not get the receiver's reply.",
    next: "Retry the callback.",
  }),
};

// Turn a sub into a name via the configured directory; fall back to a shortened sub.
function personName(sub) {
  const people = (window.PP_CONFIG && window.PP_CONFIG.people) || [];
  const p = people.find((x) => x.sub === sub);
  if (p) return p.name;
  return sub ? `${String(sub).slice(0, 8)}…` : "Unknown";
}

export async function render(container, ctx) {
  let alive = true;
  let statusEl = null;
  const busy = new Set(); // retry keys in flight; survives re-renders within this view
  const wrap = el("div", { class: "stack" });
  container.append(wrap);

  function groups() {
    const out = { unanswered: [], dispute: [], callback: [] };
    for (const lot of ctx.store.allLots()) {
      for (const k of exceptionKinds(lot)) out[k].push(lot);
    }
    return out;
  }

  function updateStatus() {
    if (!statusEl) return;
    const t = ctx.store.getLastUpdated();
    if (!t) { statusEl.textContent = "Loading lots…"; return; }
    const secs = Math.floor((Date.now() - t) / 1000);
    statusEl.textContent = secs < 10 ? "Updated just now" : `Updated ${secs}s ago`;
  }

  async function retry(lotId) {
    const key = lotId || ALL_KEY;
    if (busy.has(key)) return;
    busy.add(key);
    draw();
    const r = lotId ? await ctx.api.retryCallbacks(lotId) : await ctx.api.retryCallbacks();
    busy.delete(key);
    if (!alive) return;
    if (r.ok) {
      const msg = r.body && typeof r.body.message === "string" ? r.body.message : "Lots will update when the reply arrives.";
      toast(`${lotId ? "Callback retried" : "Callbacks retried"}. ${msg}`, "success");
    } else {
      const f = friendlyError(r.status, r.body || {});
      toast(`${f.title}. ${f.detail}`, "error");
    }
    await ctx.store.refreshList();
    draw();
  }

  function retryButton(lotId) {
    const key = lotId || ALL_KEY;
    const isBusy = busy.has(key);
    const btn = el("button", {
      class: "btn btn-secondary" + (isBusy ? " is-loading" : ""),
      type: "button",
      disabled: isBusy ? true : null,
      "aria-busy": isBusy ? "true" : null,
      onclick: () => retry(lotId),
    }, lotId ? (isBusy ? "Retrying…" : "Retry callback") : (isBusy ? "Retrying…" : "Retry all callbacks"));
    return btn;
  }

  function item(lot, kind) {
    const copy = COPY[kind](lot);
    const href = `#/lot/${encodeURIComponent(lot.lot_id)}`;
    const actions = [];
    if (kind === "dispute") {
      actions.push(el("button", {
        class: "btn btn-primary",
        type: "button",
        onclick: () => ctx.go(href),
      }, "Resolve dispute"));
    }
    if (kind === "callback") actions.push(retryButton(lot.lot_id));

    // Card is a plain container: only the title is a link, so the buttons are never nested in an <a>.
    return el("article", { class: "card" },
      el("div", { class: "card-head" },
        el("a", { class: "card-title", href, text: `Lot ${String(lot.lot_id).slice(-6)}` }),
        chip(lot)),
      el("div", { class: "card-meta", text: `${personName(lot.donor_sub)} to ${personName(lot.receiver_sub)}` }),
      el("p", {}, el("strong", { text: "What happened: " }), copy.happened),
      el("p", {}, el("strong", { text: "Safe next step: " }), copy.next),
      actions.length ? el("div", { class: "row" }, actions) : null);
  }

  function skeletons() {
    return [0, 1, 2].map(() => el("div", { class: "skeleton skeleton-card", "aria-hidden": "true" },
      el("div", { class: "skeleton-line" }), el("div", { class: "skeleton-line" })));
  }

  function draw() {
    if (!alive) return;
    clear(wrap);
    const loaded = ctx.store.getLastUpdated() !== 0;
    const g = loaded ? groups() : null;
    const total = g ? g.unanswered.length + g.dispute.length + g.callback.length : 0;
    const anyCallbacks = !!(g && g.callback.length);

    wrap.append(el("div", { class: "row" },
      el("div", { class: "stack" },
        el("h1", { class: "page-title", text: "Exceptions" }),
        el("p", { class: "page-sub", text: SUBTITLE })),
      anyCallbacks ? retryButton(null) : null));

    statusEl = el("p", { class: "live-status" });
    wrap.append(statusEl);
    updateStatus();

    if (!loaded) {
      wrap.append(...skeletons());
    } else if (total === 0) {
      wrap.append(el("div", { class: "empty-state" },
        el("div", { class: "empty-icon", "aria-hidden": "true" }, svgIcon(CHECK_ICON, 32)),
        el("p", { class: "empty-title", text: "All clear" }),
        el("p", { class: "empty-text", text: EMPTY_TEXT })));
    } else {
      for (const { kind, title } of SECTIONS) {
        const lots = g[kind];
        const id = `exc-${kind}`;
        wrap.append(el("section", { class: "stack", "aria-labelledby": id },
          el("h2", { class: "section-title", id, text: `${title} (${lots.length})` }),
          lots.length
            ? el("div", { class: "stack" }, lots.map((lot) => item(lot, kind)))
            : el("p", { class: "page-sub", text: "None right now." })));
      }
    }
  }

  draw();
  const timer = setInterval(updateStatus, 1000);
  const unsub = ctx.store.subscribe(draw);

  return () => {
    alive = false;
    clearInterval(timer);
    unsub();
  };
}
