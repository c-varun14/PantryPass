// Lot detail: stage, quantities, timeline, the donor "report distribution" moment and every action sheet.
import { el, clear } from "../dom.js";
import { icon } from "../icons.js";
import {
  avatar, button, qtyBar, numStepper, openSheet, setLoading, toast,
  celebrate, otpInput, img3d,
} from "../ui.js";
import {
  remainingOf, invariantHolds, nextAction, secondaryActions,
  secondsLeft, formatCountdown, validateQty, newIdemKey, friendlyError,
  trackerSteps, plainStage, whatNext, equationText, stageFamily,
  qty, unitOf, unitWord, unclaimed, isOpenOffer,
} from "../logic.js";

const POLL_MS = 4000;
const TICK_MS = 1000;
const SHEET_FADE_MS = 240; // openSheet() removes its backdrop after 220ms; the overlay mounts after that.
const MAX_UNITS = 999999;
const HERO_STAGES = ["HANDOFF_DECLARED", "RECEIVED", "DISTRIBUTING"];
const noop = () => {};

// lot_id -> { code, expires }. Memory only, never localStorage: the code is shown once, to the donor,
// straight after the handoff response. A page reload loses it, and the server never returns it again.
const pickupCodes = new Map();

// photo key -> signed URL, memory only. A redraw (every poll) must not change an <img> src, so the URL is
// fetched once and reused until it nears expiry. Refetches are throttled, and a failed key waits before a retry.
const PHOTO_RETRY_MS = 15000;
const PHOTO_REFRESH_MARGIN_MS = 30000;
const DEFAULT_PHOTO_TTL_S = 300;
const photos = new Map();

const READABLE_ACTION = {
  Accept: "accept the lot",
  DeclareHandoff: "say what was handed over",
  Receipt: "report what arrived",
  ReportDistribution: "report what was given out",
  Disposition: "report a return or disposal",
  Close: "close the lot",
  ResolveDispute: "settle the count",
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
    s: {
      alive: true, busy: false, trying: false, status: null, err: null, hero: null, flashDeny: false,
      verify: null, verifiedVersion: -1, verifySeq: 0, animated: new Set(), open: new Set(),
    },
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
  // Re-check the chain whenever the lot's record changes, not on every poll.
  const lot = r.ok ? c.store.lotById(c.id) : null;
  if (lot && lot.version !== c.s.verifiedVersion) runVerify(c, lot.version);
  draw(c);
}

// Asks the server to walk the chain. A failed check is reported as "could not check", never as a mismatch.
async function runVerify(c, version) {
  const seq = ++c.s.verifySeq;
  c.s.verifiedVersion = version;
  c.s.verify = { status: "checking", result: c.s.verify ? c.s.verify.result : null };
  draw(c);
  const r = await c.ctx.api.verifyLot(c.id);
  if (!c.s.alive || seq !== c.s.verifySeq) return;
  c.s.verify = r.ok ? { status: "done", result: r.body } : { status: "error" };
  draw(c);
}

function verifyAgain(c) {
  const lot = c.store.lotById(c.id);
  runVerify(c, lot ? lot.version : c.s.verifiedVersion);
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
  return el("div", { class: "stack lot-page lot-loading", "aria-busy": "true", "aria-label": "Loading lot" },
    el("div", { class: "skeleton skeleton-line lot-skel-title" }),
    el("div", { class: "skeleton skeleton-line lot-skel-people" }),
    el("div", { class: "skeleton skeleton-card" }),
    el("div", { class: "skeleton skeleton-card" }));
}

// In the desktop two-pane the home page already owns the <h1>, so the lot's title is an <h2> there.
const titleTag = () => (document.querySelector(".home") ? "h2" : "h1");

function statePanel(picture, title, text, actions = []) {
  return el("section", { class: "empty-state lot-state stack", role: "status" },
    img3d(picture, 96),
    el(titleTag(), { class: "empty-title display", text: title }),
    el("p", { class: "empty-text", text }),
    el("div", { class: "row" }, ...actions));
}

const backLink = () => el("a", { class: "btn btn-secondary", href: "#/" }, "All lots");

function forbiddenState() {
  return statePanel("locked", "Not a participant in this lot", "Only its donor, receiver and coordinator can open it.", [backLink()]);
}

function notFoundState() {
  return statePanel("magnifying_glass_tilted_left", "Lot not found", "It may have been removed, or the link is out of date.", [backLink()]);
}

function errorState(c, err) {
  const f = friendlyError(err.status ?? 0, err.body);
  const retry = button("Try again", { variant: "secondary", onClick: () => fetchLot(c, { force: true }) });
  return statePanel("warning", f.title, f.detail, [retry, backLink()]);
}

// ---- lot page ----

// Run an animation only the first time an event is drawn: draw() rebuilds the page on every poll.
function once(c, key) {
  if (c.s.animated.has(key)) return false;
  c.s.animated.add(key);
  return true;
}

function hasMismatch(lot) {
  return lot.donor_handoff != null && lot.received != null && lot.donor_handoff !== lot.received;
}

function lotPage(c, lot) {
  const bar = actionRow(c, lot, "lot-actions--bar");
  return el("article", { class: `split-detail stack lot-page${bar ? " has-bar" : ""}` },
    header(lot),
    statusHero(c, lot),
    stageBanners(c, lot),
    pickupCard(c, lot),
    detailsCard(c, lot),
    photosCard(c, lot),
    heroCard(c, lot),
    activityCard(c),
    bar);
}

