// Lot detail: stage, quantities, timeline, the donor "report distribution" moment and every action sheet.
import { el, clear } from "../dom.js";
import { button, chip, qtyBar, stageStepper, numStepper, openSheet, setLoading, toast } from "../ui.js";
import {
  remainingOf, invariantHolds, nextAction, secondaryActions,
  secondsLeft, formatCountdown, validateQty, newIdemKey, friendlyError,
} from "../logic.js";

const POLL_MS = 4000;
const TICK_MS = 1000;
const MAX_UNITS = 999999;
const HERO_STAGES = ["HANDOFF_DECLARED", "RECEIVED", "DISTRIBUTING"];
const noop = () => {};

const READABLE_ACTION = {
  Accept: "accept the lot",
  DeclareHandoff: "declare the handoff",
  Receipt: "report what arrived",
  ReportDistribution: "report distribution",
  Disposition: "report a return or disposal",
  Close: "close the lot",
  ResolveDispute: "resolve the count dispute",
  CallbackRetried: "retry callbacks",
  CreateLot: "offer a lot",
};

const SHEETS = {
  accept: openAccept,
  handoff: openHandoff,
  receipt: openReceipt,
  distribution: openDistribution,
  disposition: openDisposition,
  close: openClose,
  "resolve-dispute": openResolve,
  "review-exception": openReview,
};

export async function render(container, ctx) {
  const c = {
    ctx, container, store: ctx.store, id: ctx.params.id,
    s: { alive: true, busy: false, trying: false, status: null, err: null, hero: null, flashDeny: false },
  };
  const unsub = c.store.subscribe(() => draw(c));
  const onVis = () => { if (!document.hidden) fetchLot(c, { force: true }); };
  const timers = [
    setInterval(() => tickCountdowns(c), TICK_MS),
    setInterval(() => { if (!document.hidden) fetchLot(c); }, POLL_MS),
  ];
  document.addEventListener("visibilitychange", onVis);
  draw(c);
  fetchLot(c, { force: true });
  return () => {
    c.s.alive = false;
    timers.forEach((t) => clearInterval(t));
    document.removeEventListener("visibilitychange", onVis);
    unsub();
  };
}

// ---- data flow ----

async function fetchLot(c, { force = false } = {}) {
  if (!c.s.alive || (c.s.busy && !force)) return;
  c.s.busy = true;
  let r;
  try { r = await c.store.refreshLot(c.id); } finally { c.s.busy = false; }
  if (!c.s.alive) return;
  c.s.status = r.ok ? 200 : r.status;
  c.s.err = r.ok ? null : r;
  draw(c);
}

function draw(c) {
  if (!c.s.alive) return;
  clear(c.container);
  c.container.append(pageFor(c, c.store.lotById(c.id)));
}

function pageFor(c, lot) {
  const { status, err } = c.s;
  if (status === 403) return forbiddenState();
  if (status === 404) return notFoundState();
  if (lot) return lotPage(c, lot);
  if (status !== null && status !== 200) return errorState(c, err || {});
  return skeleton();
}

function tickCountdowns(c) {
  if (!c.s.alive) return;
  const lot = c.store.lotById(c.id);
  if (!lot || lot.stage !== "OFFERED") return;
  const sec = secondsLeft(lot.response_deadline_epoch, c.ctx.skewMs());
  c.container.querySelectorAll(".countdown").forEach((node) => {
    node.textContent = formatCountdown(sec) || "--:--";
    node.classList.toggle("is-late", sec <= 0);
  });
}

// ---- names and time ----

function personName(sub) {
  const people = (window.PP_CONFIG && window.PP_CONFIG.people) || [];
  const p = people.find((x) => x.sub === sub);
  if (p) return p.name;
  if (!sub) return "Someone";
  return sub.length > 10 ? `${sub.slice(0, 8)}…` : sub;
}

function eventMs(ev) {
  const t = ev.ts;
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
  if (typeof t === "string" && /^\d+$/.test(t)) return eventMs({ ts: Number(t) });
  const n = Date.parse(t);
  return Number.isNaN(n) ? 0 : n;
}

