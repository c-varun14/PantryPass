// The fund (#/fund): how the pool works, and what it means for the signed-in role.
// Every signed-in role sees the same page: the model, the pool, the top donors, three steps, then one role block.
// GET /fund is the source of the numbers. PantryPass keeps no money: supporters pay through Razorpay Checkout,
// and every rupee reaches donors, who are paid out by Razorpay to the bank details they gave.
import { el, clear } from "../dom.js";
import { icon } from "../icons.js";
import { button, celebrate, openSheet, setLoading, toast } from "../ui.js";
import { qty } from "../logic.js";
import { loadCheckout } from "../razorpay.js";
import { displayName } from "./welcome.js";

const MODEL = "Sponsors and supporters pay through Razorpay Checkout, and every rupee reaches donors: PantryPass keeps nothing. Pool money is shared among donors by trust points, and Razorpay pays each donor automatically to the bank details they provide. The project runs on sponsors, open-source contributors and volunteers like the coordinator.";

const STEPS = [
  ["Donate food and hand it over verified", "Offer a lot, then hand it over with a pickup code."],
  ["The receiver confirms what arrived in person", "Counting happens at the handoff, and the receiver enters the pickup code. Only verified amounts earn points."],
];

const RECEIVER_NOTE = "Receivers do not earn from the pool. Your confirmations are what make payouts trustworthy.";
const FOOTNOTE = "Estimates only. PantryPass keeps nothing: sponsors and supporters pay through Razorpay Checkout, and Razorpay pays each donor's share to the bank details they provide.";
const DEMO_LABEL = "Demo pool: no money moves in this demo";
const LOADING = "Loading";
const PAYOUT_COLS = 7; // donor, estimate, direct donations, owed, paid so far, latest payment, bank details

const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const rupees = (n) => INR.format(Math.round(Number(n) || 0));
const percent = (n) => `${Number(n || 0).toFixed(1).replace(/\.0$/, "")}%`;
const clampPct = (n) => Math.min(100, Math.max(0, Number(n) || 0));
const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;
const isDemoMode = (d) => ((d.pool && d.pool.mode) || (d.donations && d.donations.mode)) === "demo";

function dateOf(ts) {
  const t = new Date(Number(ts) < 1e12 ? Number(ts) * 1000 : ts); // the API sends epoch seconds
  return Number.isNaN(t.getTime()) ? "" : DATE.format(t);
}

// The error text from a failed reply, or the fallback when the server sent none.
function errorOf(r, fallback) {
  return (r && r.body && typeof r.body.error === "string" && r.body.error) || fallback;
}

function setErr(node, msg) {
  node.textContent = msg || "";
  node.hidden = !msg;
}

// Name from the demo config when the sub is known, else "Donor 1", "Donor 2" by position in the list.
function donorName(sub, index) {
  const people = (window.PP_CONFIG && window.PP_CONFIG.people) || [];
  const p = people.find((x) => x.sub === sub);
  return p ? displayName(p.name) : `Donor ${index + 1}`;
}

function stat(value, caption) {
  return el("div", { class: "fund-stat" },
    el("strong", { class: "fund-stat-num display-num", text: value }),
    el("span", { class: "fund-stat-cap", text: caption }));
}

function stepNode([title, detail], i) {
  return el("li", { class: "fund-step" },
    el("span", { class: "fund-step-num", "aria-hidden": "true", text: String(i + 1) }),
    el("span", { class: "fund-step-body" },
      el("strong", { class: "fund-step-title", text: title }),
      el("span", { class: "fund-step-detail", text: detail })));
}

// The third step names the numbers from `needs` when the viewer has them (donors), else says it in general.
function stepsList(needs) {
  const lots = needs
    ? `${plural(needs.lots, "verified lot", "verified lots")} to ${plural(needs.partners, "different receiver", "different receivers")}`
    : "verified lots to several different receivers";
  const third = ["Your share of the pool follows your points",
    `To share the pool you need ${lots}. Points add up over the period, and so does your share of the pool. Razorpay then pays your share to your bank details.`];
  return el("ol", { class: "fund-steps" }, [...STEPS, third].map(stepNode));
}

const PRESETS = [100, 500, 1000];
const DEMO_NOTICE = "Simulated payment: nothing is charged and no money moves. Real payments switch on when the payment gateway is connected.";
const CHECKOUT_ERR = "Could not open the payment window. Check your connection and try again.";
const CHECKOUT_COLOR = "#1f6f50";

// Plain words for a payout status, and the chip class that gives it its colour (the text says it too).
const PAY_STATUS = {
  queued: ["Queued", "is-queued"],
  initiating: ["On its way", "is-progress"],
  processing: ["On its way", "is-progress"],
  processed: ["Paid", "is-done"],
  failed: ["Failed, will be retried", "is-failed"],
  reversed: ["Failed, will be retried", "is-failed"],
  rejected: ["Failed, will be retried", "is-failed"],
  cancelled: ["Failed, will be retried", "is-failed"],
  simulated: ["Demo payout", "is-demo"],
};