// The first name of a person, for the copy in sheets and banners ("Asha (donor)" -> "Asha").
function firstNameOf(sub) {
  return personName(sub).replace(/\s*\([^)]*\)\s*$/, "").split(/\s+/)[0] || "";
}

// The headline: the count (received if known, else offered) in the lot's unit, the status chip, and the two people.
function header(lot) {
  const family = stageFamily(lot);
  // Names only in the header: the "(donor)" and "(receiver)" role words are for the account menu.
  const shortName = (sub) => personName(sub).replace(/\s*\([^)]*\)\s*$/, "");
  const donor = shortName(lot.donor_sub);
  const receiver = shortName(lot.receiver_sub);
  const count = lot.received != null ? lot.received : lot.offered;
  return el("header", { class: "lot-head" },
    el("div", { class: "lot-title-row" },
      el("a", { class: "back-link", href: "#/", "aria-label": "All lots", title: "All lots" }, icon("chevron-left", 22)),
      el(titleTag(), { class: "lot-id", text: `Lot ${String(lot.lot_id).slice(-6)}` })),
    el("p", { class: "lot-headline" },
      el("span", { class: "display-num lot-count-num", text: String(count ?? 0) }),
      el("span", { class: "lot-headline-cap", text: unitWord(count ?? 0, unitOf(lot)) })),
    el("span", { class: `chip chip-${family} lot-chip` },
      el("span", { class: "chip-dot", "aria-hidden": "true" }), plainStage(lot)),
    el("p", { class: "lot-people" },
      avatar(donor, "donor", "s"),
      el("span", { text: donor }),
      el("span", { class: "lot-people-arrow", "aria-hidden": "true", text: "→" }),
      unclaimed(lot)
        ? el("span", { class: "lot-open-to", text: "Open to all receivers" })
        : [avatar(receiver, "receiver", "s"), el("span", { text: receiver })]));
}

// ---- status hero: where are we (one sentence), a segmented progress bar, and the desktop action row ----

// The first sentence of a copy line: "Waiting for the receiver to accept." out of a longer paragraph.
function firstSentence(text) {
  const m = String(text || "").match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : String(text || "");
}

function statusHero(c, lot) {
  const next = nextAction(lot, c.ctx.role);
  const copy = whatNext(lot, c.ctx.role);
  // An open offer reads as two sentences ("Announced to every receiver. Waiting for someone to claim it.").
  const sentence = (lot.stage === "OFFERED" && isOpenOffer(lot)) ? copy : (firstSentence(copy) || next.label || "");
  return el("section", { class: "card lot-hero stack", "aria-label": "Lot status" },
    lot.confirmed_in_person
      ? el("span", { class: "badge badge-ok", title: "Receipt was confirmed with the donor's pickup code", text: "In person" })
      : null,
    sentence ? el("p", { class: "lot-status", text: sentence }) : null,
    progressBar(lot),
    actionRow(c, lot, "lot-actions--desk"));
}

// One span per step (is-done / is-current), then "Step 4 of 6 · Received" with the label in bold.
// A finished lot has no current step, so it reads as the last one.
function progressBar(lot) {
  const steps = trackerSteps(lot);
  const cur = steps.findIndex((s) => s.state === "current");
  const at = cur >= 0 ? cur : steps.length - 1;
  return el("div", { class: "stack lot-progress" },
    el("div", { class: "steps-bar", role: "img", "aria-label": `Step ${at + 1} of ${steps.length}` },
      steps.map((s) => el("span", { class: s.state === "done" ? "is-done" : s.state === "current" ? "is-current" : "" }))),
    el("p", { class: "lot-steps-line" },
      `Step ${at + 1} of ${steps.length} · `,
      el("strong", { text: steps[at].label })));
}

// The one primary button, plus any secondary actions as text buttons. Same handlers as before.
// Rendered twice: the sticky bar (phones and tablets) and an in-flow row in the status hero (desktop).
function actionRow(c, lot, cls) {
  const role = c.ctx.role;
  const next = nextAction(lot, role);
  const secondaries = secondaryActions(lot, role);
  if (next.kind !== "act" && !secondaries.length) return null;
  return el("div", { class: `lot-actions ${cls}`, role: "region", "aria-label": "Actions" },
    next.kind === "act"
      ? button(next.label, { variant: "primary", onClick: () => openAction(c, next.action) })
      : null,
    ...secondaries.map((sec) => button(sec.label, { variant: "ghost", onClick: () => openAction(c, sec.action) })));
}

// ---- pickup code (donor, memory only) ----