function relativeTime(ms, skew) {
  if (!ms) return "";
  const sec = Math.max(0, Math.round((Date.now() + skew - ms) / 1000));
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

// ---- static states ----

function skeleton() {
  return el("div", { class: "stack", "aria-busy": "true", "aria-label": "Loading lot" },
    el("div", { class: "skeleton skeleton-line" }),
    el("div", { class: "skeleton skeleton-line" }),
    el("div", { class: "skeleton skeleton-card" }),
    el("div", { class: "skeleton skeleton-card" }));
}

function statePanel(title, text, actions = []) {
  return el("section", { class: "empty-state", role: "status" },
    el("h1", { class: "empty-title", text: title }),
    el("p", { class: "empty-text", text }),
    el("div", { class: "row" }, ...actions));
}

const backLink = () => el("a", { class: "btn btn-secondary", href: "#/" }, "Back to all lots");

function forbiddenState() {
  return statePanel("Not a participant in this lot",
    "Only the donor, the assigned receiver and the coordinator can open a lot. If you think this is a mistake, ask the coordinator.",
    [backLink()]);
}

function notFoundState() {
  return statePanel("Lot not found", "It may have been removed, or the link is out of date.", [backLink()]);
}

function errorState(c, err) {
  const f = friendlyError(err.status ?? 0, err.body);
  const retry = button("Try again", { variant: "secondary", onClick: () => fetchLot(c, { force: true }) });
  return statePanel(f.title, f.detail, [retry, backLink()]);
}

// ---- lot page ----

function lotPage(c, lot) {
  return el("article", { class: "split-detail stack lot-page" },
    header(lot),
    stageStepper(lot),
    stageBanners(c, lot),
    quantitySection(lot),
    heroCard(c, lot),
    el("section", { class: "stack", "aria-labelledby": "tl-title" },
      el("h2", { class: "section-title", id: "tl-title", text: "Timeline" }),
      timeline(c)),
    actionBar(c, lot));
}

function header(lot) {
  return el("header", { class: "stack" },
    el("a", { class: "back-link", href: "#/" }, "< All lots"),
    el("h1", { class: "page-title", text: `Lot ...${String(lot.lot_id).slice(-6)}` }),
    el("div", { class: "row" }, chip(lot)),
    el("p", { class: "page-sub", text: `${personName(lot.donor_sub)} -> ${personName(lot.receiver_sub)}` }));
}

function stageBanners(c, lot) {
  if (lot.stage === "OFFERED") return countdownBanner(c, lot);
  if (lot.stage === "EXCEPTION") {
    return el("div", { class: "banner banner-danger", role: "alert" },
      "Nobody responded in time. No distribution or disposal is assumed.");
  }
  return null;
}

function countdownBanner(c, lot) {
  const sec = secondsLeft(lot.response_deadline_epoch, c.ctx.skewMs());
  return el("div", { class: "banner banner-info", role: "status" },
    "Receiver has ",
    el("span", { class: "countdown", text: formatCountdown(sec) || "--:--" }),
    " to respond. If nobody answers, this becomes an exception for the coordinator.");
}

// ---- quantities ----

function quantityItems(lot) {
  const items = [["Offered", lot.offered]];
  if (lot.donor_handoff != null) items.push(["Declared by donor", lot.donor_handoff]);
  if (lot.received != null) {
    items.push(
      ["Received (reported by receiver)", lot.received],
      ["Distributed", lot.distributed || 0],
      ["Returned", lot.returned || 0],
      ["Disposed", lot.disposed || 0],
      ["Remaining", remainingOf(lot)]);
  }
  return items;
}

function quantitySection(lot) {
  const counted = lot.received != null && invariantHolds(lot);
  return el("section", { class: "card stack", "aria-labelledby": "qty-title" },
    el("h2", { class: "section-title", id: "qty-title", text: "Quantity" }),
    el("div", { class: "qty-big" }, quantityItems(lot).map(([cap, n]) =>
      el("div", { class: "qty-big-item" },
        el("span", { class: "qty-num", text: String(n) }),
        el("span", { class: "qty-cap", text: cap })))),
    qtyBar(lot),
    el("p", { class: "qty-caption" },
      counted ? el("span", { class: "qty-check", "aria-label": "Counts add up", text: "✓ " }) : null,
      "Received = distributed + returned + disposed + remaining"),
    mismatchBlock(lot));
}

function mismatchBlock(lot) {
  if (lot.donor_handoff == null || lot.received == null || lot.donor_handoff === lot.received) return null;
  const d = lot.donor_handoff;
  const r = lot.received;
  return el("div", { class: "stack" },
    el("div", { class: "compare-pair" }, compareBox("Donor declared", d), compareBox("Receiver reported", r)),
    el("div", { class: "banner banner-dispute", role: "status" },
      `Counts disagree: donor declared ${d}, receiver reported ${r}. This lot cannot be closed until the coordinator resolves it.`));
}

function compareBox(label, n) {
  return el("div", { class: "compare-box is-mismatch" },
    el("span", { class: "qty-cap", text: label }),
    el("span", { class: "qty-num", text: String(n) }));
}

// ---- donor hero: "Report distribution" that is refused by design ----

function heroCard(c, lot) {
  if (c.ctx.role !== "donor" || !HERO_STAGES.includes(lot.stage)) return null;
  const h = c.s.hero || {};
  let tryBtn = null;
  tryBtn = button("Try it anyway", { variant: "ghost", block: true, onClick: () => tryAnyway(c, tryBtn) });
  return el("section", { class: "card hero-card stack", "aria-labelledby": "hero-title" },
    el("h2", { class: "section-title", id: "hero-title", text: "Report distribution" }),
    el("p", { class: "card-meta", text: "Distribution is reported by the receiver, after the food has gone out." }),
    button("Mark as distributed", { variant: "primary", block: true, disabled: true }),
    el("p", { class: "field-hint", text: "Only the assigned receiver can report distribution. Your request would be refused." }),
    tryBtn,
    h.deny ? denyPanel(h.deny) : null,
    h.error ? errorPanel(h.error) : null);
}

async function tryAnyway(c, btn) {
  const lot = c.store.lotById(c.id);
  if (!lot || c.s.trying) return;
  c.s.trying = true;
  setLoading(btn, true);
  btn.disabled = true;
  const r = await c.ctx.api.distribution(c.id, { idem_key: newIdemKey("try"), expected_version: lot.version, distributed: 1 });
  c.s.trying = false;
  if (!c.s.alive) return;
  if (r.status === 403) return showRefusal(c, r.body || {});
  c.s.hero = { error: unexpectedNote(r) };
  await fetchLot(c, { force: true });
}

async function showRefusal(c, body) {
  c.s.hero = { deny: { actor: (c.ctx.session && c.ctx.session.name) || "You", requestId: body.request_id || "not returned" } };
  toast("Refused by Verified Permissions. Nothing changed.", "error");
  c.s.flashDeny = true;
  await fetchLot(c, { force: true });
  c.s.flashDeny = false;
}

function unexpectedNote(r) {
  const detail = r.ok
    ? "The request was accepted, so the numbers below were refreshed."
    : friendlyError(r.status, r.body).detail;
  return { title: "Unexpected: the server did not refuse this", detail };
}

function denyPanel(d) {
  return el("div", { class: "deny-panel", role: "alert" },
    el("h3", { class: "deny-title", text: "Refused" }),
    el("div", { class: "deny-detail" },
      el("div", { text: `Actor: ${d.actor}` }),
      el("div", { text: "Action: ReportDistribution" }),
      el("div", { text: "Decision: DENY (Verified Permissions)" }),
      el("div", { text: `Request id: ${d.requestId}` })));
}

function errorPanel(e) {
  return el("div", { class: "banner banner-danger", role: "alert" },
    el("strong", { text: e.title }), " ", e.detail);
}

// ---- timeline ----

function timeline(c) {
  const events = c.store.eventsOf(c.id).slice().sort((a, b) => eventMs(b) - eventMs(a));
  if (!events.length) return el("p", { class: "empty-text", text: "No events yet. They appear here as the lot moves." });
  const skew = c.ctx.skewMs();
  let flashed = false;
  return el("div", { class: "timeline", role: "list" }, events.map((ev) => {
    const flash = c.s.flashDeny && !flashed && ev.decision === "DENY";
    if (flash) { flashed = true; c.s.flashDeny = false; }
    return eventRow(ev, skew, flash);
  }));
}

function eventRow(ev, skew, flash) {
  const who = personName(ev.actor);
  const deny = ev.decision === "DENY";
  const cls = ["tl-item"];
  if (deny) cls.push("is-deny");
  if (ev.decision === "ESCALATED") cls.push("is-escalated");
  if (flash) cls.push("success-pulse");
  const ago = relativeTime(eventMs(ev), skew);
  const title = deny
    ? `Refused: ${who} tried ${READABLE_ACTION[ev.action] || humanize(ev.action)}`
    : eventTitle(ev);
  const meta = deny ? `Verified Permissions said DENY · ${ago}` : `${who} · ${ago}`;
  return el("div", { class: cls.join(" "), role: "listitem" },
    el("span", { class: "tl-dot", "aria-hidden": "true" }),
    el("div", { class: "tl-body" },
      el("div", { class: "tl-title", text: title }),
      el("div", { class: "tl-meta", text: meta })));
}

function parseResult(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw || "{}") || {}; } catch { return {}; }
}

