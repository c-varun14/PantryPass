// The fund (#/fund): how the donor incentive pool works, and what it means for the signed-in role.
// Every signed-in role sees the same page: the model, the pool, the top donors, three steps, then one role block.
// GET /fund is the source of the numbers. The pool is a demo simulation: no money moves.
import { el, clear } from "../dom.js";
import { icon } from "../icons.js";
import { button, celebrate, openSheet, setLoading, toast } from "../ui.js";
import { qty } from "../logic.js";
import { loadCheckout } from "../razorpay.js";
import { displayName } from "./welcome.js";

const MODEL = "Sponsors fund a monthly pool, shared among donors by trust points. Points come only from handoffs the receiver verified, and a bigger verified amount earns more, up to a cap. Supporters can also donate directly to top donors, and a coordinator pays everyone out to the bank details they provide.";

const STEPS = [
  ["Donate food and hand it over verified", "Offer a lot, then hand it over with a pickup code."],
  ["The receiver confirms what arrived in person", "Counting happens at the handoff, and the receiver enters the pickup code. Only verified amounts earn points."],
];

const RECEIVER_NOTE = "Receivers do not earn from the pool. Your confirmations are what make payouts trustworthy.";
const FOOTNOTE = "Estimates only. In this demo no money moves; in a live setup a coordinator makes each transfer and records its reference.";
const DEMO_LABEL = "Demo pool: no money moves in this demo";
const REVEAL_MS = 30000; // bank details shown to a coordinator hide again after this long
const LOADING = "Loading";
const PAYOUT_COLS = 6; // donor, estimate, direct donations, owed, paid so far, bank details

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const rupees = (n) => INR.format(Math.round(Number(n) || 0));
const percent = (n) => `${Number(n || 0).toFixed(1).replace(/\.0$/, "")}%`;
const clampPct = (n) => Math.min(100, Math.max(0, Number(n) || 0));
const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;

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
    `To share the pool you need ${lots}. Points add up over the period, and so does your share of the pool.`];
  return el("ol", { class: "fund-steps" }, [...STEPS, third].map(stepNode));
}

// The live note says what is simulated (peers, no money); the fixed label is the fallback for a note-less reply.
function poolCard(d) {
  return el("section", { class: "card fund-pool", "aria-labelledby": "fund-pool-h" },
    el("p", { class: "fund-label", text: `Pool for ${d.period || "this period"}` }),
    el("p", { class: "fund-figure display-num", id: "fund-pool-h", text: rupees(d.pool_inr) }),
    d.demo ? el("p", { class: "fund-note" }, icon("info", 16), el("span", { text: d.note || DEMO_LABEL })) : null);
}

const isObj = (b) => !!b && typeof b === "object";
const PRESETS = [100, 500, 1000];
const DEMO_NOTICE = "Simulated payment: nothing is charged and no money moves. Real payments switch on when the payment gateway is connected.";
const CHECKOUT_ERR = "Could not open the payment window. Check your connection and try again.";

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
      ? () => supportSheet(ctx, isAlive, { sub: r.donor_sub, name: donorName(r.donor_sub, i) }, cfg, onDone)
      : null)))
    : el("p", { class: "fund-muted", text: needs
      ? `No top donors yet. It takes ${plural(needs.lots, "verified lot", "verified lots")} to ${plural(needs.partners, "different receiver", "different receivers")}.`
      : "No top donors yet." });
  return el("section", { class: "card fund-role fund-top", "aria-labelledby": "fund-top-h" },
    el("h2", { class: "fund-h", id: "fund-top-h", text: "Top donors" }),
    body);
}

