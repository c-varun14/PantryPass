// UI helpers: toasts, bottom sheets, number stepper, status chips, quantity bar,
// stage stepper and buttons. Rules come from logic.js; DOM building from dom.js.
import { el, svgIcon } from "./dom.js";
import { STAGES, STAGE_LABEL, stageFamily, remainingOf, qtySegments, clampQty } from "./logic.js";

const TOAST_MAX = 3;
const FADE_MS = 220;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

/** Returns the element with this id, creating it under <body> if missing. */
function mountRoot(id) {
  let node = document.getElementById(id);
  if (!node) {
    node = el("div", { id });
    document.body.append(node);
  }
  return node;
}

/* ---------- toast ---------- */

function dismissToast(node) {
  if (!node || node.classList.contains("is-leaving")) return;
  node.classList.add("is-leaving");
  setTimeout(() => node.remove(), FADE_MS);
}

const STAR_PATH = "M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.6 1-5.8-4.2-4.1 5.8-.8z";

/** Shows a message in #toast-root. Errors stay 6s, others 4s; at most 3 stacked. */
export function toast(message, type = "info") {
  const root = mountRoot("toast-root");
  const node = type === "reward"
    ? el("div", { class: "toast toast-reward" }, svgIcon(STAR_PATH, 18), el("span", { text: message }))
    : el("div", { class: `toast toast-${type}` }, message);
  root.append(node);

  const live = [...root.querySelectorAll(".toast:not(.is-leaving)")];
  while (live.length > TOAST_MAX) dismissToast(live.shift());

  setTimeout(() => dismissToast(node), type === "error" ? 6000 : 4000);
}

/* ---------- sheet (modal dialog) ---------- */

const sheetStack = [];
let lockCount = 0;
let savedOverflow = "";