function numberFrom(result, key) {
  const v = result[key];
  return typeof v === "number" ? ` ${v}` : "";
}

function eventTitle(ev) {
  const r = parseResult(ev.result);
  switch (ev.action) {
    case "CreateLot": return "Lot offered";
    case "Accept": return "Receiver accepted";
    case "DeclareHandoff": return `Donor declared handoff${numberFrom(r, "donor_handoff") ? " of" + numberFrom(r, "donor_handoff") : ""}`;
    case "Receipt": return `Receiver reported${numberFrom(r, "received")} received`;
    case "ReportDistribution": return `Receiver reported${numberFrom(r, "distributed")} distributed`;
    case "Disposition": return "Receiver reported a return or disposal";
    case "Close": return "Accounted for";
    case "ResponseDeadlineMissed": return "No response in time";
    case "CallbackRetried": return "Callback retried";
    case "ResolveDispute": return `Coordinator resolved the count dispute${numberFrom(r, "reconciled_received") ? " at" + numberFrom(r, "reconciled_received") : ""}`;
    default: return humanize(ev.action || "Event");
  }
}

function humanize(action) {
  return String(action).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

// ---- action bar and routing to sheets ----

function actionBar(c, lot) {
  const role = c.ctx.role;
  const next = nextAction(lot, role);
  const bar = el("div", { class: "action-bar", role: "region", "aria-label": "Next step" });
  if (next.kind === "act") {
    bar.append(button(next.label, { variant: "primary", block: true, onClick: () => openAction(c, next.action) }));
  } else if (next.kind === "wait") {
    bar.append(el("p", { class: "page-sub" }, el("span", { class: "chip-dot", "aria-hidden": "true" }), " ", next.label));
  }
  for (const sec of secondaryActions(lot, role)) {
    bar.append(button(sec.label, { variant: "secondary", block: true, onClick: () => openAction(c, sec.action) }));
  }
  return bar;
}

function openAction(c, action) {
  const open = SHEETS[action];
  if (open) open(c);
}

// ---- shared sheet flow: fresh idem key per open, version read at submit, 409 refreshes the numbers ----

function openFlow(c, o) {
  const key = newIdemKey(o.idemPrefix);
  const box = el("div", { class: "stack" });
  const errBox = el("div", { class: "field-error", role: "alert" });
  const submit = button(o.submitLabel, { variant: "primary", block: true, onClick: () => send() });
  let fields = null;
  let sheet = null;
  let busy = false;

  const build = () => {
    const lot = c.store.lotById(c.id);
    if (!lot) return;
    fields = o.build(lot);
    clear(box);
    box.append(...fields.nodes);
  };

  const done = (msg) => {
    sheet.close();
    toast(msg, "success");
    pulseQty(c);
  };

  const send = async () => {
    const lot = c.store.lotById(c.id);
    if (busy || !lot || !fields) return;
    const problem = fields.check(lot);
    errBox.textContent = problem || "";
    if (problem) return;
    busy = true;
    setLoading(submit, true);
    submit.disabled = true;
    const body = { idem_key: key, expected_version: lot.version, ...fields.read() };
    const r = await c.store.mutate(o.fnName, c.id, body);
    busy = false;
    setLoading(submit, false);
    submit.disabled = false;
    if (r.ok) return done(o.success);
    const f = friendlyError(r.status, r.body);
    errBox.textContent = `${f.title}. ${f.detail}`;
    toast(f.title, "error");
    if (r.status === 409) build();
  };

  build();
  sheet = openSheet({
    title: o.title,
    body: el("div", { class: "stack" }, box, errBox),
    footer: submit,
  });
}

function pulseQty(c) {
  const bar = c.container.querySelector(".qty-bar");
  if (!bar) return;
  bar.classList.remove("success-pulse");
  void bar.offsetWidth;
  bar.classList.add("success-pulse");
}

function summaryList(lot) {
  const rows = [
    ["Received", lot.received ?? 0],
    ["Distributed", lot.distributed || 0],
    ["Returned", lot.returned || 0],
    ["Disposed", lot.disposed || 0],
    ["Remaining", remainingOf(lot)],
  ];
  return el("dl", { class: "stack" }, rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: String(v) })]));
}