// Local wall-clock time for a server epoch, corrected by the Date-header skew.
function clockTime(epoch, skewMs) {
  return new Date(epoch * 1000 - skewMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function pickupCard(c, lot) {
  const p = pickupCodes.get(c.id);
  if (!p || c.ctx.role !== "donor" || lot.stage !== "HANDOFF_DECLARED") return null;
  if (secondsLeft(p.expires, c.ctx.skewMs()) <= 0) return null;
  // Six read-only boxes: the same look as the receiver's entry boxes, but static.
  const digits = String(p.code).split("").map((d) => el("span", { class: "otp-box", "aria-hidden": "true", text: d }));
  return el("section", { class: "card pickup-card", "aria-label": "Pickup code" },
    el("div", { class: "otp-row pickup-digits", role: "img", "aria-label": `Pickup code ${p.code}` }, digits),
    el("p", { class: "card-meta lot-pickup-meta", text: `Show this at pickup · until ${clockTime(p.expires, c.ctx.skewMs())}` }));
}

// ---- record verification (inside the Activity card) ----

// The badge shown in the Activity summary, on the right.
function verifyBadge(c) {
  const v = c.s.verify;
  if (!v) return null;
  if (v.status === "checking") return el("span", { class: "badge badge-muted", text: "Checking…" });
  if (v.status === "error") return el("span", { class: "badge badge-muted", text: "Could not check" });
  if (v.result.ok) return el("span", { class: "badge badge-ok" }, icon("shield-check", 14), "Record verified");
  return el("span", { class: "badge badge-bad", role: "status", text: "Record does not match" });
}

function verifyBlock(c) {
  const v = c.s.verify;
  if (!v) return null;
  const checking = v.status === "checking";
  const again = button("Verify again", { variant: "ghost", disabled: checking, onClick: () => verifyAgain(c) });
  let line;
  if (checking) {
    line = "Checking record…";
  } else if (v.status === "error") {
    line = "Could not check the record.";
  } else if (v.result.ok) {
    line = `${v.result.length} events checked.`;
  } else {
    line = v.result.reason || "The record does not match.";
  }
  const legacy = !checking && v.result && v.result.legacy > 0 ? v.result.legacy : 0;
  return el("div", { class: "stack lot-verify-block" },
    el("div", { class: "row lot-verify-row", "aria-live": "polite" },
      el("span", { class: `card-meta lot-verify-line${!checking && v.status !== "error" && !v.result.ok ? " is-bad" : ""}`, text: line }),
      again),
    legacy
      ? el("p", { class: "field-hint", text: `${legacy} older ${legacy === 1 ? "event pre-dates" : "events pre-date"} the chain` })
      : null);
}

function stageBanners(c, lot) {
  if (lot.stage === "OFFERED") return countdownBanner(c, lot);
  if (lot.stage === "EXCEPTION") {
    return el("div", { class: "banner banner-warn", role: "alert" },
      unclaimed(lot)
        ? "Nobody claimed it in time. No distribution or disposal is assumed."
        : "Nobody responded in time. No distribution or disposal is assumed.");
  }
  return null;
}

// An open offer counts down to claim; an assigned lot counts down to the receiver's answer.
function countdownBanner(c, lot) {
  const sec = secondsLeft(lot.response_deadline_epoch, c.ctx.skewMs());
  if (isOpenOffer(lot)) {
    return el("div", { class: "banner banner-info", role: "status" },
      el("span", null,
        "Announced to every receiver. Waiting for someone to claim it. ",
        el("span", { class: "countdown", text: formatCountdown(sec) || "--:--" }),
        " left."));
  }
  return el("div", { class: "banner banner-info", role: "status" },
    el("span", null,
      "Receiver has ",
      el("span", { class: "countdown", text: formatCountdown(sec) || "--:--" }),
      " to respond."));
}

// ---- details: one card with the quantity bar, hairline rows, the mismatch callout and the equation ----

// Seven rows. A count nobody can know yet is a dash, never 0. The swatch ties a row to its bar segment.
function countRows(lot) {
  const got = lot.received != null;
  const dash = (v) => (v == null ? "–" : String(v));
  const after = (n) => (got ? String(n) : "–");
  return [
    { label: "Offered", value: dash(lot.offered) },
    { label: "Handed over", value: dash(lot.donor_handoff) },
    { label: "Received", value: dash(lot.received) },
    { label: "Given out", value: after(lot.distributed || 0), swatch: "distributed" },
    { label: "Returned", value: after(lot.returned || 0), swatch: "returned" },
    { label: "Disposed", value: after(lot.disposed || 0), swatch: "disposed" },
    { label: "Left", value: got ? String(remainingOf(lot)) : "–", swatch: "remaining" },
  ];
}

// The bar with its own legend removed: the rows below carry the same numbers and swatches.
function quantityBar(lot) {
  const q = qtyBar(lot);
  const legend = q.querySelector(".qty-legend");
  if (legend) legend.remove();
  return q;
}

function countRow({ label, value, swatch }) {
  return el("div", { class: "lot-kv" },
    el("dt", { class: "lot-kv-label" },
      // Rows without a swatch keep an empty slot, so every label starts at the same x.
      el("span", { class: swatch ? `qty-swatch qty-${swatch}` : "qty-swatch is-empty", "aria-hidden": "true" }),
      label),
    el("dd", { class: "lot-kv-value", text: value }));
}

function detailsCard(c, lot) {
  return el("section", { class: "card lot-numbers", "aria-labelledby": "qty-title" },
    el("h2", { class: "section-title", id: "qty-title", text: "Details" }),
    quantityBar(lot),
    el("dl", { class: "lot-kvs" }, countRows(lot).map(countRow)),
    mismatchCallout(c, lot),
    equationDetails(c, lot));
}

// Collapsed by default. Open state survives the 4-second redraw (see disclosure()).
function equationDetails(c, lot) {
  if (lot.received == null) return null;
  const ok = invariantHolds(lot);
  const anim = ok && once(c, `eq:${lot.lot_id}:${lot.version}`);
  return disclosure(c, "how", "lot-how", [
    el("span", { class: `how-title${anim ? " is-animate" : ""}` },
      ok ? el("span", { class: "qty-check", "aria-label": "Counts add up", text: "✓" }) : null,
      "How the numbers add up",
      ok ? null : el("span", { class: "lot-how-note", text: "not yet" })),
  ], [el("p", { class: "lot-equation", text: equationText(lot) })]);
}

// The only red on the page besides the chip: one row inside the details card, not a box of its own.
function mismatchCallout(c, lot) {
  if (!hasMismatch(lot)) return null;
  const anim = once(c, `mm:${lot.lot_id}:${lot.donor_handoff}:${lot.received}`);
  const unit = unitOf(lot);
  return el("div", { class: "lot-mismatch" + (anim ? " is-animate" : ""), role: "status" },
    el("span", { class: "lot-mismatch-icon", "aria-hidden": "true" }, icon("triangle-alert", 20)),
    el("div", { class: "lot-mismatch-body" },
      el("p", { class: "lot-mismatch-title", text: "Counts don't match" }),
      el("p", { class: "lot-mismatch-line", text: `Donor said ${qty(lot.donor_handoff, unit)} · Receiver counted ${qty(lot.received, unit)}` }),
      el("p", { class: "lot-mismatch-wait", text: "Waiting for the coordinator." }),
      lot.count_dispute && hasPhoto(lot) ? photoPair(c, lot, " photo-pair--compact") : null));
}

// ---- donor hero: "Report distribution" that is refused by design ----

function heroCard(c, lot) {
  if (c.ctx.role !== "donor" || !HERO_STAGES.includes(lot.stage)) return null;
  const h = c.s.hero || {};
  let tryBtn = null;
  tryBtn = button("Try it anyway", { variant: "ghost", block: true, onClick: () => tryAnyway(c, tryBtn) });
  return el("section", { class: "card hero-card stack", "aria-labelledby": "hero-title" },
    el("h2", { class: "section-title", id: "hero-title", text: "Report what was given out" }),
    el("p", { class: "card-meta", text: "Only the receiver can report this. Yours would be refused." }),
    button("Mark as given out", { variant: "primary", block: true, disabled: true }),
    tryBtn,
    h.deny ? denyPanel(c, h.deny) : null,
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

function denyPanel(c, d) {
  const anim = once(c, `deny:${d.requestId}`);
  return el("div", { class: "deny-panel" + (anim ? " is-animate" : ""), role: "alert" },
    el("div", { class: "deny-head" },
      img3d("locked", 56),
      el("h3", { class: "deny-title display", text: "Refused" })),
    el("div", { class: "deny-detail" },
      el("div", { text: `Actor: ${d.actor}` }),
      el("div", { text: "Action: ReportDistribution" }),
      el("div", { text: "Decision: DENY (Verified Permissions)" }),
      el("div", { text: `Request id: ${d.requestId}` })));
}

function errorPanel(e) {
  return el("div", { class: "banner banner-warn", role: "alert" },
    el("strong", { text: e.title }), " ", e.detail);
}

// ---- timeline ----

function timeline(c) {
  const events = c.store.eventsOf(c.id).slice().sort((a, b) => eventMs(b) - eventMs(a));
  if (!events.length) return el("p", { class: "card-meta", text: "No events yet." });
  const skew = c.ctx.skewMs();
  const current = c.store.lotById(c.id);
  const open = !!current && unclaimed(current);
  let flashed = false;
  return el("div", { class: "timeline", role: "list" }, events.map((ev) => {
    const flash = c.s.flashDeny && !flashed && ev.decision === "DENY";
    if (flash) { flashed = true; c.s.flashDeny = false; }
    return eventRow(ev, skew, flash, open);
  }));
}

function eventRow(ev, skew, flash, open = false) {
  const who = personName(ev.actor);
  const deny = ev.decision === "DENY";
  const cls = ["tl-item"];
  if (deny) cls.push("is-deny");
  if (ev.decision === "ESCALATED") cls.push("is-escalated");
  if (flash) cls.push("success-pulse");
  const ago = relativeTime(eventMs(ev), skew);
  const title = deny ? "Refused by Verified Permissions" : eventTitle(ev, open);
  const meta = deny
    ? `${who} tried to ${READABLE_ACTION[ev.action] || humanize(ev.action)} · ${ago}`
    : `${who} · ${ago}`;
  return el("div", { class: cls.join(" "), role: "listitem" },
    el("span", { class: "tl-dot", "aria-hidden": "true" }),
    el("div", { class: "tl-body" },
      el("div", { class: "tl-title" }, title,
        !deny && photoKeyOf(ev)
          ? el("span", { class: "tl-photo", role: "img", title: "Photo attached", "aria-label": "Photo attached" }, icon("camera", 14))
          : null),
      el("div", { class: "tl-meta", text: meta })));
}

function photoKeyOf(ev) {
  return ev.photo_key || parseResult(ev.result).photo_key || null;
}

function parseResult(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw || "{}") || {}; } catch { return {}; }
}

function numberFrom(result, key) {
  const v = result[key];
  return typeof v === "number" ? ` ${v}` : "";
}

function eventTitle(ev, open = false) {
  const r = parseResult(ev.result);
  switch (ev.action) {
    case "CreateLot": return "Lot offered";
    case "Accept": return "Receiver accepted";
    case "DeclareHandoff": return `Donor declared handoff${numberFrom(r, "donor_handoff") ? " of" + numberFrom(r, "donor_handoff") : ""}`;
    case "Receipt": return `Receiver counted what arrived${numberFrom(r, "received")}`;
    case "ReportDistribution": return `Receiver reported given out${numberFrom(r, "distributed")}`;
    case "Disposition": return "Receiver reported returned or thrown away";
    case "Close": return "Lot closed: accounted for";
    case "ResponseDeadlineMissed": return open ? "Nobody claimed it in time" : "Nobody answered in time";
    case "CallbackRetried": return "Callback retried";
    case "ResolveDispute": return `Coordinator resolved the count${numberFrom(r, "reconciled_received") ? " at" + numberFrom(r, "reconciled_received") : ""}`;
    default: return humanize(ev.action || "Event");
  }
}

function humanize(action) {
  return String(action).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

// ---- activity: the chain check and the timeline, one collapsed card ----

// A <details> that keeps its open state across redraws (draw() rebuilds the page on every poll).
function disclosure(c, key, className, summary, body) {
  const d = el("details", { class: className, open: c.s.open.has(key) });
  d.addEventListener("toggle", () => {
    if (d.open) c.s.open.add(key);
    else c.s.open.delete(key);
  });
  d.append(el("summary", { class: "lot-disc" }, ...summary,
    el("span", { class: "lot-disc-chev", "aria-hidden": "true" }, icon("chevron-down", 18))));
  for (const node of body) if (node) d.append(node);
  return d;
}

function activityCard(c) {
  const count = c.store.eventsOf(c.id).length;
  return disclosure(c, "activity", "card lot-activity", [
    el("span", { class: "lot-activity-title" },
      "Activity",
      el("span", { class: "card-meta activity-count", text: ` ${count} ${count === 1 ? "event" : "events"}` })),
    verifyBadge(c),
  ], [verifyBlock(c), timeline(c)]);
}

// ---- photos: the two evidence photos, the picker in the sheets, the enlarged view ----

// Short name for a sub, with the account menu's role word stripped.
const nameOf = (sub) => personName(sub).replace(/\s*\([^)]*\)\s*$/, "");
const hasPhoto = (lot) => Boolean(lot.handoff_photo_key || lot.receipt_photo_key);

// Returns the cached URL, or null while it loads. Starts at most one fetch per key; the redraw runs on arrival.
function photoSrc(c, key) {
  const now = Date.now();
  let e = photos.get(key);
  if (!e) {
    e = { url: null, until: 0, pending: false, failedAt: 0 };
    photos.set(key, e);
  }
  if (e.url && now < e.until) return e.url;
  const backingOff = e.failedAt && now - e.failedAt < PHOTO_RETRY_MS;
  if (!e.pending && !backingOff) fetchPhoto(c, key, e);
  return e.url;
}

function fetchPhoto(c, key, e) {
  e.pending = true;
  c.ctx.api.photoUrl(c.id, key).then((r) => {
    e.pending = false;
    if (r.ok && r.body && r.body.url) {
      const ttl = (Number(r.body.expires_in) || DEFAULT_PHOTO_TTL_S) * 1000;
      e.url = r.body.url;
      e.until = Date.now() + ttl - PHOTO_REFRESH_MARGIN_MS;
      e.failedAt = 0;
    } else {
      e.url = null;
      e.failedAt = Date.now();
    }
    if (c.s.alive) draw(c);
  });
}

// One tile per photo: the image, or a muted "No photo" box. Tapping a photo opens it larger.
function photoTile(c, lot, kind) {
  const key = kind === "handoff" ? lot.handoff_photo_key : lot.receipt_photo_key;
  const label = kind === "handoff"
    ? `${nameOf(lot.donor_sub)} at handoff`
    : `${nameOf(lot.receiver_sub)} at count`;
  const caption = el("span", { class: "photo-cap", text: label });
  if (!key) {
    return el("div", { class: "photo-tile is-empty", role: "group", "aria-label": `${label}: no photo` },
      el("span", { class: "photo-frame is-empty" }, el("span", { class: "photo-empty", text: "No photo" })),
      caption);
  }
  const url = photoSrc(c, key);
  if (!url) {
    const e = photos.get(key);
    const failed = Boolean(e && e.failedAt && !e.pending);
    const frame = el("span", { class: `photo-frame ${failed ? "is-empty" : "is-loading"}`, "aria-busy": failed ? null : "true" },
      el("span", { class: "photo-empty", text: failed ? "Could not load" : "Loading…" }));
    return el("div", { class: "photo-tile is-empty", role: "group", "aria-label": `${label}: ${failed ? "could not load" : "loading"}` },
      frame, caption);
  }
  const img = el("img", { class: "photo-img", src: url, alt: label, decoding: "async" });
  img.addEventListener("error", () => {
    // An expired or broken signed URL: drop it and let the next draw fetch a fresh one after a short wait.
    const e = photos.get(key);
    if (e && e.url === url) {
      e.url = null;
      e.failedAt = Date.now();
      if (c.s.alive) draw(c);
    }
  });
  return el("button", { class: "photo-tile", type: "button", "aria-label": `${label}, open photo`, onclick: () => openPhoto(label, url) },
    el("span", { class: "photo-frame" }, img),
    caption);
}

function photoPair(c, lot, cls = "") {
  return el("div", { class: `photo-pair${cls}` }, photoTile(c, lot, "handoff"), photoTile(c, lot, "receipt"));
}

// Shown only once at least one photo exists. Hidden entirely on a lot with no photos.
function photosCard(c, lot) {
  if (!hasPhoto(lot)) return null;
  return el("section", { class: "card lot-photos", "aria-labelledby": "photos-title" },
    el("h2", { class: "section-title", id: "photos-title", text: "Photos" }),
    photoPair(c, lot));
}

function openPhoto(title, url) {
  let sheet = null;
  const close = button("Close", { variant: "secondary", block: true, onClick: () => sheet.close() });
  sheet = openSheet({
    title,
    body: el("div", { class: "stack photo-enlarged" },
      el("img", { class: "photo-large", src: url, alt: title, decoding: "async" })),
    footer: close,
  });
}

let photoUid = 0;

// The optional photo control: a visually hidden file input, its label styled as a secondary button with a camera
// icon, a preview with Remove once a file is chosen. A file input's label is the control's accessible name.
function photoPicker() {
  const id = `photo-input-${++photoUid}`;
  let file = null;
  let previewUrl = null;
  const error = el("p", { class: "field-error", role: "alert", hidden: true });
  const thumb = el("img", { class: "photo-thumb", alt: "" });
  const fileName = el("span", { class: "photo-file" });
  const remove = button("Remove", { variant: "ghost", onClick: () => clearFile() });
  remove.classList.add("photo-remove");
  const preview = el("div", { class: "photo-preview", hidden: true },
    thumb,
    el("div", { class: "photo-meta" }, fileName, remove));
  const input = el("input", {
    class: "photo-input", id, type: "file", accept: "image/*", capture: "environment",
    "aria-describedby": `${id}-hint`,
  });
  const trigger = el("label", { class: "btn btn-secondary photo-trigger", for: id },
    icon("camera", 18),
    el("span", { class: "btn-label", text: "Add a photo (optional)" }));
  const hint = el("p", { class: "field-hint", id: `${id}-hint`, text: "One photo. It is resized before upload." });

  function revoke() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }

  function clearFile() {
    file = null;
    revoke();
    thumb.removeAttribute("src");
    fileName.textContent = "";
    preview.hidden = true;
    error.hidden = true;
    error.textContent = "";
    input.value = "";
    input.focus();
  }

  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    if (!f) return clearFile();
    if (!/^image\//.test(f.type)) {
      input.value = "";
      file = null;
      revoke();
      preview.hidden = true;
      error.textContent = "Choose an image file.";
      error.hidden = false;
      return undefined;
    }
    file = f;
    revoke();
    previewUrl = URL.createObjectURL(f);
    thumb.src = previewUrl;
    thumb.alt = `Photo to attach: ${f.name}`;
    fileName.textContent = f.name;
    preview.hidden = false;
    error.hidden = true;
    error.textContent = "";
    return undefined;
  });

  return {
    el: el("div", { class: "field photo-field" }, input, trigger, hint, preview, error),
    file: () => file,
    setBusy(on) {
      input.disabled = on;
      remove.disabled = on;
    },
  };
}