function statusChip(status) {
  const [text, cls] = PAY_STATUS[status] || ["Status unknown", "is-queued"];
  return el("span", { class: `fund-status ${cls}`, text });
}

const statusWords = (status) => (PAY_STATUS[status] ? PAY_STATUS[status][0].toLowerCase() : "sent");

// The backend already sends the reason as plain words ("no bank details", "below the Rs 100 minimum", a bank's error).
function skipText(reason) {
  const text = String(reason || "").replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Skipped";
}

// The live note says what is simulated (no money); the fixed label is the fallback for a note-less reply.
function poolCard(d, ctx, isAlive, onFund) {
  const pool = d.pool || {};
  const cfg = d.donations || {};
  const fund = cfg.pool_enabled
    ? button("Fund the pool", { variant: "secondary", onClick: () => supportSheet(ctx, isAlive, { kind: "pool" }, cfg, onFund) })
    : null;
  if (fund) fund.classList.add("fund-pool-btn");
  const showMeta = pool.collected_inr != null && pool.contributors != null;
  return el("section", { class: "card fund-pool", "aria-labelledby": "fund-pool-h" },
    el("p", { class: "fund-label", text: `Pool for ${d.period || "this period"}` }),
    el("p", { class: "fund-figure display-num", id: "fund-pool-h", text: rupees(d.pool_inr) }),
    showMeta ? el("p", { class: "fund-pool-meta",
      text: `${rupees(pool.collected_inr)} from ${plural(Number(pool.contributors) || 0, "supporter", "supporters")}` }) : null,
    fund,
    isDemoMode(d) ? el("p", { class: "fund-note" }, icon("info", 16), el("span", { text: d.note || DEMO_LABEL })) : null);
}

const isObj = (b) => !!b && typeof b === "object";

// One row per donor. Volume is one line per unit, biggest first; units are never added together.
// onSupport is a function when the viewer may support this donor, else null (the button is not shown).
function topRow(r, i, onSupport) {
  const volume = (Array.isArray(r.volume) ? r.volume : [])
    .filter((v) => Number(v.quantity) > 0)
    .sort((a, b) => Number(b.quantity) - Number(a.quantity));
  return el("li", { class: "fund-top-row" },
    el("span", { class: "fund-top-rank display-num", "aria-hidden": "true", text: String(i + 1) }),
    el("div", { class: "fund-top-body" },
      el("div", { class: "fund-top-head" },
        el("strong", { class: "fund-top-name", text: donorName(r.donor_sub, i) }),
        el("span", { class: "fund-level", text: r.level || "" })),
      volume.length ? el("ul", { class: "fund-top-vol", "aria-label": "Verified volume" },
        volume.map((v) => el("li", { text: `${qty(v.quantity, v.unit)} verified` }))) : null,
      Number(r.streak_weeks) > 0 ? el("span", { class: "fund-top-streak", text: `${r.streak_weeks} week streak` }) : null,
      Number(r.supporters) > 0 ? el("span", { class: "fund-top-supp",
        text: `${plural(r.supporters, "supporter", "supporters")}, ${rupees(r.supported_inr)} given` }) : null,
      onSupport ? el("div", { class: "fund-actions" }, button("Support", { onClick: onSupport })) : null),
    el("span", { class: "fund-top-pts display-num", text: `${r.points ?? 0} pts` }));
}

function topDonorsCard(d, ctx, isAlive, onDone) {
  const rows = Array.isArray(d.top_donors) ? d.top_donors : [];
  const needs = d.you && d.you.needs;
  const cfg = d.donations || {};
  const me = ctx.session ? ctx.session.sub : null;
  // Support needs donations enabled and a signed-in viewer, and never offers the viewer their own row.
  const canSupport = (r) => !!cfg.enabled && !!me && r.donor_sub !== me;
  const body = rows.length
    ? el("ol", { class: "fund-top-list" }, rows.map((r, i) => topRow(r, i, canSupport(r)
      ? () => supportSheet(ctx, isAlive, { kind: "donor", sub: r.donor_sub, name: donorName(r.donor_sub, i) }, cfg, onDone)
      : null)))
    : el("p", { class: "fund-muted", text: needs
      ? `No top donors yet. It takes ${plural(needs.lots, "verified lot", "verified lots")} to ${plural(needs.partners, "different receiver", "different receivers")}.`
      : "No top donors yet." });
  return el("section", { class: "card fund-role fund-top", "aria-labelledby": "fund-top-h" },
    el("h2", { class: "fund-h", id: "fund-top-h", text: "Top donors" }),
    body);
}