// Support one top donor. The fee and net use the backend's integer maths: fee = floor(amount * fee_pct / 100).
// Every async step checks the page (isAlive) and this sheet (shown); a stale sheet never writes.
function supportSheet(ctx, isAlive, target, cfg, onDone) {
  const min = Number(cfg.min_inr) || 1;
  const max = Number(cfg.max_inr) || Infinity;
  const feePct = Number(cfg.fee_pct) || 0;
  const demo = cfg.mode !== "razorpay";
  let shown = true;
  let busy = false;
  let order = null; // the donation order from donate()
  let orderKey = ""; // "amount|note" the order was made for; a changed amount or note makes a new order
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
  const payBtn = button("Donate", { variant: "primary", block: true, onClick: pay });

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
      setLabel("Donate");
      return;
    }
    const fee = Math.floor(amt * feePct / 100);
    breakdown.textContent = `You give ${rupees(amt)}. Platform fee ${percent(feePct)} (${rupees(fee)}). ${rupees(amt - fee)} reaches ${target.name}.`;
    const o = orderNow();
    setLabel(o ? (demo ? `Pay ${rupees(amt)} (simulated)` : `Pay ${rupees(amt)}`) : `Donate ${rupees(amt)}`);
  }

  function idle() {
    busy = false;
    setLoading(payBtn, false);
  }

  // Confirms the payment with the server, then thanks the donor and reloads the fund.
  async function confirm(o, paymentId, signature) {
    const req = { order_id: o.order_id, razorpay_payment_id: paymentId };
    if (signature) req.razorpay_signature = signature;
    const r = await ctx.api.confirmDonation(req);
    if (!isAlive()) return;
    if (!r.ok || !isObj(r.body)) {
      if (shown) {
        idle();
        setErr(err, errorOf(r, "We could not confirm the payment. Try again."));
      }
      return;
    }
    const simulated = r.body.mode === "demo" || r.body.status === "simulated";
    idle();
    if (shown) handle.close();
    celebrate({ title: "Thank you",
      text: `${simulated ? "Simulated: " : ""}${rupees(r.body.net_inr)} will reach ${target.name}.` });
    onDone();
  }

  async function pay() {
    if (busy) return;
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
      const r = await ctx.api.donate({ donor_sub: target.sub, amount_inr: amt, note: noteIn.value.trim() });
      if (!live()) return;
      if (!r.ok || !isObj(r.body) || !r.body.order_id) {
        idle();
        setErr(err, errorOf(r, "Could not start the donation just now."));
        return;
      }
      o = r.body;
      order = o;
      orderKey = key;
      refresh();
    }
    if (o.mode === "razorpay") {
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
      new Razorpay({
        key: o.key_id,
        order_id: o.order_id,
        amount: o.amount_inr * 100,
        currency: "INR",
        name: "PantryPass",
        description: `Support ${target.name}`,
        handler: (resp) => confirm(o, resp.razorpay_payment_id, resp.razorpay_signature),
        modal: { ondismiss: () => { if (live()) idle(); } },
      }).open();
      return;
    }
    // Demo mode: there is no checkout, so the payment is confirmed straight away with a made-up id.
    await confirm(o, `pay_demo_${Math.random().toString(36).slice(2, 10)}`, null);
  }

  const handle = openSheet({
    title: `Support ${target.name}`,
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
      demo ? el("p", { class: "fund-demo-note" }, icon("info", 16), el("span", { text: DEMO_NOTICE })) : null),
    footer: payBtn,
    onClose: () => { shown = false; },
  });
  amountIn.addEventListener("input", refresh);
  noteIn.addEventListener("input", refresh);
  refresh();
}