// The upload step on the submit button: its label changes, and a spinner sits beside the label.
function setUploading(btn, on, label) {
  const text = btn.querySelector(".btn-label");
  if (text) text.textContent = label;
  btn.classList.toggle("is-uploading", on);
}

// ---- routing to sheets ----

function openAction(c, action) {
  const open = SHEETS[action];
  if (open) open(c);
}

// ---- trust points toast: after a successful mutation, compare the caller's total with the last one seen ----
// Baseline per signed-in sub (the mock can switch roles, and totals must not leak between people).
// The first fetch only records the baseline, so nothing toasts on a page that did not just change points.
const rewardBase = new Map(); // sub -> { total, seen: Set<event_hash> }

async function noteRewards(c) {
  const sub = c.ctx.session && c.ctx.session.sub;
  let r;
  try {
    r = await c.ctx.api.rewards();
  } catch (_) {
    return;
  }
  if (!r || !r.ok || !r.body || typeof r.body.points !== "number") return;
  const ledger = Array.isArray(r.body.ledger) ? r.body.ledger : [];
  const base = rewardBase.get(sub);
  if (!base) {
    rewardBase.set(sub, { total: r.body.points, seen: new Set(ledger.map((e) => e.event_hash)) });
    return;
  }
  const fresh = ledger.filter((e) => !base.seen.has(e.event_hash));
  fresh.forEach((e) => base.seen.add(e.event_hash));
  const gained = r.body.points - base.total;
  base.total = r.body.points;
  if (gained <= 0) return;
  const reasons = [...new Set(fresh.map((e) => e.reason))].slice(0, 2);
  toast(`+${gained} trust points${reasons.length ? " · " + reasons.join(", ") : ""}`, "reward");
}