// Support one top donor (target.kind "donor") or fund the pool (kind "pool"). Both run the same flow:
// an order, Razorpay Checkout for a real order, then confirm. Every async step checks the page (isAlive)
// and this sheet (shown); a stale sheet never writes. One attempt makes one order: a retry reuses it.
function supportSheet(ctx, isAlive, target, cfg, onDone) {
  const pool = target.kind === "pool";
  const min = Number(cfg.min_inr) || 1;
  const max = Number(cfg.max_inr) || Infinity;
  const demo = cfg.mode === "demo";
  const title = pool ? "Fund the pool" : `Support ${target.name}`;
  let shown = true;
  let busy = false;
  let confirming = false; // true while confirmDonation is in flight; a dismissed checkout must not reset the button then
  let order = null; // the order from contribute() or donate()
  let orderKey = ""; // "amount|note" the order was made for; a changed amount or note makes a new order
  let waiting = null; // { o, p } after a real payment that is not confirmed yet; "Check again" retries it
  const live = () => isAlive() && shown;

  const amountIn = el("input", { class: "input", id: "fund-sup-amount", type: "text", inputmode: "numeric",
    autocomplete: "off", value: "500", min: String(min), max: Number.isFinite(max) ? String(max) : null,
    "aria-describedby": "fund-sup-hint" });
  const noteIn = el("input", { class: "input", id: "fund-sup-note", type: "text", autocomplete: "off",
    maxlength: "80" });
  const chips = PRESETS.map((p) => el("button", { class: "fund-chip", type: "button", "aria-pressed": "false",
    text: rupees(p), onclick: () => { amountIn.value = String(p); refresh(); } }));
  const hint = el("p", { class: "field-hint", id: "fund-sup-hint", text: Number.isFinite(max)
    ? `Between ${rupees(min)} and ${rupees(max)}, in whole rupees.`
    : `At least ${rupees(min)}, in whole rupees.` });
  const breakdown = el("p", { class: "fund-breakdown", "aria-live": "polite" });
  const err = el("p", { class: "field-error", role: "alert", hidden: true });
  const waitText = el("p", { class: "fund-wait", role: "status", hidden: true,
    text: "We received your payment and are confirming it. This can take a minute." });
  const payBtn = button(pool ? "Give" : "Donate", { variant: "primary", block: true, onClick: pay });
  const checkBtn = button("Check again", { variant: "primary", block: true, onClick: checkAgain });
  checkBtn.hidden = true;

  // The whole-rupee amount in range, or null.
  function amountNow() {
    const raw = amountIn.value.trim();
    const n = Number(raw);
    return /^\d+$/.test(raw) && n >= min && n <= max ? n : null;
  }

  function keyNow() {
    return `${amountIn.value.trim()}|${noteIn.value.trim()}`;
  }

  // An order only counts while the amount and note still match it.
  function orderNow() {
    return order && orderKey === keyNow() ? order : null;
  }

  function setLabel(text) {
    payBtn.querySelector(".btn-label").textContent = text;
  }

  function refresh() {
    const amt = amountNow();
    chips.forEach((c, i) => c.setAttribute("aria-pressed", String(amt === PRESETS[i])));
    if (amt == null) {
      breakdown.textContent = "Choose an amount to see where it goes.";
      setLabel(pool ? "Give" : "Donate");
      return;
    }
    breakdown.textContent = pool
      ? `You give ${rupees(amt)}. All of it goes into the pool, shared by donors.`
      : `You give ${rupees(amt)}. All of it reaches ${target.name}.`;
    const o = orderNow();
    const verb = pool ? "Give" : "Donate";
    setLabel(o ? (demo ? `Pay ${rupees(amt)} (simulated)` : `Pay ${rupees(amt)}`) : `${verb} ${rupees(amt)}`);
  }

  function idle() {
    busy = false;
    setLoading(payBtn, false);
    setLoading(checkBtn, false);
  }

  // While a real payment waits for confirmation the form is locked and "Check again" takes the place of the pay button.
  function showWaiting(on) {
    waitText.hidden = !on;
    payBtn.hidden = on;
    checkBtn.hidden = !on;
    amountIn.disabled = on;
    noteIn.disabled = on;
    chips.forEach((c) => { c.disabled = on; });
  }

  // Confirms the payment with the server, then thanks the donor and reloads the fund.
  async function confirm(o, p) {
    confirming = true;
    const req = { order_id: o.order_id, razorpay_payment_id: p.paymentId };
    if (p.signature) req.razorpay_signature = p.signature;
    const r = await ctx.api.confirmDonation(req);
    confirming = false;
    if (!isAlive()) return;
    if (!r.ok || !isObj(r.body)) {
      idle();
      if (!shown) return;
      if (p.real) {
        waiting = { o, p }; // keep the order and payment: the money has moved, so only the confirm is retried
        showWaiting(true);
        return;
      }
      setErr(err, errorOf(r, "We could not confirm the payment. Try again."));
      return;
    }
    waiting = null;
    const simulated = r.body.mode === "demo" || r.body.status === "simulated";
    const amount = r.body.amount_inr ?? o.amount_inr;
    idle();
    if (shown) handle.close();
    celebrate({ title: "Thank you",
      text: pool
        ? `${simulated ? "Simulated: " : ""}${rupees(amount)} is in the pool, shared by donors.`
        : `${simulated ? "Simulated: " : ""}${rupees(amount)} will reach ${target.name}.` });
    onDone();
  }

  // Opens Razorpay Checkout for an order. A success confirms; a failure shows its reason; a dismiss re-enables the button.
  async function openCheckout(o) {
    let Razorpay;
    try {
      Razorpay = await loadCheckout();
    } catch (e) {
      if (live()) {
        idle();
        setErr(err, CHECKOUT_ERR);
      }
      return;
    }
    if (!live()) return;
    // The button stays busy while the checkout is open; the handler or ondismiss ends the wait.
    const rzp = new Razorpay({
      key: o.key_id,
      order_id: o.order_id,
      amount: Number(o.amount_inr) * 100,
      currency: "INR",
      name: "PantryPass",
      description: title,
      theme: { color: CHECKOUT_COLOR },
      handler: (resp) => confirm(o, { real: true, paymentId: resp.razorpay_payment_id, signature: resp.razorpay_signature }),
      modal: { ondismiss: () => { if (live() && !confirming) idle(); } },
    });
    rzp.on("payment.failed", (resp) => {
      if (!live() || confirming) return;
      idle();
      setErr(err, (resp && resp.error && resp.error.description) || "The payment did not go through. Try again.");
    });
    rzp.open();
  }

  async function pay() {
    if (busy || waiting) return;
    const amt = amountNow();
    if (amt == null) {
      setErr(err, `Enter a whole amount from ${rupees(min)}${Number.isFinite(max) ? ` to ${rupees(max)}` : ""}.`);
      amountIn.focus();
      return;
    }
    busy = true;
    setLoading(payBtn, true);
    setErr(err, "");
    let o = orderNow();
    if (!o) {
      const key = keyNow();
      const note = noteIn.value.trim();
      const r = pool
        ? await ctx.api.contribute({ amount_inr: amt, note })
        : await ctx.api.donate({ donor_sub: target.sub, amount_inr: amt, note });
      if (!live()) return;
      if (!r.ok || !isObj(r.body) || !r.body.order_id) {
        idle();
        setErr(err, errorOf(r, pool ? "Could not start the payment just now." : "Could not start the donation just now."));
        return;
      }
      o = r.body;
      order = o;
      orderKey = key;
      refresh();
    }
    if (o.mode === "razorpay") {
      openCheckout(o);
      return;
    }
    // Demo mode: there is no checkout, so the payment is confirmed straight away with a made-up id.
    await confirm(o, { real: false, paymentId: `pay_demo_${Math.random().toString(36).slice(2, 10)}`, signature: null });
  }

  // Retries the confirm for a real payment that did not confirm yet. The same order and payment are used.
  function checkAgain() {
    if (busy || !waiting) return;
    busy = true;
    setLoading(checkBtn, true);
    setErr(err, "");
    confirm(waiting.o, waiting.p);
  }

  const handle = openSheet({
    title,
    body: el("div", { class: "fund-support" },
      el("div", { class: "field" },
        el("span", { class: "field-label", id: "fund-sup-presets", text: "Amount" }),
        el("div", { class: "fund-chips", role: "group", "aria-labelledby": "fund-sup-presets" }, chips)),
      el("div", { class: "field" },
        el("label", { class: "field-label", for: "fund-sup-amount", text: "Custom amount (rupees)" }), amountIn, hint),
      el("div", { class: "field" },
        el("label", { class: "field-label", for: "fund-sup-note", text: "Note (optional)" }), noteIn),
      err,
      breakdown,
      waitText,
      demo ? el("p", { class: "fund-demo-note" }, icon("info", 16), el("span", { text: DEMO_NOTICE })) : null),
    footer: el("div", { class: "fund-foot" }, payBtn, checkBtn),
    onClose: () => { shown = false; },
  });
  amountIn.addEventListener("input", refresh);
  noteIn.addEventListener("input", refresh);
  refresh();
}

