// Coordinator-only Exceptions screen: lots that need a person to decide the next step.
// main.js already redirects non-coordinators away from #/exceptions.
import { el, clear, svgIcon } from "../dom.js";
import { toast } from "../ui.js";
import { exceptionKinds, friendlyError, whatNext, plainStage, stageFamily, splitRecent } from "../logic.js";

const SUBTITLE = "Things that need a person. Nothing here is assumed to have happened.";
const CHECK_ICON = "M20 6L9 17l-5-5";
const ALL_KEY = "__all__";
const KEEP = 5; // newest items shown per group; the rest sit behind "Show N older"

const SECTIONS = [
  { kind: "unanswered", title: "Nobody answered" },
  { kind: "dispute", title: "Counts don't match" },
  { kind: "callback", title: "Needs a retry" },
];

// What happened, and what to do, for each group. The "what to do" sentence comes from whatNext
// for the two stage-driven groups; a callback is not a stage, so it has its own sentence.
const HAPPENED = {
  unanswered: () => "Nobody accepted before the deadline. Nothing is assumed delivered.",
  dispute: (lot) => `Donor said ${lot.donor_handoff ?? "an unknown count"}, receiver counted ${lot.received ?? "an unknown count"}.`,
  callback: () => "The receiver's reply didn't reach the system.",
};
const NEXT = {
  unanswered: (lot) => whatNext(lot, "coordinator"),
  dispute: (lot) => whatNext(lot, "coordinator"),
  callback: () => "Retry the callback.",
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
  const expanded = new Set(); // kinds whose older items are revealed; survives re-renders
  let focusKind = null; // a "Show older" toggle that was just pressed, refocused after redraw
  const wrap = el("div", { class: "stack exc-page" });
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
    return el("button", {
      class: "btn btn-secondary" + (isBusy ? " is-loading" : ""),
      type: "button",
      disabled: isBusy ? true : null,
      "aria-busy": isBusy ? "true" : null,
      onclick: () => retry(lotId),
    }, lotId ? (isBusy ? "Retrying…" : "Retry callback") : (isBusy ? "Retrying…" : "Retry all callbacks"));
  }

  function item(lot, kind) {
    const href = `#/lot/${encodeURIComponent(lot.lot_id)}`;
    const actions = [];
    if (kind === "dispute") {
      actions.push(el("button", {
        class: "btn btn-primary",
        type: "button",
        onclick: () => ctx.go(href),
      }, "Settle the count"));
    }
    if (kind === "callback") actions.push(retryButton(lot.lot_id));

    // Card is a plain container: only the title is a link, so the buttons are never nested in an <a>.
    return el("article", { class: "card exc-item" },
      el("div", { class: "card-head" },
        el("a", { class: "card-title", href, text: `Lot ${String(lot.lot_id).slice(-6)}` }),
        el("span", { class: `chip chip-${stageFamily(lot)}` },
          el("span", { class: "chip-dot", "aria-hidden": "true" }), plainStage(lot))),
      el("div", { class: "card-meta", text: `${personName(lot.donor_sub)} to ${personName(lot.receiver_sub)}` }),
      el("p", { class: "exc-happened", text: HAPPENED[kind](lot) }),
      el("p", { class: "exc-next" }, el("strong", { text: "Next: " }), NEXT[kind](lot)),
      actions.length ? el("div", { class: "row" }, actions) : null);
  }

  // One group: the newest KEEP items, then a collapsed "Show N older" toggle for the rest.
  function group({ kind, title }, lots) {
    const { recent, older } = splitRecent(lots, KEEP);
    const open = expanded.has(kind);
    const id = `exc-${kind}`;
    const listId = `exc-list-${kind}`;
    const toggle = older.length
      ? el("button", {
        class: "btn btn-ghost show-older",
        type: "button",
        dataset: { kind },
        "aria-expanded": open ? "true" : "false",
        "aria-controls": listId,
        onclick: () => {
          if (expanded.has(kind)) expanded.delete(kind); else expanded.add(kind);
          focusKind = kind;
          draw();
        },
      }, open ? `Hide ${older.length} older` : `Show ${older.length} older`)
      : null;
    return el("section", { class: "stack exc-group", "aria-labelledby": id },
      el("h2", { class: "section-title", id, text: `${title} (${lots.length})` }),
      el("div", { class: "stack", id: listId },
        recent.map((lot) => item(lot, kind)),
        open ? older.map((lot) => item(lot, kind)) : null),
      toggle);
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
        el("p", { class: "empty-text", text: "Nothing is waiting on you." })));
    } else {
      for (const section of SECTIONS) {
        const lots = g[section.kind];
        if (lots.length) wrap.append(group(section, lots));
      }
    }

    if (focusKind) {
      const btn = wrap.querySelector(`.show-older[data-kind="${focusKind}"]`);
      if (btn) btn.focus();
      focusKind = null;
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