function committedOf(lot) {
  return (lot.distributed || 0) + (lot.returned || 0) + (lot.disposed || 0);
}

function dispositionProblem(returned, disposed, left) {
  const used = returned + disposed;
  if (used <= 0) return "Enter at least 1 returned or disposed.";
  if (used > left) return `Only ${left} remaining.`;
  return "";
}

function resolveProblem(n, lot) {
  const committed = committedOf(lot);
  return n < committed ? `Cannot be below ${committed}: that much is already distributed, returned or disposed.` : "";
}

function closeProblem(lot) {
  if (lot.count_dispute) return "This lot has a count dispute. The coordinator must resolve it first.";
  const left = remainingOf(lot);
  return left > 0 ? `Distribute, return or dispose the remaining ${left} first.` : "";
}

// ---- the sheets ----

function openAccept(c) {
  openFlow(c, {
    title: "Accept lot", idemPrefix: "accept", fnName: "accept", submitLabel: "Accept lot", success: "Lot accepted",
    build: (lot) => ({
      nodes: [el("p", { text: `Accept this lot of ${lot.offered}?` })],
      read: () => ({}),
      check: () => "",
    }),
  });
}

function openHandoff(c) {
  openFlow(c, {
    title: "Declare handoff", idemPrefix: "handoff", fnName: "handoff", submitLabel: "Declare handoff", success: "Handoff declared",
    build: (lot) => {
      const st = numStepper({ value: lot.offered, min: 0, max: lot.offered, label: "Units you are handing over", onChange: noop });
      return {
        nodes: [el("p", { text: `This lot offers ${lot.offered}. Declare how many you are handing over.` }), st.el],
        read: () => ({ donor_handoff: st.getValue() }),
        check: (fresh) => validateQty("donor_handoff", st.getValue(), fresh),
      };
    },
  });
}