// Donor: the donations others made to them (confirmed by PantryPass). Every rupee reaches them.
function receivedCard(ctx, isAlive) {
  const body = el("div", { class: "fund-received-body" }, el("p", { class: "fund-muted", text: LOADING }));
  const section = el("section", { class: "card fund-role fund-received", "aria-labelledby": "fund-received-h" },
    el("h2", { class: "fund-h", id: "fund-received-h", text: "Support you received" }),
    body);

  function receivedRow(p) {
    return el("li", {},
      el("strong", { class: "fund-list-amt", text: rupees(p.amount_inr) }),
      p.note ? el("span", { text: p.note }) : null,
      p.status === "simulated" ? el("span", { class: "fund-simpill", text: "Simulated" }) : null,
      el("span", { class: "fund-muted", text: dateOf(p.ts) }));
  }

  function draw(d) {
    const list = Array.isArray(d.received) ? d.received : [];
    clear(body);
    body.append(
      el("p", { class: "fund-progress", text: `${rupees(d.received_inr)} confirmed` }),
      el("p", { class: "fund-muted", text: "Every rupee reaches you. Razorpay pays it out to your bank details." }),
      list.length
        ? el("ul", { class: "fund-list", "aria-label": "Support you received" }, [
          ...list.slice(0, 3).map(receivedRow),
          list.length > 3 ? el("li", { class: "fund-muted", text: `and ${list.length - 3} earlier` }) : null])
        : el("p", { class: "fund-muted", text: "No support yet. It appears here when someone donates to you." }));
  }

  async function load() {
    clear(body);
    body.append(el("p", { class: "fund-muted", text: LOADING }));
    const res = await ctx.api.donations();
    if (!isAlive()) return;
    if (!res.ok || !isObj(res.body)) {
      clear(body);
      body.append(el("p", { class: "fund-muted", role: "status", text: "Support is not available right now." }),
        button("Try again", { onClick: load }));
      return;
    }
    draw(res.body);
  }

  load();
  return section;
}

