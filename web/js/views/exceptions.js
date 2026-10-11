// Coordinator-only Exceptions screen: lots that need a person to decide the next step.
// main.js already redirects non-coordinators away from #/exceptions.
import { el, clear } from "../dom.js";
import { toast, img3d } from "../ui.js";
import { icon } from "../icons.js";
import { exceptionKinds, friendlyError, splitRecent } from "../logic.js";

const ALL_KEY = "__all__";
const KEEP = 5; // newest items shown per group; the rest sit behind "Show N older"

const SECTIONS = [
  { kind: "unanswered", title: "Nobody answered" },
  { kind: "dispute", title: "Counts don't match" },
  { kind: "callback", title: "Needs a retry" },
];

// Badge per kind: a Lucide icon in a soft circle (red for a count mismatch, amber for waiting).
const BADGE = {
  unanswered: { icon: "clock", cls: "exc-badge-wait" },
  dispute: { icon: "scale", cls: "exc-badge-alert" },
  callback: { icon: "refresh-cw", cls: "exc-badge-wait" },
};

// One muted line per card: what happened.
const HAPPENED = {
  unanswered: (lot) => (lot.receiver_sub ? "Nobody answered in time. Nothing is assumed delivered." : "Nobody claimed it in time. Nothing is assumed delivered."),
  dispute: (lot) => `Donor said ${lot.donor_handoff ?? "an unknown count"}, receiver counted ${lot.received ?? "an unknown count"}.`,
  callback: () => "The receiver's reply didn't reach the system.",
};

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

    // Row is a plain container: only the title is a link, so the buttons are never nested in an <a>.
    return el("article", { class: "exc-item" },
      el("span", { class: `exc-badge ${BADGE[kind].cls}`, "aria-hidden": "true" }, icon(BADGE[kind].icon, 20)),
      el("div", { class: "exc-main" },
        el("a", { class: "exc-title", href, text: `Lot ${String(lot.lot_id).slice(-6)}` }),
        el("p", { class: "exc-meta", text: HAPPENED[kind](lot) })),
      actions.length ? el("div", { class: "exc-actions" }, actions) : null);
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
      el("h2", { class: "pg-h2", id, text: `${title} (${lots.length})` }),
      el("div", { class: "exc-list", id: listId },
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

    wrap.append(el("div", { class: "row exc-head" },
      el("h1", { class: "page-title display" },
        "Exceptions",
        loaded ? el("span", { class: "exc-count display-num", text: String(total) }) : null),
      anyCallbacks ? retryButton(null) : null));

    statusEl = el("p", { class: "live-status visually-hidden", "aria-live": "polite" });
    wrap.append(statusEl);
    updateStatus();

    if (!loaded) {
      wrap.append(...skeletons());
    } else if (total === 0) {
      wrap.append(el("div", { class: "empty-state exc-empty" },
        img3d("check_mark_button", 120),
        el("p", { class: "empty-title", text: "Nothing needs you" })));
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