function openReceipt(c) {
  openFlow(c, {
    title: "Report what arrived", idemPrefix: "receipt", fnName: "receipt", submitLabel: "Report received", success: "Receipt reported",
    build: (lot) => {
      const declared = lot.donor_handoff ?? 0;
      const st = numStepper({ value: declared, min: 0, max: MAX_UNITS, label: "Units that arrived", onChange: noop });
      return {
        nodes: [
          el("p", { text: `Donor declared ${declared}.` }),
          el("p", { class: "field-hint", text: "Count what actually arrived." }),
          st.el,
        ],
        read: () => ({ received: st.getValue() }),
        check: (fresh) => validateQty("received", st.getValue(), fresh),
      };
    },
  });
}

function openDistribution(c) {
  openFlow(c, {
    title: "Report distribution", idemPrefix: "distribution", fnName: "distribution", submitLabel: "Report distribution", success: "Distribution reported",
    build: (lot) => {
      const left = remainingOf(lot);
      let st = null;
      const preview = el("p", { class: "field-hint", "aria-live": "polite" });
      const update = () => { if (st) preview.textContent = `After this: ${left - st.getValue()} remaining`; };
      st = numStepper({ value: Math.min(1, left), min: 1, max: left, label: "Units handed out", onChange: update });
      update();
      return {
        nodes: [el("p", { text: `${left} remaining to report.` }), st.el, preview],
        read: () => ({ distributed: st.getValue() }),
        check: (fresh) => validateQty("distributed", st.getValue(), fresh),
      };
    },
  });
}