// Donor, not yet eligible: no share numbers, only the progress towards the minimum.
function lockedCard(you) {
  const need = you.needs || {};
  return el("section", { class: "card fund-role fund-share fund-locked" },
    el("h2", { class: "fund-h", text: "Your share" }),
    el("p", { class: "fund-progress",
      text: `${you.verified_lots ?? 0} of ${need.lots ?? 0} verified lots, ${you.partners ?? 0} of ${need.partners ?? 0} different receivers` }),
    el("p", { class: "fund-muted", text: `Your share opens once you reach both numbers. You have ${you.points ?? 0} points so far.` }));
}

function shareCard(d, cap) {
  const you = d.you;
  if (!you) {
    return el("section", { class: "card fund-role" },
      el("h2", { class: "fund-h", text: "Your share" }),
      el("p", { class: "fund-muted", text: "No points yet this period. Points come from confirmed handoffs." }));
  }
  if (you.eligible === false) return lockedCard(you);
  const share = clampPct(you.share_pct);
  return el("section", { class: "card fund-role fund-share" },
    el("h2", { class: "fund-h", text: "Your share" }),
    el("div", { class: "fund-stats" },
      stat(String(you.points ?? 0), "points"),
      stat(percent(you.share_pct), "of the pool"),
      stat(rupees(you.estimated_inr), "estimated")),
    el("div", { class: "fund-bar", role: "progressbar", "aria-label": "Your share of the pool",
      "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(share) },
    el("span", { class: "fund-bar-fill", style: `width: ${share}%` })),
    you.capped ? el("p", { class: "fund-cap", text: `Capped at ${cap}% of the pool so no one donor takes it all.` }) : null,
    you.capped ? el("p", { class: "fund-muted", text: "You earned more than the cap allows, so the rest went to other donors." }) : null);
}

function allocationCard(d) {
  const rows = d.allocations || [];
  const sumShare = Math.round(rows.reduce((n, r) => n + (Number(r.share_pct) || 0), 0) * 10) / 10;
  const sumInr = rows.reduce((n, r) => n + (Math.round(Number(r.estimated_inr) || 0)), 0);
  const peers = d.simulated_peers ?? rows.filter((r) => r.simulated).length;
  const body = rows.length
    ? rows.map((r, i) => el("tr", { class: [r.capped && "is-capped", r.simulated && "is-simulated"].filter(Boolean).join(" ") || null },
      el("th", { scope: "row", class: "fund-td-name" },
        el("span", { class: "fund-td-label", text: r.simulated ? r.name : donorName(r.donor_sub, i) }),
        r.simulated ? el("span", { class: "fund-simpill", text: "simulated" }) : null,
        r.capped ? el("span", { class: "fund-capped", text: "Capped" }) : null),
      el("td", { class: "fund-num", text: String(r.points ?? 0) }),
      el("td", { class: "fund-num", text: percent(r.share_pct) }),
      el("td", { class: "fund-num", text: rupees(r.estimated_inr) })))
    : [el("tr", {}, el("td", { colspan: "4", class: "fund-muted", text: "No donors have points yet." }))];
  return el("section", { class: "card fund-role fund-alloc" },
    el("h2", { class: "fund-h", text: "Allocations" }),
    el("p", { class: "fund-muted", text: `${d.donors ?? rows.length} donors, ${peers} of them simulated, share ${d.total_points ?? 0} points this period.` }),
    el("div", { class: "fund-table-wrap" },
      el("table", { class: "fund-table" },
        el("caption", { class: "fund-sr", text: "Estimated allocation of the pool by donor" }),
        el("thead", {}, el("tr", {},
          el("th", { scope: "col", text: "Donor" }),
          el("th", { scope: "col", class: "fund-num", text: "Points" }),
          el("th", { scope: "col", class: "fund-num", text: "Share" }),
          el("th", { scope: "col", class: "fund-num", text: "Estimate" }))),
        el("tbody", {}, body),
        rows.length ? el("tfoot", {}, el("tr", { class: "fund-total" },
          el("th", { scope: "row", text: "Total" }),
          el("td", { class: "fund-num", text: String(d.total_points ?? 0) }),
          el("td", { class: "fund-num", text: percent(sumShare) }),
          el("td", { class: "fund-num", text: rupees(sumInr) }))) : null)));
}

function rulesCard(rules) {
  return el("section", { class: "fund-rules" },
    el("h2", { class: "fund-h", text: "The rules" }),
    el("ol", { class: "fund-rule-list" }, (rules || []).map((r) => el("li", { text: r }))));
}

function receiverCard() {
  return el("section", { class: "card fund-role fund-receiver" },
    el("h2", { class: "fund-h", text: "Your part" }),
    el("p", { class: "fund-muted", text: RECEIVER_NOTE }));
}

// One label and value pair. Values are set as text only.
function kv(label, value) {
  return el("div", { class: "fund-kv-row" },
    el("dt", { text: label }),
    el("dd", { text: value == null ? "" : String(value) }));
}

// The payouts to one account, newest first as the server sends them. The UTR is shown once a payout is paid.
function payoutList(list) {
  if (!list.length) return el("p", { class: "fund-muted", text: "No payouts yet." });
  return el("ul", { class: "fund-list", "aria-label": "Payouts to your account" }, list.map((p) =>
    el("li", {},
      el("strong", { class: "fund-list-amt", text: rupees(p.amount_inr) }),
      statusChip(p.status),
      p.status === "processed" && p.utr ? el("span", { class: "fund-muted", text: `UTR ${p.utr}` }) : null,
      el("span", { class: "fund-muted", text: dateOf(p.ts) }))));
}

// Donor: the bank details they gave, masked, with a way to change them, and the payouts to that account.
// The account number is typed into the form once; it is never kept in a variable, attribute or storage.
function donorPayoutCard(ctx, isAlive) {
  const body = el("div", { class: "fund-payout-body" }, el("p", { class: "fund-muted", text: LOADING }));
  const section = el("section", { class: "card fund-role fund-payout", "aria-labelledby": "fund-payout-h" },
    el("h2", { class: "fund-h", id: "fund-payout-h", text: "Your payout details" }),
    body);
  let profile = null;

  function details(p) {
    return [
      el("dl", { class: "fund-kv" },
        kv("Name on the account", p.holder_name),
        kv("Account", p.account),
        kv("IFSC", p.ifsc),
        kv("UPI", p.upi || "Not set")),
      el("div", { class: "fund-actions" },
        button("Change details", { onClick: () => form(p) })),
      el("h3", { class: "fund-sub", text: "Payouts to your account" }),
      payoutList(Array.isArray(p.payments) ? p.payments : []),
    ];
  }

  // Blank form for a new profile; prefilled (except the account number and UPI id) when changing one.
  function form(prefill) {
    clear(body);
    let busy = false;
    const holder = el("input", { class: "input", id: "fund-pay-holder", type: "text", autocomplete: "off",
      value: prefill ? prefill.holder_name || "" : "", required: true });
    const account = el("input", { class: "input", id: "fund-pay-account", type: "text", inputmode: "numeric",
      autocomplete: "off", required: true, "aria-describedby": "fund-pay-note" });
    const ifsc = el("input", { class: "input", id: "fund-pay-ifsc", type: "text", autocomplete: "off",
      autocapitalize: "characters", value: prefill ? prefill.ifsc || "" : "", required: true });
    // The server only returns a masked UPI id, which is not a valid one to send back, so it is never prefilled.
    const upi = el("input", { class: "input", id: "fund-pay-upi", type: "text", autocomplete: "off",
      placeholder: prefill && prefill.upi ? `Currently ${prefill.upi}. Type it again to keep it.` : "" });
    const err = el("p", { class: "field-error", role: "alert", hidden: true });
    const saveBtn = button("Save details", { variant: "primary", block: true });
    saveBtn.type = "submit"; // so Enter in any field saves; the form's onsubmit runs save()

    async function save() {
      if (busy) return;
      setErr(err, "");
      busy = true;
      setLoading(saveBtn, true);
      let r;
      try {
        r = await ctx.api.savePayoutProfile({
          holder_name: holder.value.trim(),
          account_number: account.value.replace(/\s+/g, ""),
          ifsc: ifsc.value.trim(),
          upi: upi.value.trim(),
        });
      } finally {
        busy = false;
        setLoading(saveBtn, false);
      }
      if (!isAlive()) return;
      if (r.ok && r.body && typeof r.body === "object") {
        account.value = ""; // the typed number is not kept once it is saved
        profile = r.body;
        show(profile);
        toast("Payout details saved.", "success");
        return;
      }
      setErr(err, errorOf(r, "Could not save your details just now."));
    }

    body.append(
      el("form", { class: "fund-payout-form", novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
        el("div", { class: "field" },
          el("label", { class: "field-label", for: "fund-pay-holder", text: "Name on the account" }), holder),
        el("div", { class: "field" },
          el("label", { class: "field-label", for: "fund-pay-account", text: "Account number" }), account),
        el("div", { class: "field" },
          el("label", { class: "field-label", for: "fund-pay-ifsc", text: "IFSC" }), ifsc),
        el("div", { class: "field" },
          el("label", { class: "field-label", for: "fund-pay-upi", text: "UPI id (optional)" }), upi),
        err,
        el("p", { class: "field-hint", id: "fund-pay-note",
          text: "Your account number is stored encrypted and is never shown to the coordinator. Razorpay pays your share to these details." }),
        saveBtn),
      ...(profile && profile.configured ? [button("Cancel", { variant: "ghost", onClick: () => show(profile) })] : []));
  }

  function show(p) {
    clear(body);
    if (p.configured) body.append(...details(p));
    else form(null);
  }

  async function load() {
    clear(body);
    body.append(el("p", { class: "fund-muted", text: LOADING }));
    const res = await ctx.api.payoutProfile();
    if (!isAlive()) return;
    if (res.ok && res.body && typeof res.body === "object") {
      profile = res.body;
      show(profile);
      return;
    }
    clear(body);
    body.append(el("p", { class: "fund-muted", role: "status", text: "Payout details are not available right now." }),
      button("Try again", { onClick: load }));
  }

  load();
  return section;
}

// The payout status of the latest payment in a list (by time), or null when there is none.
function latestOf(list) {
  return list.reduce((best, p) => (!best || Number(p.ts) > Number(best.ts) ? p : best), null);
}

// Coordinator: one row per donor. Amounts, the latest payment's status and whether bank details are on file.
// Account numbers are never shown here; the bank column only says whether details are saved.
function payoutRow(row, i) {
  const profile = row.profile || {};
  const latest = latestOf(Array.isArray(row.payments) ? row.payments : []);
  return el("tr", {},
    el("th", { scope: "row", text: donorName(row.donor_sub, i) }),
    el("td", { class: "fund-num", text: rupees(row.estimated_inr) }),
    el("td", { class: "fund-num", text: rupees(row.direct_inr) }),
    el("td", { class: "fund-num", text: rupees(row.owed_inr) }),
    el("td", { class: "fund-num", text: rupees(row.paid_inr) }),
    el("td", {}, latest ? statusChip(latest.status) : el("span", { class: "fund-muted", text: "None yet" })),
    el("td", { text: profile.configured ? `Saved, account ${profile.account || ""}`.trim() : "No details yet" }));
}

// Coordinator: the ledger in words, one button that pays every donor who is due, and the table of who is owed what.
// The run result sits outside the table body, so reloading the table does not clear it.
function payoutsCard(ctx, isAlive) {
  const runErr = el("p", { class: "field-error", role: "alert", hidden: true });
  const result = el("div", { class: "fund-run-result", hidden: true });
  const body = el("div", { class: "fund-payouts-body" }, el("p", { class: "fund-muted", text: LOADING }));
  const section = el("section", { class: "card fund-role fund-payouts", "aria-labelledby": "fund-payouts-h" },
    el("h2", { class: "fund-h", id: "fund-payouts-h", text: "Payouts" }),
    runErr,
    result,
    body);
  let busy = false;
  let runBtn = null;
  let pos = {}; // donor sub -> row position, for names in the run result

  const nameOf = (sub) => donorName(sub, pos[sub] ?? 0);

  function showResult(b) {
    const paid = Array.isArray(b.paid) ? b.paid : [];
    const skipped = Array.isArray(b.skipped) ? b.skipped : [];
    clear(result);
    result.append(...[
      el("p", { class: "fund-progress", text: paid.length
        ? `${plural(paid.length, "payout", "payouts")} started.`
        : "No payout was due, so none was started." }),
      paid.length ? el("ul", { class: "fund-list", "aria-label": "Payouts started" }, paid.map((p) =>
        el("li", {}, el("span", { text: `${nameOf(p.donor_sub)}: ${rupees(p.amount_inr)} ${statusWords(p.status)}` })))) : null,
      skipped.length ? el("ul", { class: "fund-list", "aria-label": "Skipped" }, skipped.map((s) =>
        el("li", {}, el("span", { text: `${nameOf(s.donor_sub)}: ${skipText(s.reason)}` })))) : null,
      b.more ? el("p", { class: "fund-muted", text: "More donors are waiting. Run payouts again to pay the rest." }) : null].filter(Boolean));
    result.hidden = false;
  }

  async function runAll() {
    if (busy) return;
    busy = true;
    setLoading(runBtn, true);
    setErr(runErr, "");
    const r = await ctx.api.runPayouts();
    busy = false;
    if (!isAlive()) return;
    setLoading(runBtn, false);
    if (!r.ok || !isObj(r.body)) {
      setErr(runErr, errorOf(r, "Could not run payouts just now."));
      return;
    }
    showResult(r.body);
    load();
  }

  function draw(d) {
    const rows = Array.isArray(d.payouts) ? d.payouts : [];
    const ledger = d.ledger || {};
    const due = rows.some((r) => r.can_pay);
    pos = {};
    rows.forEach((r, i) => { pos[r.donor_sub] = i; });
    runBtn = button("Run payouts", { variant: "primary", disabled: !due, onClick: runAll });
    if (!due) runBtn.setAttribute("aria-describedby", "fund-run-hint");
    clear(body);
    body.append(...[
      el("p", { class: "fund-progress", text: `Collected ${rupees(ledger.collected_inr)}, owed to donors ${rupees(ledger.owed_inr)}, paid ${rupees(ledger.paid_inr)}. PantryPass keeps nothing.` }),
      el("p", { class: "fund-muted", text: `${d.period || "This period"}: pool ${rupees(d.pool_inr)}.` }),
      d.note ? el("p", { class: "fund-muted", text: d.note }) : null,
      el("div", { class: "fund-actions" }, runBtn),
      due ? null : el("p", { class: "fund-muted", id: "fund-run-hint",
        text: "No payout is due yet. A donor is paid once they have bank details and an amount owed." }),
      el("div", { class: "fund-table-wrap" },
        el("table", { class: "fund-table" },
          el("caption", { class: "fund-sr", text: "Payouts by donor" }),
          el("thead", {}, el("tr", {},
            el("th", { scope: "col", text: "Donor" }),
            el("th", { scope: "col", class: "fund-num", text: "Estimate" }),
            el("th", { scope: "col", class: "fund-num", text: "Direct donations" }),
            el("th", { scope: "col", class: "fund-num", text: "Owed" }),
            el("th", { scope: "col", class: "fund-num", text: "Paid so far" }),
            el("th", { scope: "col", text: "Latest payment" }),
            el("th", { scope: "col", text: "Bank details" }))),
          el("tbody", {}, rows.length
            ? rows.map((r, i) => payoutRow(r, i))
            : [el("tr", {}, el("td", { colspan: String(PAYOUT_COLS), class: "fund-muted", text: "No donors have points yet." }))])))].filter(Boolean));
  }

  async function load() {
    clear(body);
    body.append(el("p", { class: "fund-muted", text: LOADING }));
    const res = await ctx.api.payouts();
    if (!isAlive()) return;
    if (!res.ok || !res.body || typeof res.body !== "object") {
      clear(body);
      body.append(el("p", { class: "fund-muted", role: "status", text: "Could not load payouts just now." }),
        button("Try again", { onClick: load }));
      return;
    }
    draw(res.body);
  }

  load();
  return section;
}

export function render(container, ctx) {
  let alive = true;
  const isAlive = () => alive;
  const role = ctx.session ? ctx.session.role : null;
  const pill = el("span", { class: "fund-pill", text: "Demo pool", hidden: true });
  const poolSlot = el("div", { class: "fund-slot" }, skeleton("fund-pool-skel"));
  const topSlot = el("div", { class: "fund-slot" });
  const stepsSlot = el("div", { class: "fund-slot" }, stepsList(null));
  const roleSlot = el("div", { class: "fund-slot" }, skeleton("fund-role-skel"));
  const extraSlot = el("div", { class: "fund-slot" });
  const rulesSlot = el("div", { class: "fund-slot" });

  container.append(el("div", { class: "stack fund-page" },
    el("header", { class: "fund-head" },
      el("h1", { class: "page-title display", text: "The fund" }),
      pill),
    el("p", { class: "fund-model", text: MODEL }),
    poolSlot,
    topSlot,
    el("section", { class: "fund-steps-wrap" },
      el("h2", { class: "fund-h", text: "How points turn into money" }),
      stepsSlot),
    roleSlot,
    extraSlot,
    rulesSlot,
    el("p", { class: "about-note", text: FOOTNOTE })));

  function skeleton(cls) {
    return el("div", { class: `card skeleton-card fund-skel ${cls}`, "aria-hidden": "true" },
      el("div", { class: "skeleton skeleton-line" }),
      el("div", { class: "skeleton skeleton-line" }));
  }

  function failed() {
    clear(poolSlot);
    clear(topSlot);
    clear(roleSlot);
    clear(extraSlot);
    pill.hidden = true;
    poolSlot.append(el("div", { class: "card fund-error", role: "status" },
      el("p", { class: "fund-muted", text: "Could not load the fund just now." }),
      button("Try again", { onClick: load })));
  }

  function draw(d) {
    const cap = d.cap_pct ?? 30;
    clear(poolSlot);
    clear(topSlot);
    clear(stepsSlot);
    clear(roleSlot);
    clear(extraSlot);
    clear(rulesSlot);
    pill.hidden = !isDemoMode(d);
    poolSlot.append(poolCard(d, ctx, isAlive, load));
    topSlot.append(topDonorsCard(d, ctx, isAlive, load));
    stepsSlot.append(stepsList(d.you && d.you.needs));
    if (role === "coordinator") roleSlot.append(allocationCard(d));
    else if (role === "receiver") roleSlot.append(receiverCard());
    else roleSlot.append(shareCard(d, cap));
    if (role === "donor") extraSlot.append(donorPayoutCard(ctx, isAlive), receivedCard(ctx, isAlive));
    if (role === "coordinator") extraSlot.append(payoutsCard(ctx, isAlive));
    rulesSlot.append(rulesCard(d.rules));
  }

  async function load() {
    clear(poolSlot);
    clear(roleSlot);
    poolSlot.append(skeleton("fund-pool-skel"));
    roleSlot.append(skeleton("fund-role-skel"));
    const res = await ctx.api.fund();
    if (!alive) return;
    if (!res.ok || !res.body || typeof res.body !== "object") { failed(); return; }
    draw(res.body);
  }

  load();
  return () => { alive = false; };
}
