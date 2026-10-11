// Lots home: role greeting, the lot list split into "Needs you" and "Everything else".
import { el, clear, svgIcon } from "../dom.js";
import { chip, qtyBar, button, openSheet, numStepper, toast, setLoading } from "../ui.js";
import { nextAction, secondsLeft, formatCountdown, friendlyError, validateQty } from "../logic.js";

const ROLE_LABEL = { donor: "Donor", receiver: "Receiver", coordinator: "Coordinator" };
const PLACEHOLDER_PATH = "M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4";

function personName(sub) {
  const p = ((window.PP_CONFIG && window.PP_CONFIG.people) || []).find((x) => x.sub === sub);
  if (p) return p.name;
  if (!sub) return "Unknown";
  return sub.length > 12 ? sub.slice(0, 8) + "…" : sub;
}

const shortId = (id) => String(id || "").slice(-6);

function paintCountdown(node, epoch, skewMs) {
  const sec = secondsLeft(Number(epoch), skewMs);
  if (sec == null) return;
  if (sec <= 0) {
    node.textContent = "Response overdue";
    node.classList.add("is-late");
  } else {
    node.textContent = `Receiver has ${formatCountdown(sec)} to respond`;
    node.classList.remove("is-late");
  }
}

function skeletons(n) {
  return Array.from({ length: n }, () => el("div", { class: "skeleton-card" },
    el("div", { class: "skeleton skeleton-line" }),
    el("div", { class: "skeleton skeleton-line" })));
}

function denyNode(f) {
  return el("div", { class: "deny-panel", role: "alert" },
    el("strong", { text: f.title }),
    el("div", { class: "deny-detail", text: f.detail }));
}

const IMPACT_ROWS = [
  ["lots", "Lots"],
  ["offered", "Packets offered"],
  ["received", "Packets received"],
  ["distributed", "Packets distributed"],
  ["returned", "Packets returned"],
  ["disposed", "Packets disposed"],
  ["accounted_for", "Lots accounted for"],
  ["disputes_caught", "Disputes caught"],
  ["exceptions_raised", "Exceptions raised"],
  ["confirmed_in_person", "Confirmed in person"],
];

// Coordinator only. Loaded once per visit: GET /impact scans the tables, so it is not polled.
function impactCard(api) {
  const body = el("div", { class: "stack" }, el("p", { class: "card-meta", text: "Loading impact…" }));
  const card = el("section", { class: "card impact-card stack", "aria-labelledby": "impact-title" },
    el("h2", { class: "section-title", id: "impact-title", text: "Impact" }),
    body);
  api.impact().then((r) => {
    if (!card.isConnected) return;
    clear(body);
    if (!r.ok) {
      body.append(el("p", { class: "card-meta", text: "Impact is not available right now." }));
      return;
    }
    body.append(
      el("div", { class: "qty-big impact-grid" }, IMPACT_ROWS.map(([key, label]) =>
        el("div", { class: "qty-big-item" },
          el("span", { class: "qty-num", text: String(r.body[key] ?? 0) }),
          el("span", { class: "qty-cap", text: label })))),
      el("p", { class: "field-hint", text: "Counts of packets as reported by the people involved. Not meals, kilograms or avoided waste." }));
  });
  return card;
}

