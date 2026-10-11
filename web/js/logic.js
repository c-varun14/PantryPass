// Pure rules shared by every view. No DOM, no network: testable with node --test.

export const STAGES = ["OFFERED", "ACCEPTED", "HANDOFF_DECLARED", "RECEIVED", "DISTRIBUTING", "ACCOUNTED_FOR"];

export const STAGE_LABEL = {
  OFFERED: "Offered",
  ACCEPTED: "Accepted",
  HANDOFF_DECLARED: "Handoff declared",
  RECEIVED: "Received",
  DISTRIBUTING: "Distributing",
  ACCOUNTED_FOR: "Accounted for",
  EXCEPTION: "Needs attention",
};

// ---- Food and units. A lot has a food description and a unit. Legacy lots have neither: "Surplus food", packets. ----

export const UNITS = ["kg", "litres", "plates", "packets", "boxes", "trays", "pieces"];
export const FOOD_MAX = 60;
export const DEFAULT_UNIT = "packets";
// [singular, plural] per unit. kg is kg either way; litres keep their word.
const UNIT_WORD = {
  kg: ["kg", "kg"],
  litres: ["litre", "litres"],
  plates: ["plate", "plates"],
  packets: ["packet", "packets"],
  boxes: ["box", "boxes"],
  trays: ["tray", "trays"],
  pieces: ["piece", "pieces"],
};

// The unit a lot is counted in. Unknown or missing units count as packets (legacy lots).
export function unitOf(lot) {
  const u = lot && lot.unit;
  return UNIT_WORD[u] ? u : DEFAULT_UNIT;
}

export function unitWord(n, unit) {
  const pair = UNIT_WORD[unit] || UNIT_WORD[DEFAULT_UNIT];
  return Number(n) === 1 ? pair[0] : pair[1];
}

// qty(12, "kg") -> "12 kg"; qty(1, "boxes") -> "1 box"; qty(4, "boxes") -> "4 boxes".
export function qty(n, unit) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  return `${v} ${unitWord(v, unit)}`;
}

// The food name, or "Surplus food" for a legacy lot.
export function foodOf(lot) {
  const f = lot && typeof lot.food === "string" ? lot.food.trim() : "";
  return f || "Surplus food";
}

// Client-side pre-check for the New lot dialog, mirroring the server. Returns an error string or "".
export function validateFood(food) {
  const f = String(food || "").trim();
  if (!f) return "Say what the food is.";
  return f.length <= FOOD_MAX ? "" : `Keep it to ${FOOD_MAX} characters.`;
}

// True while a donor's lot is announced to every receiver and nobody has claimed it yet.
export function isOpenOffer(lot) {
  return !!lot && lot.open_offer === true;
}

// True when no receiver has claimed the lot (open offers, and open offers that ran out of time).
export function unclaimed(lot) {
  return !!lot && !lot.receiver_sub;
}

// stage -> colour family (maps to --<family>-bg / --<family>-fg tokens)
export function stageFamily(lot) {
  if (lot.stage === "EXCEPTION") return "exception";
  if (lot.count_dispute) return "dispute";
  if (lot.stage === "OFFERED") return "offered";
  if (lot.stage === "ACCOUNTED_FOR") return "done";
  return "progress";
}

export function remainingOf(lot) {
  if (typeof lot.remaining === "number") return lot.remaining;
  return Math.max(0, (lot.received || 0) - (lot.distributed || 0) - (lot.returned || 0) - (lot.disposed || 0));
}

// received = distributed + returned + disposed + remaining
export function invariantHolds(lot) {
  if (lot.received == null) return true;
  return lot.received === (lot.distributed || 0) + (lot.returned || 0) + (lot.disposed || 0) + remainingOf(lot);
}

// Segment widths in percent of received (or of offered before receipt).
export function qtySegments(lot) {
  const total = lot.received != null ? lot.received : lot.offered || 0;
  if (!total) return [];
  const parts = lot.received != null
    ? [["distributed", lot.distributed || 0], ["returned", lot.returned || 0],
       ["disposed", lot.disposed || 0], ["remaining", remainingOf(lot)]]
    : [["remaining", total]];
  return parts.map(([key, n]) => ({ key, n, pct: (n / total) * 100 }));
}