// Donor: the donations others made to them (confirmed by PantryPass) and the fee note. Shown under the payout details.
function receivedCard(ctx, isAlive) {
  const body = el("div", { class: "fund-received-body" }, el("p", { class: "fund-muted", text: LOADING }));
  const section = el("section", { class: "card fund-role fund-received", "aria-labelledby": "fund-received-h" },
    el("h2", { class: "fund-h", id: "fund-received-h", text: "Support you received" }),
    body);

  function receivedRow(p) {
    return el("li", {},
      el("strong", { class: "fund-list-amt", text: `${rupees(p.net_inr)} after the fee` }),
      p.note ? el("span", { text: p.note }) : null,
      p.status === "simulated" ? el("span", { class: "fund-simpill", text: "Simulated" }) : null,
      el("span", { class: "fund-muted", text: dateOf(p.ts) }));
  }

  function draw(d) {
    const list = Array.isArray(d.received) ? d.received : [];
    clear(body);
    body.append(
      el("p", { class: "fund-progress", text: `${rupees(d.received_inr)} confirmed` }),
      el("p", { class: "fund-muted", text: `Platform fee ${percent(d.fee_pct)} is kept on each donation. A coordinator transfers confirmed support to your bank details.` }),
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

// Donor: the bank details they gave, masked, with a way to change them, and the transfers recorded so far.
// The account number is typed into the form once; it is never kept in a variable, attribute or storage.
function donorPayoutCard(ctx, isAlive) {
  const body = el("div", { class: "fund-payout-body" }, el("p", { class: "fund-muted", text: LOADING }));
  const section = el("section", { class: "card fund-role fund-payout", "aria-labelledby": "fund-payout-h" },
    el("h2", { class: "fund-h", id: "fund-payout-h", text: "Your payout details" }),
    body);
  let profile = null;

  function transfers(list) {
    if (!list.length) return el("p", { class: "fund-muted", text: "No transfers recorded yet." });
    return el("ul", { class: "fund-list", "aria-label": "Transfers recorded by the coordinator" }, list.map((p) =>
      el("li", {},
        el("strong", { class: "fund-list-amt", text: rupees(p.amount_inr) }),
        el("span", { text: p.reference || "" }),
        el("span", { class: "fund-muted", text: dateOf(p.ts) }))));
  }

  function details(p) {
    return [
      el("dl", { class: "fund-kv" },
        kv("Name on the account", p.holder_name),
        kv("Account", p.account),
        kv("IFSC", p.ifsc),
        kv("UPI", p.upi || "Not set")),
      el("div", { class: "fund-actions" },
        button("Change details", { onClick: () => form(p) })),
      el("h3", { class: "fund-sub", text: "Transfers recorded by the coordinator" }),
      transfers(Array.isArray(p.payments) ? p.payments : []),
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
          text: "Your account number is encrypted and only shown to a coordinator when they make your transfer. PantryPass does not move money itself." }),
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

// Coordinator: what each donor is estimated to earn, what has been paid, and the bank details status.
// Bank details are only fetched on "Show bank details" and hide again after REVEAL_MS or on "Hide".
function payoutRow(row, i, ctx, isAlive) {
  const profile = row.profile || {};
  const name = donorName(row.donor_sub, i);
  let paid = Number(row.paid_inr) || 0;
  let busy = false;
  let hideTimer = null;

  const rowErr = el("p", { class: "field-error", role: "alert", hidden: true });
  const reveal = el("div", { class: "fund-reveal", hidden: true });
  const paidCell = el("td", { class: "fund-num", text: rupees(paid) });

  function hide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    clear(reveal);
    reveal.hidden = true;
  }

  async function showDetails() {
    if (busy) return;
    busy = true;
    setLoading(showBtn, true);
    setErr(rowErr, "");
    let r;
    try {
      r = await ctx.api.payoutDetails(row.donor_sub);
    } finally {
      busy = false;
      setLoading(showBtn, false);
    }
    if (!isAlive()) return;
    if (!r.ok || !r.body || typeof r.body !== "object") {
      setErr(rowErr, errorOf(r, "Could not load these bank details."));
      return;
    }
    const b = r.body;
    clear(reveal);
    reveal.append(
      el("dl", { class: "fund-kv" },
        kv("Name on the account", b.holder_name),
        kv("Account", b.account_number),
        kv("IFSC", b.ifsc),
        kv("UPI", b.upi || "Not set")),
      el("div", { class: "fund-actions" }, button("Hide", { variant: "ghost", onClick: hide })));
    reveal.hidden = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (isAlive()) hide(); }, REVEAL_MS);
  }

  const showBtn = profile.configured ? button("Show bank details", { onClick: showDetails }) : null;
  const bankCell = el("td", {},
    el("div", { class: "fund-payout-status" },
      el("span", { text: profile.configured ? `Account ${profile.account || "saved"}` : "No details yet" }),
      showBtn));

  // Record a transfer, then update this row's paid total from the reply's payments.
  const amountId = `pay-amount-${i}`;
  const refId = `pay-ref-${i}`;
  const amountIn = el("input", { class: "input", id: amountId, type: "text", inputmode: "numeric", autocomplete: "off" });
  const refIn = el("input", { class: "input", id: refId, type: "text", autocomplete: "off" });
  const formErr = el("p", { class: "field-error", role: "alert", hidden: true });
  const recBtn = button("Record transfer", { variant: "secondary", onClick: record });

  async function record() {
    if (busy) return;
    const amount = amountIn.value.trim();
    const reference = refIn.value.trim();
    if (!/^\d+$/.test(amount) || Number(amount) <= 0) {
      setErr(formErr, "Enter the amount in whole rupees.");
      amountIn.focus();
      return;
    }
    if (!reference) {
      setErr(formErr, "Enter the bank reference for this transfer.");
      refIn.focus();
      return;
    }
    busy = true;
    setLoading(recBtn, true);
    setErr(formErr, "");
    let r;
    try {
      r = await ctx.api.recordTransfer(row.donor_sub, { amount_inr: Number(amount), reference });
    } finally {
      busy = false;
      setLoading(recBtn, false);
    }
    if (!isAlive()) return;
    if (!r.ok || !r.body || !Array.isArray(r.body.payments)) {
      setErr(formErr, errorOf(r, "Could not record the transfer."));
      return;
    }
    paid = r.body.payments.reduce((n, p) => n + (Number(p.amount_inr) || 0), 0);
    paidCell.textContent = rupees(paid);
    amountIn.value = "";
    refIn.value = "";
    toast("Transfer recorded.", "success");
  }

  const tr = el("tr", {},
    el("th", { scope: "row", text: name }),
    el("td", { class: "fund-num", text: rupees(row.estimated_inr) }),
    el("td", { class: "fund-num", text: rupees(row.direct_inr) }),
    el("td", { class: "fund-num", text: rupees(row.owed_inr) }),
    paidCell,
    bankCell);
  const detail = el("tr", { class: "fund-payout-detail" },
    el("td", { colspan: String(PAYOUT_COLS) },
      rowErr,
      reveal,
      el("div", { class: "fund-transfer" },
        el("div", { class: "field" },
          el("label", { class: "field-label", for: amountId, text: "Amount (rupees)" }), amountIn),
        el("div", { class: "field" },
          el("label", { class: "field-label", for: refId, text: "Bank reference" }), refIn),
        recBtn,
        formErr)));
  return [tr, detail];
}

function payoutsCard(ctx, isAlive) {
  const body = el("div", { class: "fund-payouts-body" }, el("p", { class: "fund-muted", text: LOADING }));
  const section = el("section", { class: "card fund-role fund-payouts", "aria-labelledby": "fund-payouts-h" },
    el("h2", { class: "fund-h", id: "fund-payouts-h", text: "Payouts" }),
    body);

  function draw(d) {
    const rows = Array.isArray(d.payouts) ? d.payouts : [];
    clear(body);
    body.append(
      el("p", { class: "fund-muted", text: `${d.period || "This period"}: pool ${rupees(d.pool_inr)}.` }),
      d.note ? el("p", { class: "fund-muted", text: d.note }) : null,
      el("div", { class: "fund-table-wrap" },
        el("table", { class: "fund-table" },
          el("caption", { class: "fund-sr", text: "Payouts by donor" }),
          el("thead", {}, el("tr", {},
            el("th", { scope: "col", text: "Donor" }),
            el("th", { scope: "col", class: "fund-num", text: "Estimate" }),
            el("th", { scope: "col", class: "fund-num", text: "Direct donations" }),
            el("th", { scope: "col", class: "fund-num", text: "Owed" }),
            el("th", { scope: "col", class: "fund-num", text: "Paid so far" }),
            el("th", { scope: "col", text: "Bank details" }))),
          el("tbody", {}, rows.length
            ? rows.flatMap((r, i) => payoutRow(r, i, ctx, isAlive))
            : [el("tr", {}, el("td", { colspan: String(PAYOUT_COLS), class: "fund-muted", text: "No donors have points yet." }))]))));
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
  const poolSlot = el("div", { class: "fund-slot" }, skeleton("fund-pool-skel"));
  const topSlot = el("div", { class: "fund-slot" });
  const stepsSlot = el("div", { class: "fund-slot" }, stepsList(null));
  const roleSlot = el("div", { class: "fund-slot" }, skeleton("fund-role-skel"));
  const extraSlot = el("div", { class: "fund-slot" });
  const rulesSlot = el("div", { class: "fund-slot" });

  container.append(el("div", { class: "stack fund-page" },
    el("header", { class: "fund-head" },
      el("h1", { class: "page-title display", text: "The fund" }),
      el("span", { class: "fund-pill", text: "Demo pool" })),
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
    poolSlot.append(poolCard(d));
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