// Called when an action sheet opens, so the first change of a visit can toast too.
async function primeRewards(c) {
  const sub = c.ctx.session && c.ctx.session.sub;
  if (rewardBase.has(sub)) return;
  try {
    const r = await c.ctx.api.rewards();
    if (r && r.ok && r.body && typeof r.body.points === "number" && !rewardBase.has(sub)) {
      const ledger = Array.isArray(r.body.ledger) ? r.body.ledger : [];
      rewardBase.set(sub, { total: r.body.points, seen: new Set(ledger.map((e) => e.event_hash)) });
    }
  } catch (_) { /* points are optional */ }
}

// ---- shared sheet flow: fresh idem key per open, version read at submit, 409 refreshes the numbers ----

function openFlow(c, o) {
  primeRewards(c); // not awaited
  const key = newIdemKey(o.idemPrefix);
  const box = el("div", { class: "stack" });
  const errBox = el("div", { class: "field-error", role: "alert" });
  const submit = button(o.submitLabel, { variant: "primary", block: true, onClick: () => send() });
  const photo = o.photoKind ? photoPicker() : null; // one picker per sheet, kept across 409 rebuilds
  let fields = null;
  let sheet = null;
  let busy = false;

  const build = () => {
    const lot = c.store.lotById(c.id);
    if (!lot) return;
    fields = o.build(lot);
    clear(box);
    box.append(...fields.nodes.filter(Boolean), ...(photo ? [photo.el] : []));
  };

  // Success: the sheet closes, then the celebration overlay mounts (in #sheet-root, outside the page, so
  // polling redraws cannot remove it). The reward toast is held until the overlay is dismissed.
  const done = () => {
    sheet.close();
    pulseQty(c);
    const onDone = () => noteRewards(c); // not awaited: the flow never waits for points
    if (!c.s.alive) return onDone();
    setTimeout(() => celebrate({ ...o.moment, onDone }), SHEET_FADE_MS);
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
    let photoKey = null;
    if (photo && photo.file()) {
      setUploading(submit, true, "Uploading photo…");
      photo.setBusy(true);
      const up = await c.ctx.api.uploadPhoto(c.id, o.photoKind, photo.file());
      photo.setBusy(false);
      setUploading(submit, false, o.submitLabel);
      if (!up.ok) {
        busy = false;
        setLoading(submit, false);
        submit.disabled = false;
        const f = friendlyError(up.status, up.body);
        errBox.textContent = `${f.title}. ${f.detail}`;
        toast(f.title, "error");
        return; // the sheet stays open with the photo still chosen
      }
      photoKey = up.key;
    }
    const fresh = photoKey ? (c.store.lotById(c.id) || lot) : lot;
    const body = {
      idem_key: key, expected_version: fresh.version, ...fields.read(),
      ...(photoKey ? { photo_key: photoKey } : {}),
    };
    const r = await c.store.mutate(o.fnName, c.id, body);
    busy = false;
    setLoading(submit, false);
    submit.disabled = false;
    if (r.ok) {
      if (o.onDone) o.onDone(r.body || {});
      return done();
    }
    const f = r.status === 409 && o.conflict ? o.conflict : friendlyError(r.status, r.body);
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
    ["Given out", lot.distributed || 0],
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
  if (lot.count_dispute) return "The counts don't match. The coordinator must settle them first.";
  const left = remainingOf(lot);
  return left > 0 ? `Report what happens to the remaining ${left} first (given out, returned or thrown away).` : "";
}

// ---- the sheets ----

// An open offer is claimed, not accepted: the first receiver to claim it collects it. A 409 means someone was first.
function openAccept(c) {
  const lot = c.store.lotById(c.id);
  const claim = !!lot && isOpenOffer(lot);
  const donor = firstNameOf(lot ? lot.donor_sub : null);
  openFlow(c, {
    title: claim ? "Claim this lot" : "Accept lot",
    idemPrefix: claim ? "claim" : "accept",
    fnName: "accept",
    submitLabel: claim ? "Claim this lot" : "Accept lot",
    moment: claim
      ? { title: "Claimed", text: `You collect it from ${donor}. They hand it over and give you a pickup code.`, image: "handshake" }
      : { title: "Accepted", text: "The donor can now hand it over.", image: "check_mark_button" },
    conflict: claim ? { title: "Someone else claimed it first", detail: "It is no longer open. Refresh and pick another." } : null,
    build: (fresh) => ({
      nodes: [el("p", {
        text: claim
          ? `Claim this lot? You will collect it from ${donor}.`
          : `Accept this lot of ${fresh.offered}?`,
      })],
      read: () => ({}),
      check: () => "",
    }),
  });
}

function openHandoff(c) {
  openFlow(c, {
    title: "Declare handoff", idemPrefix: "handoff", fnName: "handoff", submitLabel: "Declare handoff", photoKind: "handoff",
    moment: { title: "Handed over", text: "Share the pickup code with the receiver.", image: "package" },
    // Only a fresh response carries pickup_code; a replay does not, so nothing is overwritten.
    onDone: (body) => {
      if (body.pickup_code) pickupCodes.set(c.id, { code: body.pickup_code, expires: body.pickup_expires_epoch });
    },
    build: (lot) => {
      const unit = unitOf(lot);
      const st = numStepper({ value: lot.offered, min: 0, max: lot.offered, label: `Amount handed over (${unit})`, onChange: noop });
      return {
        nodes: [el("p", { text: `Lot offers ${qty(lot.offered, unit)}.` }), st.el],
        read: () => ({ donor_handoff: st.getValue() }),
        check: (fresh) => validateQty("donor_handoff", st.getValue(), fresh),
      };
    },
  });
}

function openReceipt(c) {
  let typedCode = ""; // survives the rebuild after a 409, so the receiver does not retype it
  openFlow(c, {
    title: "Report what arrived", idemPrefix: "receipt", fnName: "receipt", submitLabel: "Report received", photoKind: "receipt",
    moment: { title: "Counted", text: "Thanks, the count is recorded.", image: "check_mark_button" },
    build: (lot) => {
      const declared = lot.donor_handoff ?? 0;
      const unit = unitOf(lot);
      const st = numStepper({ value: declared, min: 0, max: MAX_UNITS, label: `Amount that arrived (${unit})`, onChange: noop });
      const otp = otpInput({
        length: 6,
        label: "Pickup code",
        onChange: (v) => { typedCode = v; otp.setError(""); },
      });
      if (typedCode) otp.setValue(typedCode);
      return {
        nodes: [
          el("p", { text: `Donor declared ${qty(declared, unit)}. Count what arrived.` }),
          st.el,
          el("div", { class: "field" },
            el("span", { class: "field-label", text: "Pickup code (optional)" }),
            otp.el,
            el("p", { class: "field-hint", text: "Optional: ask the donor for the 6 digits." })),
        ],
        read: () => {
          const code = typedCode.trim();
          return code ? { received: st.getValue(), pickup_code: code } : { received: st.getValue() };
        },
        check: (fresh) => {
          const qtyProblem = validateQty("received", st.getValue(), fresh);
          const cp = codeProblem(typedCode.trim());
          otp.setError(cp); // the specific message sits under the boxes
          return qtyProblem || (cp ? "Fix the pickup code." : "");
        },
      };
    },
  });
}

// The optional pickup code is checked here only for shape, so a typo does not use up an attempt.
function codeProblem(code) {
  return code && !/^\d{6}$/.test(code) ? "Enter the 6 digits, or leave the code blank." : "";
}

function openDistribution(c) {
  openFlow(c, {
    title: "Report given out", idemPrefix: "distribution", fnName: "distribution", submitLabel: "Report given out",
    moment: { title: "Given out", text: "Recorded in the lot's history.", image: "handshake" },
    build: (lot) => {
      const left = remainingOf(lot);
      const unit = unitOf(lot);
      let st = null;
      const preview = el("p", { class: "field-hint", "aria-live": "polite" });
      const update = () => { if (st) preview.textContent = `After this: ${qty(left - st.getValue(), unit)} remaining`; };
      st = numStepper({ value: Math.min(1, left), min: 1, max: left, label: `Amount handed out (${unit})`, onChange: update });
      update();
      return {
        nodes: [el("p", { text: `${qty(left, unit)} remaining to report.` }), st.el, preview],
        read: () => ({ distributed: st.getValue() }),
        check: (fresh) => validateQty("distributed", st.getValue(), fresh),
      };
    },
  });
}

function openDisposition(c) {
  openFlow(c, {
    title: "Return or dispose", idemPrefix: "disposition", fnName: "disposition", submitLabel: "Save return or disposal",
    moment: { title: "Recorded", text: "The return or disposal is on record.", image: "check_mark_button" },
    build: (lot) => {
      const left = remainingOf(lot);
      const unit = unitOf(lot);
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
        nodes: [el("p", { text: `${qty(left, unit)} remaining.` }), ret.el, dis.el, preview],
        read: () => ({ returned: ret.getValue(), disposed: dis.getValue() }),
        check: (fresh) => dispositionProblem(ret.getValue(), dis.getValue(), remainingOf(fresh)),
      };
    },
  });
}

