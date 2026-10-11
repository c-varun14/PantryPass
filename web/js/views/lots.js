// Lots home: one dark hero card (trust level, or disputes and impact for the coordinator), the greeting,
// then the "To do" lots as cards and "Everything else" as one quiet list.
import { el, clear } from "../dom.js";
import { avatar, button, openSheet, numStepper, toast, setLoading, img3d, celebrate } from "../ui.js";
import { icon } from "../icons.js";
import {
  nextAction, secondsLeft, formatCountdown, friendlyError, validateQty,
  plainStage, stageFamily, qtySegments, remainingOf,
  UNITS, FOOD_MAX, qty, unitOf, unitWord, foodOf, validateFood, unclaimed, isOpenOffer, newIdemKey,
} from "../logic.js";

const SHEET_FADE_MS = 240; // the celebration mounts after the sheet has faded (same pause as lot.js)

// Short, plain next-step labels for the list cards (nextAction's labels stay for the sheets and tests).
const SHORT_ACTION = {
  accept: "Accept lot",
  handoff: "Declare handoff",
  receipt: "Report what arrived",
  distribution: "Report what was given out",
  disposition: "Report returned or thrown away",
  close: "Close lot",
  "resolve-dispute": "Settle the count",
  "review-exception": "Review exception",
};

// One short line per role for the empty state (the donor's line points at the New lot button).
// Each role gets its own 3D picture: donor a package, receiver a handshake, coordinator a check.
const EMPTY = {
  donor: { image: "package", text: "No lots yet. Tap New lot to offer one." },
  receiver: { image: "handshake", text: "Lots you claim show up here." },
  coordinator: { image: "check_mark_button", text: "Disputed lots show up here." },
};

const displayName = (name) => String(name || "").replace(/\s*\(.*\)\s*$/, "");

function personName(sub) {
  const p = ((window.PP_CONFIG && window.PP_CONFIG.people) || []).find((x) => x.sub === sub);
  if (p) return displayName(p.name);
  if (!sub) return "Unknown";
  return sub.length > 12 ? sub.slice(0, 8) + "…" : sub;
}

// The person on the other side of the lot from the viewer, with their role for the avatar tint.
function counterpart(lot, role) {
  if (role === "donor") return unclaimed(lot) ? { name: "", role: "none" } : { name: personName(lot.receiver_sub), role: "receiver" };
  return { name: personName(lot.donor_sub), role: "donor" };
}

// "Asha → Ravi", or "Asha → open to all receivers" while nobody has claimed the lot.
function partyLine(lot) {
  const donor = personName(lot.donor_sub);
  return unclaimed(lot) ? `${donor} → open to all receivers` : `${donor} → ${personName(lot.receiver_sub)}`;
}

const firstName = (name) => displayName(name).split(/\s+/)[0] || "";

const shortId = (id) => String(id || "").slice(-6);

// The number a lot card shows: received if known, else offered. Its unit comes from unitOf(lot).
function countOf(lot) {
  return lot.received != null ? lot.received : (lot.offered || 0);
}

// Thin quantity bar: same segments as qtyBar, no legend (the lot page keeps the full qtyBar).
function thinBar(lot) {
  const unit = unitOf(lot);
  const total = countOf(lot);
  const segments = qtySegments(lot);
  const label = lot.received != null
    ? `Distributed ${lot.distributed || 0}, returned ${lot.returned || 0}, disposed ${lot.disposed || 0}, ` +
      `remaining ${remainingOf(lot)} of ${qty(lot.received, unit)} received`
    : `Offered ${qty(total, unit)}, not yet received`;
  return el("div", { class: "qty-bar lot-bar", role: "img", "aria-label": label },
    segments.map((s) => el("div", { class: `qty-seg qty-${s.key}`, style: `width:${s.pct}%` })));
}