function lockScroll() {
  if (lockCount++ === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
}

function unlockScroll() {
  if (lockCount > 0 && --lockCount === 0) document.body.style.overflow = savedOverflow;
}

/**
 * Opens a modal bottom sheet. Returns {close()}; onClose runs once.
 * Only the topmost sheet responds to ESC and Tab.
 */
export function openSheet({ title, body, footer, onClose } = {}) {
  const prev = document.activeElement;
  const titleId = nextId("sheet-title");
  let closed = false;
  let pressStartedOnBackdrop = false;

  const sheet = el(
    "div",
    { class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1" },
    el("div", { class: "sheet-handle", "aria-hidden": "true" }),
    el("div", { class: "sheet-head" },
      el("h2", { class: "sheet-title", id: titleId }, title),
      el("button", { class: "sheet-close", type: "button", "aria-label": "Close", onclick: () => close() },
        el("span", { "aria-hidden": "true" }, "×"))),
    el("div", { class: "sheet-body" }, body),
    footer ? el("div", { class: "sheet-foot" }, footer) : null,
  );
  const backdrop = el("div", { class: "sheet-backdrop" }, sheet);
  const entry = { sheet, close: () => close() };

  backdrop.addEventListener("pointerdown", (e) => {
    pressStartedOnBackdrop = e.target === backdrop;
  });
  backdrop.addEventListener("click", (e) => {
    if (pressStartedOnBackdrop && e.target === backdrop) close();
  });

  function onKey(e) {
    if (sheetStack[sheetStack.length - 1] !== entry) return;
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...sheet.querySelectorAll(FOCUSABLE)];
    if (!items.length) {
      e.preventDefault();
      sheet.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!sheet.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && (active === first || active === sheet)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    const i = sheetStack.indexOf(entry);
    if (i !== -1) sheetStack.splice(i, 1);
    unlockScroll();
    backdrop.classList.remove("is-open");
    if (prev && prev.isConnected && typeof prev.focus === "function") prev.focus();

    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      backdrop.remove();
    };
    backdrop.addEventListener("transitionend", (e) => {
      if (e.target === sheet) remove();
    });
    setTimeout(remove, FADE_MS);

    if (typeof onClose === "function") onClose();
  }

  mountRoot("sheet-root").append(backdrop);
  sheetStack.push(entry);
  lockScroll();
  document.addEventListener("keydown", onKey);
  (sheet.querySelector(FOCUSABLE) || sheet).focus();
  requestAnimationFrame(() => {
    if (!closed) backdrop.classList.add("is-open");
  });

  return { close };
}

/* ---------- number stepper ---------- */

/**
 * Integer stepper. onChange fires on committed changes (buttons, long-press,
 * arrow keys, blur/Enter), not for setValue. Returns {el, getValue, setValue, setError}.
 */
export function numStepper({ value, min = 0, max = Infinity, label, onChange } = {}) {
  let current = clampQty(value == null ? min : Number(value), min, max);
  const inputId = nextId("num");
  const errorId = `${inputId}-error`;

  const minus = el("button", { class: "num-btn", type: "button",
    "aria-label": label ? `Decrease ${label}` : "Decrease" }, "−");
  const plus = el("button", { class: "num-btn", type: "button",
    "aria-label": label ? `Increase ${label}` : "Increase" }, "+");
  const input = el("input", { class: "num-input", id: inputId, type: "text", inputmode: "numeric",
    pattern: "[0-9]*", autocomplete: "off", "aria-label": label, "aria-describedby": errorId });
  const error = el("div", { class: "field-error", id: errorId, role: "alert", hidden: true });
  const field = el("div", { class: "field" },
    label ? el("label", { class: "field-label", for: inputId }, label) : null,
    el("div", { class: "num-stepper" }, minus, input, plus),
    error);

  function render() {
    input.value = String(current);
    minus.disabled = current <= min;
    plus.disabled = current >= max;
  }

  function commit(next) {
    const changed = next !== current;
    current = next;
    render();
    if (changed && typeof onChange === "function") onChange(current);
    return changed;
  }

  const step = (delta) => commit(clampQty(current + delta, min, max));

  function commitFromInput() {
    commit(clampQty(parseInt(input.value, 10), min, max));
  }

  function stepFromInput(delta) {
    const typed = parseInt(input.value, 10);
    commit(clampQty((Number.isNaN(typed) ? current : typed) + delta, min, max));
  }

  // Long-press: step once, then repeat after 400ms, accelerating down to 40ms.
  let stopRepeat = null;
  function startPress(btn, delta, e) {
    if (btn.disabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (stopRepeat) stopRepeat();
    commitFromInput();
    if (!step(delta)) return;

    let delay = 400;
    let timer = null;
    const tick = () => {
      if (!step(delta)) {
        stop();
        return;
      }
      delay = Math.max(40, Math.round(delay * 0.8));
      timer = setTimeout(tick, delay);
    };
    const stop = () => {
      clearTimeout(timer);
      btn.removeEventListener("pointerup", stop);
      btn.removeEventListener("pointerleave", stop);
      btn.removeEventListener("pointercancel", stop);
      if (stopRepeat === stop) stopRepeat = null;
    };
    stopRepeat = stop;
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointerleave", stop);
    btn.addEventListener("pointercancel", stop);
    timer = setTimeout(tick, delay);
  }

  minus.addEventListener("pointerdown", (e) => startPress(minus, -1, e));
  plus.addEventListener("pointerdown", (e) => startPress(plus, 1, e));
  // detail === 0 means keyboard activation; pointer clicks were handled on pointerdown.
  minus.addEventListener("click", (e) => {
    if (e.detail !== 0) return;
    commitFromInput();
    step(-1);
  });
  plus.addEventListener("click", (e) => {
    if (e.detail !== 0) return;
    commitFromInput();
    step(1);
  });

  input.addEventListener("input", () => {
    const clean = input.value.replace(/\D/g, "");
    if (clean !== input.value) input.value = clean;
  });
  input.addEventListener("blur", commitFromInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitFromInput();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      stepFromInput(1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      stepFromInput(-1);
    }
  });

  function setError(msg) {
    error.textContent = msg || "";
    error.hidden = !msg;
    if (msg) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function setValue(n) {
    current = clampQty(Number(n), min, max);
    render();
  }

  render();
  return { el: field, getValue: () => current, setValue, setError };
}

/* ---------- chip ---------- */

/** Stage chip, coloured by stageFamily, with a count-dispute suffix when relevant. */
export function chip(lot) {
  let text = STAGE_LABEL[lot.stage] || lot.stage;
  if (lot.count_dispute && lot.stage !== "EXCEPTION" && lot.stage !== "ACCOUNTED_FOR") {
    text += " · count dispute";
  }
  return el("span", { class: `chip chip-${stageFamily(lot)}` },
    el("span", { class: "chip-dot", "aria-hidden": "true" }), text);
}

/* ---------- quantity bar ---------- */

const QTY_KEYS = [
  ["distributed", "Distributed"],
  ["returned", "Returned"],
  ["disposed", "Disposed"],
  ["remaining", "Remaining"],
];

/** Stacked bar plus legend of distributed/returned/disposed/remaining (or Offered before receipt). */
export function qtyBar(lot) {
  const segments = qtySegments(lot);
  let label;
  let legend;
  if (lot.received != null) {
    const counts = {
      distributed: lot.distributed || 0,
      returned: lot.returned || 0,
      disposed: lot.disposed || 0,
      remaining: remainingOf(lot),
    };
    label = `Distributed ${counts.distributed}, returned ${counts.returned}, ` +
      `disposed ${counts.disposed}, remaining ${counts.remaining} of ${lot.received} received`;
    legend = QTY_KEYS.map(([key, name]) => [key, `${name} ${counts[key]}`]);
  } else {
    const offered = lot.offered || 0;
    label = `Offered ${offered}, not yet received`;
    legend = [["remaining", `Offered ${offered}`]];
  }

  const bar = el("div", { class: "qty-bar", role: "img", "aria-label": label },
    segments.map((s) => el("div", { class: `qty-seg qty-${s.key}`, style: `width:${s.pct}%` })));
  const legendEl = el("div", { class: "qty-legend" },
    legend.map(([key, text]) => el("span", { class: "qty-key" },
      el("span", { class: `qty-swatch qty-${key}`, "aria-hidden": "true" }), text)));
  return el("div", { class: "qty" }, bar, legendEl);
}

/* ---------- stage stepper ---------- */

/** Progress through STAGES. EXCEPTION shows progress up to OFFERED plus a red "Needs attention" step. */
export function stageStepper(lot) {
  const exception = lot.stage === "EXCEPTION";
  const current = exception ? STAGES.indexOf("OFFERED") : STAGES.indexOf(lot.stage);
  const shown = exception ? STAGES.slice(0, current + 1) : STAGES;

  const items = shown.map((stage, i) => {
    const state = i < current ? "is-done" : i === current ? "is-current" : "is-todo";
    return el("div", { class: `stage-step ${state}`, role: "listitem",
      "aria-current": state === "is-current" ? "step" : null },
      el("span", { class: "stage-dot", "aria-hidden": "true" }),
      el("span", { class: "stage-label" }, STAGE_LABEL[stage]));
  });
  if (exception) {
    items.push(el("div", { class: "stage-step is-exception", role: "listitem" },
      el("span", { class: "stage-dot", "aria-hidden": "true" }),
      el("span", { class: "stage-label" }, STAGE_LABEL.EXCEPTION)));
  }

  return el("div", { class: `stage-stepper${exception ? " is-exception" : ""}`,
    role: "list", "aria-label": "Progress" }, items);
}

/* ---------- buttons ---------- */

const priorDisabled = new WeakMap();

/** Button with the label wrapped in .btn-label so it stays accessible while loading. */
export function button(label, { variant = "secondary", onClick, loading = false, disabled = false, block = false } = {}) {
  const btn = el("button", {
    type: "button",
    class: `btn btn-${variant}${block ? " btn-block" : ""}`,
    onclick: onClick,
  }, el("span", { class: "btn-label" }, label));
  if (disabled) btn.disabled = true;
  if (loading) setLoading(btn, true);
  return btn;
}

/** Toggles loading state; restores the previous disabled state when loading ends. */
export function setLoading(btn, on) {
  const isOn = !!on;
  const wasOn = btn.classList.contains("is-loading");
  if (isOn === wasOn) return;
  btn.classList.toggle("is-loading", isOn);
  btn.setAttribute("aria-busy", String(isOn));
  if (isOn) {
    priorDisabled.set(btn, btn.disabled);
    btn.disabled = true;
  } else {
    btn.disabled = priorDisabled.get(btn) === true;
    priorDisabled.delete(btn);
  }
}

/* ---------- avatar ---------- */

/** Initial in a coloured circle. role: donor | receiver | coordinator (tints it); size: s | m | l. */
export function avatar(name, role, size = "m") {
  const letter = String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim().charAt(0).toUpperCase() || "?";
  return el("span", { class: `avatar avatar-${size} role-${role || "none"}`, "aria-hidden": "true", text: letter });
}

/* ---------- 3D illustration ---------- */

/** Decorative Fluent Emoji 3D picture (MIT, see vendor/fluent3d/LICENSE): package, handshake, seedling,
 *  check_mark_button, locked, warning, bread, herb, trophy, delivery_truck, sparkles, hourglass_not_done. */
export function img3d(name, size = 96) {
  return el("img", { class: "img3d", src: `vendor/fluent3d/${name}_3d.png`, width: size, height: size, alt: "", "aria-hidden": "true", decoding: "async" });
}

/* ---------- full-screen celebration ("ALL DONE!") ---------- */

/** Full-screen success moment with a 3D picture, a display headline and one call-to-action button.
 *  Returns { close }. Esc and the button both close it and call onDone once. */
export function celebrate({ title = "All done!", text = "", image = "check_mark_button", cta = "Done", onDone } = {}) {
  const prev = document.activeElement;
  const titleId = nextId("celebrate-title");
  let closed = false;
  const doneBtn = el("button", { type: "button", class: "btn btn-primary btn-block", onclick: () => close() }, el("span", { class: "btn-label", text: cta }));
  const node = el("div", { class: "celebrate", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1" },
    el("div", { class: "celebrate-body" },
      el("div", { class: "celebrate-art" }, img3d(image, 168)),
      el("h2", { class: "celebrate-title", id: titleId, text: title }),
      text ? el("p", { class: "celebrate-text", text }) : null),
    el("div", { class: "celebrate-foot" }, doneBtn));
  function onKey(e) { if (e.key === "Escape") close(); }
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    node.classList.add("is-leaving");
    setTimeout(() => { node.remove(); unlockScroll(); if (prev && prev.focus) prev.focus(); }, FADE_MS);
    if (onDone) onDone();
  }
  document.addEventListener("keydown", onKey);
  mountRoot("sheet-root").append(node);
  lockScroll();
  doneBtn.focus();
  return { close };
}

/* ---------- one-box-per-digit code input ---------- */

/** Wise-style OTP boxes. Returns { el, getValue(), setValue(s), setError(msg), focus() }.
 *  Digits only, auto-advance, Backspace steps back, pasting spreads across the boxes. */
export function otpInput({ length = 6, label = "Code", onChange } = {}) {
  const boxes = Array.from({ length }, (_, i) => el("input", {
    class: "otp-box", type: "text", inputmode: "numeric", pattern: "[0-9]*", maxlength: "1",
    autocomplete: i === 0 ? "one-time-code" : "off", "aria-label": `${label}, digit ${i + 1} of ${length}`,
  }));
  const err = el("p", { class: "field-error", role: "alert", hidden: true });
  const wrap = el("div", { class: "otp" }, el("div", { class: "otp-row", role: "group", "aria-label": label }, boxes), err);
  const value = () => boxes.map((b) => b.value).join("");
  const changed = () => { if (onChange) onChange(value()); };
  boxes.forEach((b, i) => {
    b.addEventListener("input", () => {
      const digits = b.value.replace(/\D/g, "");
      b.value = digits.slice(-1);
      if (b.value && i < length - 1) boxes[i + 1].focus();
      changed();
    });
    b.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !b.value && i > 0) { boxes[i - 1].value = ""; boxes[i - 1].focus(); changed(); }
      else if (e.key === "ArrowLeft" && i > 0) boxes[i - 1].focus();
      else if (e.key === "ArrowRight" && i < length - 1) boxes[i + 1].focus();
    });
    b.addEventListener("focus", () => b.select());
    b.addEventListener("paste", (e) => {
      const text = ((e.clipboardData && e.clipboardData.getData("text")) || "").replace(/\D/g, "").slice(0, length);
      if (!text) return;
      e.preventDefault();
      boxes.forEach((x, j) => { x.value = text[j] || ""; });
      boxes[Math.min(text.length, length - 1)].focus();
      changed();
    });
  });
  return {
    el: wrap,
    getValue: value,
    setValue(s) { boxes.forEach((b, j) => { b.value = (String(s || "").replace(/\D/g, ""))[j] || ""; }); changed(); },
    setError(msg) { err.hidden = !msg; err.textContent = msg || ""; wrap.classList.toggle("has-error", !!msg); },
    focus() { boxes[0].focus(); },
  };
}