function openClose(c) {
  openFlow(c, {
    title: "Close lot", idemPrefix: "close", fnName: "close", submitLabel: "Confirm and close",
    moment: { title: "Everything is counted", text: "This lot is closed and on the record.", image: "check_mark_button" },
    build: (lot) => ({
      nodes: [
        summaryList(lot),
        el("p", { class: "field-hint", text: "Closing records these totals as final." }),
      ],
      read: () => ({}),
      check: (fresh) => closeProblem(fresh),
    }),
  });
}

function openResolve(c) {
  openFlow(c, {
    title: "Settle the count", idemPrefix: "resolve", fnName: "resolveDispute", submitLabel: "Save the agreed count",
    moment: { title: "Settled", text: "The agreed count is saved.", image: "check_mark_button" },
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
          el("p", { text: `Donor said ${lot.donor_handoff ?? "nothing"}. Receiver counted ${lot.received ?? "nothing yet"}.` }),
          el("p", { class: "field-hint", text: "Sets the agreed count. What is still with the receiver updates." }),
          lot.count_dispute && hasPhoto(lot)
            ? el("div", { class: "field" }, el("span", { class: "field-label", text: "Photos at each count" }), photoPair(c, lot, " photo-pair--compact"))
            : null,
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
    el("p", { text: "The receiver did not answer in time." }),
    el("p", { class: "field-hint", text: "Nothing is assumed handed out." }),
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