// Server clock correction: skew = serverNowMs - clientNowMs, from the Date header.
export function skewFromDate(dateHeader, clientNowMs = Date.now()) {
  const t = Date.parse(dateHeader || "");
  return Number.isNaN(t) ? 0 : t - clientNowMs;
}

export function secondsLeft(epoch, skewMs = 0, clientNowMs = Date.now()) {
  if (epoch == null) return null;
  return Math.floor(epoch - (clientNowMs + skewMs) / 1000);
}

export function formatCountdown(sec) {
  if (sec == null) return "";
  if (sec <= 0) return "0:00";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// What this role can do next on this lot. kind: act | wait | none.
// `action` is the API action id used by views to open the right sheet.
export function nextAction(lot, role, isParticipant = true) {
  const s = lot.stage;
  if (s === "EXCEPTION") {
    return role === "coordinator"
      ? { kind: "act", action: "review-exception", label: "Review exception" }
      : { kind: "wait", label: unclaimed(lot) ? "Nobody claimed it in time. Coordinator has been notified." : "Pickup unanswered. Coordinator has been notified." };
  }
  if (s === "ACCOUNTED_FOR") return { kind: "none", label: "Accounted for" };

  if (role === "coordinator") {
    if (lot.count_dispute && s !== "ACCOUNTED_FOR") {
      return { kind: "act", action: "resolve-dispute", label: "Resolve count dispute" };
    }
    return { kind: "none", label: "No action needed" };
  }
  if (!isParticipant) return { kind: "none", label: "" };

  if (role === "receiver") {
    switch (s) {
      case "OFFERED": return isOpenOffer(lot)
        ? { kind: "act", action: "accept", label: "Claim this lot" }
        : { kind: "act", action: "accept", label: "Accept lot" };
      case "ACCEPTED": return { kind: "wait", label: "Waiting for donor to declare the handoff" };
      case "HANDOFF_DECLARED": return { kind: "act", action: "receipt", label: "Report what arrived" };
      case "RECEIVED":
      case "DISTRIBUTING": {
        if (remainingOf(lot) > 0) return { kind: "act", action: "distribution", label: "Report distribution" };
        if (lot.count_dispute) return { kind: "wait", label: "Count dispute: waiting for coordinator" };
        return { kind: "act", action: "close", label: "Close lot" };
      }
    }
  }
  if (role === "donor") {
    switch (s) {
      case "OFFERED": return { kind: "wait", label: isOpenOffer(lot) ? "Waiting for someone to claim it" : "Waiting for the receiver to accept" };
      case "ACCEPTED": return { kind: "act", action: "handoff", label: "Declare handoff" };
      default: return { kind: "wait", label: "Receiver is reporting what happened" };
    }
  }
  return { kind: "none", label: "" };
}

// Secondary receiver actions available alongside the primary one.
export function secondaryActions(lot, role) {
  if (role === "receiver" && (lot.stage === "RECEIVED" || lot.stage === "DISTRIBUTING") && remainingOf(lot) > 0) {
    return [{ action: "disposition", label: "Return or dispose" }];
  }
  return [];
}

// Coordinator exception buckets for the Exceptions screen.
export function exceptionKinds(lot) {
  const kinds = [];
  if (lot.stage === "EXCEPTION") kinds.push("unanswered");
  if (lot.count_dispute && lot.stage !== "ACCOUNTED_FOR") kinds.push("dispute");
  if (lot.callback_pending) kinds.push("callback");
  return kinds;
}

// Clamp a stepper value to [min, max].
export function clampQty(n, min, max) {
  const v = n === Infinity ? max : Number.isFinite(n) ? Math.trunc(n) : min;
  return Math.min(max, Math.max(min, v));
}

// Client-side pre-check mirroring the server rules. Returns an error string or "".
export function validateQty(kind, n, lot) {
  if (!Number.isInteger(n)) return "Enter a whole number.";
  if (kind === "offered") return n > 0 ? "" : "Offer at least 1.";
  if (kind === "donor_handoff") return n >= 0 && n <= lot.offered ? "" : `Between 0 and ${lot.offered}.`;
  if (kind === "received") return n >= 0 ? "" : "Cannot be negative.";
  if (kind === "distributed") {
    if (n <= 0) return "Report at least 1.";
    return n <= remainingOf(lot) ? "" : `Only ${remainingOf(lot)} remaining.`;
  }
  if (kind === "disposition") return n >= 0 ? "" : "Cannot be negative.";
  return "";
}

export function newIdemKey(prefix = "k") {
  const r = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  return `${prefix}-${r}`;
}

// Map a contract error response to friendly copy. `status` is the HTTP status.
export function friendlyError(status, body) {
  body = body || {};
  if (status === 403) {
    return { title: "Refused by Verified Permissions",
             detail: `${body.actor || "This user"} is not allowed to do ${body.action || "this action"}${body.lot_id ? " on " + body.lot_id : ""}.` };
  }
  if (status === 409) {
    if (body.error === "invalid stage") return { title: "This lot moved on", detail: "Its stage changed. Review it and try again." };
    if (/version/.test(body.error || "")) return { title: "This lot changed while you were looking", detail: "Review the latest numbers and try again." };
    // Pickup code failures. Each one says what can still be done: the receipt can always be recorded without a code.
    if (body.error === "pickup code invalid") {
      const left = body.attempts_left;
      const tail = typeof left === "number" ? ` ${left} ${left === 1 ? "attempt" : "attempts"} left.` : "";
      return { title: "Pickup code does not match", detail: `Check the code with the donor.${tail}` };
    }
    if (body.error === "pickup code expired") {
      return { title: "Pickup code expired", detail: "You can still record what arrived. It will show as not confirmed in person." };
    }
    if (body.error === "pickup code attempt limit reached") {
      return { title: "Too many wrong codes", detail: "This code is locked. You can still record what arrived, and it will show as not confirmed in person." };
    }
    return { title: "Not allowed right now", detail: body.error || "The server rejected this change." };
  }
  if (status === 401) return { title: "Session expired", detail: "Please sign in again." };
  if (status === 404) return { title: "Lot not found", detail: "It may have been removed." };
  if (status === 0) return { title: "You look offline", detail: "Check your connection. Nothing was changed." };
  return { title: "Something went wrong", detail: body.error || "Please try again." };
}

export const ROLES = ["donor", "receiver", "coordinator"];

export function roleFromClaims(claims = {}) {
  let g = claims["cognito:groups"];
  if (typeof g === "string") g = g.replace(/[\[\]]/g, "").split(/[ ,]+/).filter(Boolean);
  g = g || [];
  for (const r of ROLES) if (g.includes(r)) return r;
  return "user";
}

// ---- Plain-language helpers for first-time users (v2 UI). Pure, no DOM. ----

export const ROLE_LABEL = { donor: "Donor", receiver: "Receiver", coordinator: "Coordinator" };

// One sentence per role: what you are here to do, and what you cannot do.
export const ROLE_JOB = {
  donor: "Your job: announce surplus food and hand it over. You can't say what was distributed. Only the receiver can.",
  receiver: "Your job: claim food that is on offer, confirm what actually arrived, then report what was given out, returned or thrown away.",
  coordinator: "Your job: watch for offers nobody claimed and counts that don't match, and resolve them.",
};

export function roleJob(role) {
  return ROLE_JOB[role] || "";
}

// The six steps shown on every lot, in plain words.
export const TRACKER = [
  { key: "OFFERED", label: "Offered", hint: "Donor announces food to every receiver" },
  { key: "ACCEPTED", label: "Accepted", hint: "A receiver claims it" },
  { key: "HANDOFF_DECLARED", label: "Handed over", hint: "Donor says how many they handed over" },
  { key: "RECEIVED", label: "Received", hint: "Receiver counts what really arrived" },
  { key: "DISTRIBUTING", label: "Given out", hint: "Receiver reports what went out" },
  { key: "ACCOUNTED_FOR", label: "Accounted for", hint: "Nothing outstanding, nothing disputed" },
];

// state per step: done | current | todo. An exception halts the tracker at the offer.
export function trackerSteps(lot) {
  const idx = TRACKER.findIndex((t) => t.key === lot.stage);
  const current = lot.stage === "EXCEPTION" ? 0 : idx;
  return TRACKER.map((t, i) => ({
    ...t,
    state: lot.stage === "ACCOUNTED_FOR" ? "done" : i < current ? "done" : i === current ? "current" : "todo",
  }));
}

// Plain label for the lot's state (no jargon).
export function plainStage(lot) {
  if (lot.stage === "EXCEPTION") return unclaimed(lot) ? "Nobody claimed it in time" : "Nobody answered";
  if (lot.stage === "OFFERED" && isOpenOffer(lot)) return "Waiting to be claimed";
  if (lot.count_dispute && lot.stage !== "ACCOUNTED_FOR") return "Counts don't match";
  return ({
    OFFERED: "Waiting for the receiver",
    ACCEPTED: "Accepted, waiting for handoff",
    HANDOFF_DECLARED: "Handed over, waiting for the count",
    RECEIVED: "Received",
    DISTRIBUTING: "Being given out",
    ACCOUNTED_FOR: "Accounted for",
  })[lot.stage] || "In progress";
}

// "What happens next" for this person, in a full sentence.
export function whatNext(lot, role) {
  const s = lot.stage;
  if (s === "EXCEPTION") {
    if (unclaimed(lot)) {
      return role === "coordinator"
        ? "Nobody claimed this lot in time. Nothing is assumed delivered. Follow up with the donor."
        : "Nobody claimed it in time, so the coordinator has been alerted. Nothing is assumed delivered.";
    }
    return role === "coordinator"
      ? "Nobody answered this offer in time. Nothing is assumed delivered. Follow up with the receiver."
      : "Nobody answered in time, so the coordinator has been alerted. Nothing is assumed delivered.";
  }
  if (s === "ACCOUNTED_FOR") return "Done. Everything received is given out, returned or thrown away, and nothing is disputed.";
  if (lot.count_dispute) {
    return role === "coordinator"
      ? "The donor and the receiver reported different counts. Confirm the real number with both and record it."
      : "The donor and the receiver reported different counts. You can keep reporting what you give out, but the lot stays open until the coordinator resolves it.";
  }
  const table = {
    receiver: {
      OFFERED: isOpenOffer(lot) ? "Nobody has claimed this yet. Claim it if you can collect it." : "A donor offered you this lot. Accept it if you can collect it.",
      ACCEPTED: "You accepted. Next, the donor hands it over and declares how many.",
      HANDOFF_DECLARED: "The donor says they handed it over. Count what really arrived and report it.",
      RECEIVED: "Report what went out, came back or was thrown away.",
      DISTRIBUTING: "Keep reporting until nothing is outstanding, then close the lot.",
    },
    donor: {
      OFFERED: isOpenOffer(lot) ? "Announced to every receiver. Waiting for someone to claim it." : "Waiting for the receiver to accept.",
      ACCEPTED: "Hand the food over, then declare how many you handed over. You'll get a one-time pickup code.",
      HANDOFF_DECLARED: "Give the pickup code to the receiver in person. They report what actually arrived.",
      RECEIVED: "The receiver is reporting what happened. You can't change their numbers.",
      DISTRIBUTING: "The receiver is reporting what happened. You can't change their numbers.",
    },
    coordinator: {
      OFFERED: isOpenOffer(lot) ? "Announced to every receiver. If nobody claims it in time, this becomes an exception." : "Waiting for the receiver. If nobody answers in time, this becomes an exception.",
      ACCEPTED: "Accepted. Waiting for the donor to hand over.",
      HANDOFF_DECLARED: "Waiting for the receiver to count what arrived.",
      RECEIVED: "The receiver is reporting. You'll be asked only if the counts don't match.",
      DISTRIBUTING: "The receiver is reporting. You'll be asked only if the counts don't match.",
    },
  };
  return (table[role] && table[role][s]) || "";
}

// The four numbers a person should be able to compare, in plain words.
export const COUNT_LABELS = [
  { key: "offered", label: "Offered", hint: "What the donor offered" },
  { key: "donor_handoff", label: "Handed over", hint: "What the donor says they handed over" },
  { key: "received", label: "Received", hint: "What the receiver counted" },
  { key: "distributed", label: "Given out", hint: "What the receiver reports went out" },
];

// "8 = 8 + 0 + 0 + 0" style line for a received lot, or "" before receipt.
export function equationText(lot) {
  if (lot.received == null) return "";
  return `${lot.received} received = ${lot.distributed || 0} given out + ${lot.returned || 0} returned + ${lot.disposed || 0} thrown away + ${remainingOf(lot)} still with the receiver`;
}

// Exceptions grouped newest first, with older ones separated so a long history stays readable.
export function splitRecent(lots, keep = 5) {
  const sorted = [...lots].sort((a, b) => (b.created_epoch || 0) - (a.created_epoch || 0));
  return { recent: sorted.slice(0, keep), older: sorted.slice(keep) };
}