export function render(container, ctx) {
  clear(container);
  const { session, role, store } = ctx;
  const isDonor = role === "donor";
  const listBox = el("div", { class: "stack" });
  const liveLine = el("p", { class: "live-status" });

  let sheetHandle = null;

  function openNewLot() {
    const receivers = ((window.PP_CONFIG && window.PP_CONFIG.people) || []).filter((p) => p.role === "receiver");
    const errSlot = el("div", { class: "stack" });
    let busy = false;

    const select = el("select", { class: "select", id: "new-lot-receiver" },
      receivers.length
        ? receivers.map((p) => el("option", { value: p.sub, text: p.name }))
        : el("option", { value: "", text: "No receivers in the directory" }));

    const stepper = numStepper({ value: 10, min: 1, max: 500, label: "Quantity offered", onChange: () => {} });
    const submitBtn = button("Offer lot", {
      variant: "primary",
      block: true,
      disabled: receivers.length === 0,
      onClick: submit,
    });

    async function submit() {
      if (busy) return;
      clear(errSlot);
      const receiver_sub = select.value;
      const offered = stepper.getValue();
      if (!receiver_sub) { errSlot.append(denyNode({ title: "Pick a receiver", detail: "Choose who this lot is for." })); return; }
      const msg = validateQty("offered", offered);
      if (msg) { stepper.setError(msg); return; }

      busy = true;
      setLoading(submitBtn, true);
      let r;
      try {
        r = await store.create({ receiver_sub, offered });
      } finally {
        busy = false;
        setLoading(submitBtn, false);
      }
      if (r.ok) {
        if (sheetHandle) sheetHandle.close();
        toast("Lot offered. The receiver can now accept it.", "success");
        const id = r.body && r.body.lot && r.body.lot.lot_id;
        ctx.go(id ? `#/lot/${encodeURIComponent(id)}` : "#/");
        return;
      }
      const f = friendlyError(r.status, r.body);
      clear(errSlot);
      errSlot.append(denyNode(f));
      toast(f.title, "error");
      if (r.status === 409) store.refreshList();
    }

    const body = el("div", { class: "stack" },
      errSlot,
      el("div", { class: "field" },
        el("label", { class: "field-label", for: "new-lot-receiver", text: "Receiver" }),
        select),
      el("div", { class: "field" },
        el("span", { class: "field-label", text: "Quantity offered" }),
        stepper.el),
      el("p", { class: "field-hint", text: "The pickup response window and cutoff are set by the server." }));

    sheetHandle = openSheet({
      title: "New lot",
      body,
      footer: el("div", { class: "sheet-foot" }, submitBtn),
      onClose: () => { sheetHandle = null; },
    });
  }

  const header = el("header", { class: "row page-head" },
    el("div", { class: "stack" },
      el("h1", { class: "page-title", text: `Hi, ${session.name}` }),
      el("p", { class: "page-sub", text: ROLE_LABEL[role] || "" })),
    isDonor ? button("New lot", { variant: "primary", onClick: openNewLot }) : null);

  const root = el("div", { class: "stack" },
    header,
    role === "coordinator" ? impactCard(ctx.api) : null,
    liveLine,
    el("div", { class: "split" },
      el("div", { class: "split-list" }, listBox),
      el("div", { class: "split-detail" },
        el("div", { class: "empty-state" },
          el("div", { class: "empty-icon" }, svgIcon(PLACEHOLDER_PATH, 32)),
          el("p", { class: "empty-title", text: "Pick a lot" }),
          el("p", { class: "empty-text", text: "Select a lot to see its stages, numbers and who has reported what." })))));
  container.append(root);

  function lotCard(lot) {
    const next = nextAction(lot, role, true);
    const foot = [next.kind === "act"
      ? el("strong", { text: next.label })
      : el("span", { text: next.label })];
    if (lot.stage === "OFFERED" && lot.response_deadline_epoch != null) {
      const cd = el("span", { class: "countdown", dataset: { epoch: String(lot.response_deadline_epoch) } });
      paintCountdown(cd, lot.response_deadline_epoch, ctx.skewMs());
      foot.push(cd);
    }
    const selected = ctx.selectedId === lot.lot_id;
    return el("a", { class: "card card-link" + (selected ? " is-selected" : ""), "aria-current": selected ? "true" : null, href: `#/lot/${encodeURIComponent(lot.lot_id)}` },
      el("div", { class: "card-head" },
        el("span", { class: "card-title", text: `Lot ${shortId(lot.lot_id)}` }),
        chip(lot)),
      el("div", { class: "card-meta", text: `${personName(lot.donor_sub)} → ${personName(lot.receiver_sub)}` }),
      qtyBar(lot),
      el("div", { class: "lot-card-foot" }, foot));
  }

  function section(title, lots, emptyText) {
    return el("section", { class: "stack" },
      el("h2", { class: "section-title", text: title }),
      lots.length
        ? lots.map(lotCard)
        : el("p", { class: "card-meta", text: emptyText }));
  }

  function draw() {
    clear(listBox);
    if (!store.getLastUpdated()) {
      listBox.append(...skeletons(3));
      return;
    }
    const lots = store.allLots();
    if (!lots.length) {
      listBox.append(el("div", { class: "empty-state" },
        el("p", { class: "empty-title", text: isDonor ? "No lots yet" : "No lots for you yet" }),
        el("p", { class: "empty-text", text: isDonor
          ? "Offer your first surplus lot to a receiver. They will be asked to accept it."
          : "When a donor offers a lot to you, it shows up here." })));
      return;
    }
    const needs = lots.filter((l) => nextAction(l, role, true).kind === "act");
    const needIds = new Set(needs.map((l) => l.lot_id));
    const rest = lots.filter((l) => !needIds.has(l.lot_id));
    listBox.append(
      section("Needs you", needs, "Nothing needs you right now. Lots appear here when it is your turn."),
      section("Everything else", rest, "No other lots."));
  }

  function tick() {
    const t = store.getLastUpdated();
    if (!t) {
      liveLine.textContent = "Loading lots…";
    } else {
      const s = Math.floor((Date.now() - t) / 1000);
      liveLine.textContent = s < 5 ? "Updated just now" : s < 60 ? `Updated ${s}s ago` : `Updated ${Math.floor(s / 60)}m ago`;
    }
    root.querySelectorAll(".countdown[data-epoch]").forEach((n) => paintCountdown(n, n.dataset.epoch, ctx.skewMs()));
  }

  const unsub = store.subscribe(() => { draw(); tick(); });
  draw();
  tick();
  const timer = setInterval(tick, 1000);

  return () => {
    clearInterval(timer);
    unsub();
    if (sheetHandle) { sheetHandle.close(); sheetHandle = null; }
  };
}