function openDisposition(c) {
  openFlow(c, {
    title: "Return or dispose", idemPrefix: "disposition", fnName: "disposition", submitLabel: "Save return or disposal", success: "Return or disposal reported",
    build: (lot) => {
      const left = remainingOf(lot);
      let ret = null;
      let dis = null;
      const preview = el("p", { class: "field-hint", "aria-live": "polite" });
      const update = () => {
        if (!ret || !dis) return;
        const problem = dispositionProblem(ret.getValue(), dis.getValue(), left);
        preview.textContent = problem || `After this: ${left - ret.getValue() - dis.getValue()} remaining`;
      };
      ret = numStepper({ value: 0, min: 0, max: left, label: "Returned to donor", onChange: update });
      dis = numStepper({ value: 0, min: 0, max: left, label: "Disposed", onChange: update });
      update();
      return {
        nodes: [el("p", { text: `${left} remaining. Enter what went back or was disposed of.` }), ret.el, dis.el, preview],
        read: () => ({ returned: ret.getValue(), disposed: dis.getValue() }),
        check: (fresh) => dispositionProblem(ret.getValue(), dis.getValue(), remainingOf(fresh)),
      };
    },
  });
}

function openClose(c) {
  openFlow(c, {
    title: "Close lot", idemPrefix: "close", fnName: "close", submitLabel: "Confirm and close", success: "Lot accounted for",
    build: (lot) => ({
      nodes: [
        summaryList(lot),
        el("p", { class: "field-hint", text: "Closing records these totals as the final account of this lot." }),
      ],
      read: () => ({}),
      check: (fresh) => closeProblem(fresh),
    }),
  });
}

function openResolve(c) {
  openFlow(c, {
    title: "Resolve count dispute", idemPrefix: "resolve", fnName: "resolveDispute", submitLabel: "Save reconciled count", success: "Count dispute resolved",
    build: (lot) => {
      const committed = committedOf(lot);
      let st = null;
      const preview = el("p", { class: "field-hint", "aria-live": "polite" });
      const update = () => {
        if (!st) return;
        const n = st.getValue();
        preview.textContent = n < committed
          ? `Too low: ${committed} already distributed, returned or disposed.`
          : `Remaining will be ${n - committed}.`;
      };
      st = numStepper({ value: lot.received ?? 0, min: 0, max: MAX_UNITS, label: "Reconciled received count", onChange: update });
      update();
      return {
        nodes: [
          el("p", { text: `Donor declared ${lot.donor_handoff ?? "nothing"}. Receiver reported ${lot.received ?? "nothing yet"}.` }),
          el("p", { class: "field-hint", text: "Saving overwrites the received count and rebalances remaining. Distributed, returned and disposed stay as they are." }),
          st.el,
          preview,
        ],
        read: () => ({ reconciled_received: st.getValue() }),
        check: (fresh) => resolveProblem(st.getValue(), fresh),
      };
    },
  });
}

function openReview(c) {
  const lot = c.store.lotById(c.id);
  if (!lot) return;
  let retry = null;
  retry = button("Retry callbacks", { variant: "secondary", block: true, onClick: () => retryCallbacks(c, retry) });
  const nodes = [
    el("p", { text: "The receiver did not answer before the response deadline, so this lot was marked as an exception." }),
    el("p", { class: "field-hint", text: "No distribution or disposal is assumed. Nothing has been recorded as handed out." }),
  ];
  if (lot.callback_pending) {
    nodes.push(el("p", { text: "A notification callback is still waiting to be delivered." }), retry);
  }
  openSheet({ title: "Review exception", body: el("div", { class: "stack" }, nodes) });
}

async function retryCallbacks(c, btn) {
  const lot = c.store.lotById(c.id);
  setLoading(btn, true);
  btn.disabled = true;
  const r = await c.ctx.api.retryCallbacks(lot ? lot.lot_id : c.id);
  setLoading(btn, false);
  btn.disabled = false;
  if (r.ok) {
    toast("Callbacks retried", "success");
    await fetchLot(c, { force: true });
    return;
  }
  const f = friendlyError(r.status, r.body);
  toast(`${f.title}: ${f.detail}`, "error");
}