// open: an unclaimed offer, counted down as time left to claim. Otherwise the receiver's time to respond.
function paintCountdown(node, epoch, skewMs, open = false) {
  const sec = secondsLeft(Number(epoch), skewMs);
  if (sec == null) return;
  if (sec <= 0) {
    node.textContent = open ? "Time to claim is up" : "Response overdue";
    node.classList.add("is-late");
  } else {
    node.textContent = open ? `${formatCountdown(sec)} left to claim` : `Receiver has ${formatCountdown(sec)} to respond`;
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

// ---------- Hero card ----------

// Coordinator impact. Loaded once per visit: GET /impact scans the tables, so it is not polled.
const IMPACT_ROWS = [
  ["lots", "Lots"],
  ["offered", "Units offered"],
  ["received", "Units received"],
  ["distributed", "Units distributed"],
  ["returned", "Units returned"],
  ["disposed", "Units disposed"],
  ["accounted_for", "Lots accounted for"],
  ["disputes_caught", "Disputes caught"],
  ["exceptions_raised", "Exceptions raised"],
  ["confirmed_in_person", "Confirmed in person"],
];
// Shown as the three mini stats under the headline; everything else sits behind "All numbers".
const IMPACT_MINI = ["offered", "received", "distributed"];
// One-word captions so the three columns stay on one line each.
const MINI_CAP = { offered: "Offered", received: "Received", distributed: "Distributed" };

// Floors of each level, to draw the progress bar (mirrors backend/rewards.py LEVELS).
const LEVEL_FLOOR = { Seedling: 0, Helper: 20, Steward: 60, Champion: 150 };
// 3D picture per level; anything unknown falls back to the seedling.
const LEVEL_IMAGE = { Seedling: "seedling", Helper: "herb", Steward: "trophy", Champion: "trophy" };
const WHY_HASH_TITLE = "This event is part of the hash-chained record";

function skeletonLines() {
  return el("div", { class: "hero-skel", "aria-hidden": "true" },
    el("span", { class: "skeleton skeleton-line" }),
    el("span", { class: "skeleton skeleton-line" }));
}

// Quantity rows are per unit. One unit: the numbers as before, with the unit after each. Several units: the
// top-level figures are sums across units, so they are never shown; the biggest unit headlines the figures
// and every unit gets its own row.
const QTY_KEYS = ["offered", "received", "distributed", "returned", "disposed"];
function impactBlock(body) {
  const caught = Number(body.disputes_caught ?? 0);
  const units = body.by_unit || {};
  const ranked = Object.keys(units).sort((x, y) => (units[y].offered || 0) - (units[x].offered || 0));
  const mixed = body.mixed_units === true && ranked.length > 1;
  const unit = ranked.length ? ranked[0] : null; // the only unit, or the biggest one when mixed
  const figures = mixed ? units[unit] : body; // one unit: the top-level sums are that unit's totals
  const word = (n) => (unit ? ` ${unitWord(n, unit)}` : "");
  const mini = IMPACT_ROWS.filter(([key]) => IMPACT_MINI.includes(key));
  const more = IMPACT_ROWS.filter(([key]) => key !== "disputes_caught" && !IMPACT_MINI.includes(key) && !QTY_KEYS.includes(key));
  const unitRows = mixed
    ? ranked.map((u) => el("li", { class: "hero-more-stat hero-more-unit" },
      el("span", { class: "hero-more-cap", text: `${u}: ${units[u].offered || 0} offered, ${units[u].received || 0} received, ${units[u].distributed || 0} distributed` })))
    : [];
  const qtyRows = mixed ? [] : ["returned", "disposed"].map((key) => el("li", { class: "hero-more-stat" },
    el("span", { class: "hero-more-cap", text: IMPACT_ROWS.find(([k]) => k === key)[1] }),
    el("span", { class: "display-num hero-more-num", text: `${figures[key] ?? 0}${word(figures[key] ?? 0)}` })));
  return el("div", { class: "hero-impact" },
    el("p", { class: "hero-label", text: "Count disputes caught" }),
    el("p", { class: "hero-headline" },
      el("span", { class: "display-num hero-num", text: String(caught) }),
      caught > 0 ? el("span", { class: "hero-alert-dot", "aria-hidden": "true" }) : null),
    mixed ? el("p", { class: "hero-muted hero-unit-note", text: `Lots in several units. Figures shown for ${unit}, the biggest.` }) : null,
    el("ul", { class: "hero-mini", "aria-label": "Totals" }, mini.map(([key]) => {
      const n = figures[key] ?? 0;
      return el("li", { class: "hero-mini-stat" },
        el("span", { class: "display-num hero-mini-num", text: String(n) }),
        unit ? el("span", { class: "hero-mini-unit", text: word(n) }) : null,
        el("span", { class: "hero-mini-cap", text: MINI_CAP[key] }));
    })),
    el("details", { class: "hero-all" },
      el("summary", { class: "hero-pill", text: "All numbers" }),
      el("ul", { class: "hero-more", "aria-label": "Other impact counts" },
        [...unitRows, ...qtyRows, ...more.map(([key, label]) =>
          el("li", { class: "hero-more-stat" },
            el("span", { class: "hero-more-cap", text: label }),
            el("span", { class: "display-num hero-more-num", text: String(body[key] ?? 0) })))]),
      el("p", { class: "hero-foot", text: "Counts in each lot's own unit, as reported by the people involved. Not meals or avoided waste." })));
}

function badgeNode(b) {
  const mark = el("span", { class: "rewards-badge-mark", "aria-hidden": "true" },
    b.earned ? icon("check", 14) : null);
  return el("li", { class: "rewards-badge" + (b.earned ? " is-earned" : " is-locked") },
    mark,
    el("span", { class: "rewards-badge-body" },
      el("strong", { class: "rewards-badge-name", text: b.name }),
      el("span", { class: "rewards-badge-rule", text: b.rule }),
      el("span", { class: "rewards-badge-progress", text: b.earned ? "Earned" : `${b.progress}/${b.goal}` })));
}

function ledgerRow(e) {
  const id = String(e.lot_id || "");
  return el("li", { class: "rewards-ledger-row" },
    el("span", { class: "rewards-ledger-reason", text: e.reason }),
    el("span", { class: "rewards-ledger-pts", text: `+${e.points}` }),
    el("a", { class: "rewards-ledger-lot", href: `#/lot/${encodeURIComponent(id)}`, text: `Lot ${shortId(id)}` }),
    el("code", { class: "rewards-ledger-hash", title: WHY_HASH_TITLE, text: String(e.event_hash || "").slice(0, 8) }));
}

// Level progress and the next-level text, from a successful GET /rewards response.
function rewardsProgress(d) {
  const floor = LEVEL_FLOOR[d.level] ?? 0;
  const nextAt = d.next_level_at;
  const span = nextAt != null ? Math.max(nextAt - floor, 1) : 1;
  const pct = nextAt != null ? Math.min(100, Math.max(0, ((d.points - floor) / span) * 100)) : 100;
  const toNext = nextAt != null ? nextAt - d.points : 0;
  const nextText = d.next_level
    ? `${toNext} ${toNext === 1 ? "point" : "points"} to ${d.next_level}`
    : "Top level";
  return { pct, nextText };
}

// Donor and receiver: the trust level, the big points number, the bar and the level picture.
function trustMain(d) {
  const { pct, nextText } = rewardsProgress(d);
  return el("div", { class: "hero-main" },
    el("div", { class: "hero-copy" },
      el("p", { class: "hero-label", text: "Trust level" }),
      el("p", { class: "hero-level", text: d.level }),
      el("p", { class: "hero-pts" },
        el("span", { class: "display-num hero-num", text: String(d.points) }),
        el("span", { class: "hero-unit", text: "pts" })),
      el("span", { class: "hero-track", role: "progressbar", "aria-label": "Progress to the next level",
        "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)) },
      el("span", { class: "hero-fill", style: `width: ${pct.toFixed(1)}%` })),
      el("p", { class: "hero-next", text: nextText })),
    img3d(LEVEL_IMAGE[d.level] || "seedling", 72));
}

// Donor only: each unit's verified quantity on its own line (never summed across units), and the streak.
function volumeNode(d) {
  const volume = (Array.isArray(d.volume) ? d.volume : []).filter((v) => v && Number(v.quantity) > 0);
  const streak = Number(d.streak_weeks) || 0;
  if (!volume.length && streak <= 0) return null;
  return el("div", { class: "rewards-volume" },
    volume.length ? el("p", { class: "rewards-volume-label", text: "Verified volume" }) : null,
    volume.length ? el("ul", { class: "rewards-volume-list", "aria-label": "Verified volume" },
      volume.map((v) => {
        const lots = Number(v.lots) || 0;
        return el("li", { text: `${qty(v.quantity, v.unit)} across ${lots} ${lots === 1 ? "lot" : "lots"}` });
      })) : null,
    streak > 0 ? el("p", { class: "rewards-streak", text: `${streak} week streak` }) : null);
}

// The badges and history panel, shared by the pill (donor, receiver) and the slim line (coordinator).
// The verified volume and streak are for the donor's own view only.
function historyPanel(d, role) {
  const ledger = Array.isArray(d.ledger) ? d.ledger : [];
  const volume = role === "donor" ? volumeNode(d) : null;
  return [
    el("ul", { class: "rewards-badges", "aria-label": "Badges" }, (d.badges || []).map(badgeNode)),
    volume,
    el("details", { class: "rewards-why" },
      el("summary", { text: "Why do I have these points?" }),
      ledger.length
        ? el("ul", { class: "rewards-ledger" }, ledger.map(ledgerRow))
        : el("p", { class: "hero-muted", text: "No points yet. They appear when a lot you are part of is confirmed." })),
    el("p", { class: "hero-foot", text: "Points come from confirmed handoffs. The amount counts only once it is verified, and only up to a limit. They are recognition, not prizes." }),
  ];
}

// The one focal card on home. Donors and receivers see their trust level; the coordinator sees the
// disputes headline and impact, with one slim trust line at the bottom. Both loads run once per visit.
// On failure the card says so in one muted line.
function heroCard(api, role) {
  const coord = role === "coordinator";
  const top = el("div", { class: "hero-top" }, skeletonLines());
  const summary = el("summary", { class: coord ? "hero-toggle hero-slim" : "hero-toggle hero-pill" });
  const panel = el("div", { class: "hero-panel" });
  const badges = el("details", { class: "hero-badges" }, summary, panel);
  badges.hidden = true;
  const section = el("section", { class: `hero hero-${coord ? "coord" : "trust"}`,
    "aria-label": coord ? "Impact" : "Trust level" }, top, badges);

  if (coord) {
    api.impact().then((r) => {
      if (!section.isConnected) return;
      clear(top);
      top.append(r.ok && r.body
        ? impactBlock(r.body)
        : el("p", { class: "hero-muted", text: "Impact is not available right now." }));
    });
  }
  api.rewards().then((r) => {
    if (!section.isConnected) return;
    if (!r.ok || !r.body || typeof r.body.points !== "number") {
      if (!coord) {
        clear(top);
        top.append(el("p", { class: "hero-muted", text: "Points not available" }));
      }
      return;
    }
    const d = r.body;
    if (!coord) {
      clear(top);
      top.append(trustMain(d));
    }
    clear(summary);
    summary.append(...(coord
      ? [
        img3d(LEVEL_IMAGE[d.level] || "seedling", 32),
        el("span", { class: "hero-slim-text", text: `${d.level} · ${d.points} pts` }),
        icon("chevron-down", 16),
      ]
      : [el("span", { text: "Badges & history" })]));
    clear(panel);
    panel.append(...historyPanel(d, role));
    badges.hidden = false;
  });
  return section;
}

// ---------- Lot list ----------

export function render(container, ctx) {
  clear(container);
  const { session, role, store } = ctx;
  const isDonor = role === "donor";
  const listBox = el("div", { class: "stack" });
  // Screen readers still hear the freshness line; sighted users do not see it.
  const liveLine = el("p", { class: "home-sr-only", "aria-live": "polite" });
  const pageSub = el("p", { class: "page-sub home-sub", text: "" });

  let sheetHandle = null;

  // New lot: what food, how many, in which unit. No receiver: the lot is announced to every receiver.
  function openNewLot() {
    const errSlot = el("div", { class: "stack" });
    let busy = false;

    const foodInput = el("input", {
      class: "input", id: "new-lot-food", type: "text", maxlength: String(FOOD_MAX), placeholder: "e.g. Rice and dal",
      autocomplete: "off", required: true, "aria-required": "true", "aria-describedby": "new-lot-food-error",
    });
    const foodError = el("p", { class: "field-error", id: "new-lot-food-error", role: "alert", hidden: true });
    const unitSelect = el("select", { class: "select", id: "new-lot-unit" },
      UNITS.map((u) => el("option", { value: u, text: u })));
    const stepper = numStepper({ value: 10, min: 1, max: 500, label: "Quantity", onChange: () => {} });
    const submitBtn = button("Announce lot", { variant: "primary", block: true, onClick: submit });

    function setFoodError(msg) {
      foodError.textContent = msg || "";
      foodError.hidden = !msg;
      if (msg) foodInput.setAttribute("aria-invalid", "true");
      else foodInput.removeAttribute("aria-invalid");
    }
    foodInput.addEventListener("input", () => { if (!foodError.hidden) setFoodError(""); });

    async function submit() {
      if (busy) return;
      clear(errSlot);
      const food = foodInput.value.trim();
      const unit = unitSelect.value;
      const offered = stepper.getValue();
      const foodProblem = validateFood(food);
      setFoodError(foodProblem);
      if (foodProblem) { foodInput.focus(); return; }
      const msg = validateQty("offered", offered);
      if (msg) { stepper.setError(msg); return; }

      busy = true;
      setLoading(submitBtn, true);
      let r;
      try {
        r = await store.create({ food, unit, offered });
      } finally {
        busy = false;
        setLoading(submitBtn, false);
      }
      if (r.ok) {
        if (sheetHandle) sheetHandle.close();
        toast("Lot announced. The first receiver to claim it collects it.", "success");
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

    const body = el("div", { class: "stack new-lot" },
      errSlot,
      el("div", { class: "field" },
        el("label", { class: "field-label", for: "new-lot-food", text: "What food is it?" }),
        foodInput,
        foodError),
      el("div", { class: "new-lot-qty" },
        stepper.el,
        el("div", { class: "field" },
          el("label", { class: "field-label", for: "new-lot-unit", text: "Unit" }),
          unitSelect)),
      el("p", { class: "field-hint", text: "Quantity is whole units of the unit you pick." }),
      el("p", { class: "field-hint", text: "Announced to every receiver. The first to claim it collects it." }));

    sheetHandle = openSheet({
      title: "New lot",
      body,
      footer: submitBtn,
      onClose: () => { sheetHandle = null; },
    });
  }

  // ---- Open offers (receivers): announced to every receiver. The first to claim it collects it. ----

  // Confirm, then claim. A 409 means someone else claimed it first: say so, and refresh the list.
  function confirmClaim(lot) {
    const donor = firstName(personName(lot.donor_sub));
    const errSlot = el("div", { class: "stack" });
    let busy = false;
    let sheetHandle = null;
    const claimBtn = button("Claim this lot", { variant: "primary", block: true, onClick: send });

    async function send() {
      if (busy) return;
      clear(errSlot);
      busy = true;
      setLoading(claimBtn, true);
      const current = store.lotById(lot.lot_id) || lot;
      const r = await store.mutate("accept", lot.lot_id, { idem_key: newIdemKey("claim"), expected_version: current.version });
      busy = false;
      setLoading(claimBtn, false);
      if (r.ok) {
        if (sheetHandle) sheetHandle.close();
        setTimeout(() => celebrate({
          title: "Claimed",
          text: `You collect it from ${donor}. They hand it over and give you a pickup code.`,
          image: "handshake",
          cta: "Done",
          onDone: () => ctx.go(`#/lot/${encodeURIComponent(lot.lot_id)}`),
        }), SHEET_FADE_MS);
        return;
      }
      const conflict = r.status === 409;
      const f = conflict
        ? { title: "Someone else claimed it first", detail: "It is no longer open. The list has been refreshed." }
        : friendlyError(r.status, r.body);
      errSlot.append(denyNode(f));
      toast(f.title, "error");
      if (conflict) {
        claimBtn.disabled = true;
        store.refreshList();
      }
    }

    const body = el("div", { class: "stack" },
      errSlot,
      el("p", { text: `Claim this lot? You will collect it from ${donor}.` }),
      el("p", { class: "field-hint", text: `${qty(countOf(lot), unitOf(lot))} of ${foodOf(lot)}.` }));
    sheetHandle = openSheet({ title: "Claim this lot", body, footer: claimBtn });
  }

  // One open offer: food, quantity in its unit, the donor's first name, the time left to claim, and Claim.
  function offerCard(lot) {
    const count = countOf(lot);
    const donor = firstName(personName(lot.donor_sub));
    const cd = el("span", { class: "countdown offer-countdown", dataset: { epoch: String(lot.response_deadline_epoch), open: "1" } });
    paintCountdown(cd, lot.response_deadline_epoch, ctx.skewMs(), true);
    const claim = button("Claim", { variant: "primary", onClick: () => confirmClaim(lot) });
    claim.setAttribute("aria-label", `Claim ${qty(count, unitOf(lot))} of ${foodOf(lot)} from ${donor}`);
    return el("article", { class: "card offer-card" },
      el("div", { class: "offer-main" },
        el("p", { class: "offer-food", text: foodOf(lot) }),
        el("p", { class: "offer-qty" },
          el("span", { class: "display-num lot-count", text: String(count) }),
          el("span", { class: "lot-count-cap", text: unitWord(count, unitOf(lot)) })),
        el("p", { class: "card-meta", text: `From ${donor}` }),
        cd),
      claim);
  }

  // Receivers see every open offer above their own lots. Empty: one line.
  function offersBlock(list) {
    return el("section", { class: "stack home-offers", "aria-labelledby": "home-offers-title" },
      el("div", { class: "row home-offers-head" },
        el("h2", { class: "section-title", id: "home-offers-title", text: "Open offers" }),
        list.length ? el("span", { class: "seg-count", text: String(list.length) }) : null),
      list.length
        ? list.map(offerCard)
        : el("p", { class: "card-meta home-offers-empty", text: "No open offers right now." }));
  }

  // Donor: the header button shows on desktop, the floating button on mobile (CSS picks one).
  const headNew = isDonor ? button("New lot", { variant: "primary", onClick: openNewLot }) : null;
  if (headNew) headNew.classList.add("home-head-new");
  const fab = isDonor
    ? el("button", { type: "button", class: "home-fab", onclick: openNewLot },
      icon("plus", 22),
      el("span", { text: "New lot" }))
    : null;

  const header = el("header", { class: "row page-head" },
    el("div", { class: "stack home-title" },
      el("h1", { class: "page-title", text: `Hi, ${displayName(session.name)}` }),
      pageSub),
    headNew);

  const root = el("div", { class: "stack home" },
    header,
    // With a lot open in the desktop two-pane the lot is the focus, so the summary card steps aside.
    ctx.selectedId ? null : heroCard(ctx.api, role),
    liveLine,
    el("div", { class: "split" },
      el("div", { class: "split-list" }, listBox),
      el("div", { class: "split-detail" },
        el("div", { class: "home-pick" },
          img3d("magnifying_glass_tilted_left", 120),
          el("p", { class: "home-pick-text", text: "Pick a lot" })))),
    fab);
  container.append(root);

  function isSelected(lot) {
    return ctx.selectedId === lot.lot_id;
  }

  // "To do" card: the hero row. Avatar, food and status chip on top; a hairline; the count in its unit and the
  // action link; the thin bar only when there is progress data.
  function needCard(lot) {
    const next = nextAction(lot, role, true);
    const nextLabel = (next.kind === "act" && SHORT_ACTION[next.action]) || next.label;
    const who = counterpart(lot, role);
    const selected = isSelected(lot);
    const count = countOf(lot);
    const body = [
      el("div", { class: "lot-count-row" },
        el("span", { class: "display-num lot-count", text: String(count) }),
        el("span", { class: "lot-count-cap", text: unitWord(count, unitOf(lot)) }),
        el("span", { class: "lot-action" }, el("span", { text: nextLabel }), icon("arrow-right", 16))),
    ];
    if (lot.received != null) body.push(thinBar(lot));
    if (lot.stage === "OFFERED" && lot.response_deadline_epoch != null) {
      const open = isOpenOffer(lot);
      const cd = el("p", { class: "lot-countdown countdown",
        dataset: { epoch: String(lot.response_deadline_epoch), ...(open ? { open: "1" } : {}) } });
      paintCountdown(cd, lot.response_deadline_epoch, ctx.skewMs(), open);
      body.push(cd);
    }
    return el("a", {
      class: "card card-link lot-need" + (selected ? " is-selected" : ""),
      href: `#/lot/${encodeURIComponent(lot.lot_id)}`,
      "aria-current": selected ? "true" : null,
    },
    el("div", { class: "lot-top" },
      avatar(who.name, who.role, "m"),
      el("div", { class: "lot-main" },
        el("span", { class: "card-title", text: foodOf(lot) }),
        el("div", { class: "card-meta", text: partyLine(lot) })),
      el("span", { class: `chip chip-${stageFamily(lot)}` },
        el("span", { class: "chip-dot", "aria-hidden": "true" }), plainStage(lot))),
    el("div", { class: "lot-body" }, body));
  }

  // "Everything else": a compact row inside one shared surface. Avatar, id, one muted status line, chevron.
  function rowCard(lot) {
    const who = counterpart(lot, role);
    const selected = isSelected(lot);
    return el("a", {
      class: "lot-row" + (selected ? " is-selected" : ""),
      href: `#/lot/${encodeURIComponent(lot.lot_id)}`,
      "aria-current": selected ? "true" : null,
    },
    avatar(who.name, who.role, "m"),
    el("div", { class: "lot-main" },
      el("span", { class: "card-title", text: foodOf(lot) }),
      el("span", { class: "card-meta", text: `${qty(countOf(lot), unitOf(lot))} · ${plainStage(lot)}` })),
    icon("chevron-right", 18));
  }

  function rowList(lots) {
    return el("div", { class: "card lot-list" }, lots.map(rowCard));
  }

  let view = null; // null = follow the data; otherwise the tab the person chose

  function draw() {
    clear(listBox);
    if (!store.getLastUpdated()) {
      pageSub.textContent = "Loading…";
      listBox.append(...skeletons(3));
      return;
    }
    const lots = store.allLots();
    const offerList = role === "receiver" ? store.openOffersList() : [];
    const offersNode = role === "receiver" ? offersBlock(offerList) : null;
    const offerNote = offerList.length
      ? `${offerList.length} open ${offerList.length === 1 ? "offer" : "offers"}`
      : "";
    if (!lots.length) {
      pageSub.textContent = offerNote || "Nothing to do yet";
      const empty = EMPTY[role] || EMPTY.receiver;
      const emptyNode = offerList.length ? null : el("div", { class: "empty-state home-empty" },
        img3d(empty.image, 120),
        el("p", { class: "empty-text", text: empty.text }));
      listBox.append(...[offersNode, emptyNode].filter(Boolean));
      return;
    }
    const needs = lots.filter((l) => nextAction(l, role, true).kind === "act");
    const needIds = new Set(needs.map((l) => l.lot_id));
    const rest = lots.filter((l) => !needIds.has(l.lot_id));
    const done = lots.filter((l) => l.stage === "ACCOUNTED_FOR");
    const parts = [needs.length ? `${needs.length} ${needs.length === 1 ? "needs" : "need"} you` : "", offerNote];
    pageSub.textContent = parts.filter(Boolean).join(" · ") || "All caught up";

    // Segmented filter. Until the person picks one it follows the data: To do when something needs them, else All.
    const active = view || (needs.length ? "todo" : "all");
    const tabs = [["todo", "To do", needs.length], ["all", "All", lots.length], ["done", "Done", done.length]];
    const tablist = el("div", { class: "seg", role: "tablist", "aria-label": "Show lots" }, tabs.map(([key, label, n]) =>
      el("button", {
        class: "seg-tab" + (active === key ? " is-active" : ""), type: "button", role: "tab",
        "aria-selected": String(active === key),
        onclick: () => { view = key; draw(); },
      }, label, n ? el("span", { class: "seg-count", text: String(n) }) : null)));

    let panel;
    if (active === "todo") {
      panel = needs.length
        ? needs.map(needCard)
        : role === "coordinator"
          ? el("div", { class: "empty-state home-empty home-caughtup-block" },
            img3d("check_mark_button", 120),
            el("p", { class: "empty-text", text: "Nothing needs you right now." }))
          : el("p", { class: "home-caughtup" },
            img3d("sparkles", 72),
            el("span", { text: "You're all caught up" }));
    } else if (active === "all") {
      panel = [...needs.map(needCard), rest.length ? rowList(rest) : null];
    } else {
      panel = done.length
        ? rowList(done)
        : el("p", { class: "home-caughtup" }, img3d("hourglass_not_done", 72), el("span", { text: "Nothing finished yet" }));
    }
    listBox.append(...[offersNode, tablist, el("div", { class: "stack home-section", role: "tabpanel" }, panel)].filter(Boolean));
  }

  function tick() {
    const t = store.getLastUpdated();
    if (!t) {
      liveLine.textContent = "Loading lots…";
    } else {
      const s = Math.floor((Date.now() - t) / 1000);
      liveLine.textContent = s < 5 ? "Updated just now" : s < 60 ? `Updated ${s}s ago` : `Updated ${Math.floor(s / 60)}m ago`;
    }
    root.querySelectorAll(".countdown[data-epoch]").forEach((n) => paintCountdown(n, n.dataset.epoch, ctx.skewMs(), n.dataset.open === "1"));
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
