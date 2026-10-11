// Animated service graph: the AWS architecture as SVG, with packets that travel the edges.
// Pure SVG + requestAnimationFrame. Packets move with path.getPointAtLength, so it needs no SMIL
// and no CSS offset-path, and it records the same in headless Chromium.
//
//   import { mountArchGraph } from "./archgraph.js";
//   const graph = mountArchGraph(box, { mini: false, interactive: true });
//   graph.play("intro", { onStep: (s) => console.log(s.label) });
//
// Mini corner widget from any page: mountArchGraph(div, { mini: true }) with div appended to the body.
// Reduced motion: no packets; the edges and nodes light up in the same order instead.

const NS = "http://www.w3.org/2000/svg";
const W = 210;
const H = 96;
const COL = [24, 375, 726];          // three columns, as on the About page
const ROW = [24, 172, 320, 468, 616, 764]; // six rows (r5 holds the money services)
const VIEW_W = 960;
const VIEW_H = 900;
const KINDS = ["allow", "deny", "wait", "notify"];
const DEFAULT_MS = 900;
const PAUSE_MS = 1200;
const PULSE_MS = 600;
const DENY_LINGER_MS = 1200;
const FOLLOW_MS = 700;
const FULL_VIEW = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };

// c, r: grid cell. neutral: not an AWS service (browser, phone), drawn dashed.
const NODES = [
  { id: "svc-cognito", title: "Amazon Cognito", sub: "sign-in, token carries role", c: 0, r: 0 },
  { id: "svc-apigw", title: "API Gateway", sub: "front door, checks token", c: 1, r: 0 },
  { id: "svc-sfn", title: "Step Functions", sub: "durable wait for the receiver", c: 2, r: 0 },
  { id: "svc-browser", title: "Browser", sub: "the person using it", c: 0, r: 1, neutral: true },
  { id: "svc-lambda", title: "AWS Lambda", sub: "Python and Go: the logic", c: 1, r: 1 },
  { id: "svc-avp", title: "Verified Permissions", sub: "Cedar: allow or deny per action", c: 2, r: 1 },
  { id: "svc-s3cf", title: "S3 and CloudFront", sub: "serves this site", c: 1, r: 4 },
  { id: "svc-ddb", title: "DynamoDB", sub: "lots, hash-chained events", c: 1, r: 2 },
  { id: "svc-stream", title: "DynamoDB Streams", sub: "every new event", c: 2, r: 2 },
  { id: "svc-phone", title: "Phone", sub: "donor, receiver, coordinator", c: 0, r: 3, neutral: true },
  { id: "svc-whatsapp", title: "WhatsApp Cloud API", sub: "messages to the three roles", c: 1, r: 3 },
  { id: "svc-notifier", title: "Notifier Lambda", sub: "turns events into messages", c: 2, r: 3 },
  { id: "svc-cw", title: "CloudWatch and X-Ray", sub: "dashboard, metrics, traces", c: 0, r: 4 },
  { id: "svc-secrets", title: "Secrets Manager", sub: "WhatsApp and Razorpay keys", c: 2, r: 4 },
  // Under the browser. Photos are uploaded straight here, never through the Lambda.
  { id: "svc-photos", title: "S3 photo bucket", sub: "presigned upload, write-once", c: 0, r: 2 },
  // Money row. Razorpay is outside AWS, so it is neutral. KMS seals bank account numbers; payouts holds the sealed record.
  { id: "svc-razorpay", title: "Razorpay", sub: "payment gateway, checkout", c: 0, r: 5, neutral: true },
  { id: "svc-kms", title: "AWS KMS", sub: "seals bank account numbers", c: 1, r: 5 },
  { id: "svc-payouts", title: "DynamoDB payouts", sub: "bank details, donations, transfers", c: 2, r: 5 },
];

// pts: the route in viewBox units. lab: where the label sits (above, below, left, right).
// wrap: characters per label line. dashed: a subtler or indirect call.
const EDGES = [
  { id: "e_site", from: "svc-browser", to: "svc-s3cf", label: "loads the site", lab: "right",
    pts: [[234, 250], [300, 250], [300, 640], [375, 640]] },
  { id: "e_signin", from: "svc-browser", to: "svc-cognito", label: "sign in", lab: "right",
    pts: [[75, 172], [75, 120]] },
  { id: "e_req", from: "svc-browser", to: "svc-apigw", label: "request + signed token", lab: "below", wrap: 16,
    pts: [[200, 172], [200, 146], [420, 146], [420, 120]] },
  { id: "e_jwt", from: "svc-apigw", to: "svc-cognito", label: "check signature", lab: "above", dashed: true,
    pts: [[375, 50], [234, 50]] },
  { id: "e_invoke", from: "svc-apigw", to: "svc-lambda", label: "verified request", lab: "right", wrap: 12,
    pts: [[480, 120], [480, 172]] },
  { id: "e_authz", from: "svc-lambda", to: "svc-avp", label: "IsAuthorized?", lab: "above",
    pts: [[585, 196], [726, 196]] },
  { id: "e_decision", from: "svc-avp", to: "svc-lambda", label: "ALLOW or DENY", lab: "below", wrap: 20,
    pts: [[726, 228], [585, 228]] },
  { id: "e_txn", from: "svc-lambda", to: "svc-ddb", label: "one transaction: count + event", lab: "right", wrap: 18,
    pts: [[455, 268], [455, 320]] },
  { id: "e_sfn", from: "svc-lambda", to: "svc-sfn", label: "start / resume the wait", lab: "above",
    pts: [[565, 172], [565, 134], [745, 134], [745, 120]] },
  { id: "e_timeout", from: "svc-sfn", to: "svc-lambda", label: "deadline passed: escalate", lab: "above", wrap: 30,
    pts: [[790, 120], [790, 156], [580, 156], [580, 172]] },
  { id: "e_stream", from: "svc-ddb", to: "svc-stream", label: "new event", lab: "above",
    pts: [[585, 368], [726, 368]] },
  { id: "e_trigger", from: "svc-stream", to: "svc-notifier", label: "invoke", lab: "right",
    pts: [[831, 416], [831, 468]] },
  { id: "e_secret", from: "svc-secrets", to: "svc-notifier", label: "WhatsApp key", lab: "right",
    pts: [[831, 616], [831, 564]] },
  { id: "e_msg", from: "svc-notifier", to: "svc-whatsapp", label: "message", lab: "above",
    pts: [[726, 516], [585, 516]] },
  { id: "e_phone", from: "svc-whatsapp", to: "svc-phone", label: "message", lab: "above",
    pts: [[375, 516], [234, 516]] },
  { id: "e_obs", from: "svc-lambda", to: "svc-cw", label: "logs + traces", lab: "left", dashed: true,
    pts: [[375, 240], [330, 240], [330, 664], [234, 664]] },
  // Same pair as e_txn, drawn as a parallel line. Used only by the tamper flow.
  { id: "e_iam", from: "svc-lambda", to: "svc-ddb", label: "edit an old event: AccessDenied (IAM)", lab: "right", wrap: 18,
    pts: [[515, 268], [515, 320]] },
  // Photo evidence. The browser uploads to the bucket with a presigned form. The Lambda reads it back at commit.
  { id: "e_photo_up", from: "svc-browser", to: "svc-photos", label: "photo, presigned upload", lab: "right", wrap: 12, dashed: true,
    pts: [[129, 268], [129, 320]] },
  { id: "e_photo_hash", from: "svc-lambda", to: "svc-photos", label: "read + SHA-256 fingerprint", lab: "left", wrap: 13,
    pts: [[375, 258], [345, 258], [345, 368], [234, 368]] },
  // Money. The Lambda creates the order at Razorpay; Razorpay posts a signed webhook back through API Gateway.
  { id: "e_rzp_order", from: "svc-lambda", to: "svc-razorpay", label: "create order", lab: "right", wrap: 14,
    pts: [[400, 268], [400, 294], [360, 294], [360, 780], [234, 780]] },
  { id: "e_rzp_hook", from: "svc-razorpay", to: "svc-apigw", label: "signed webhook", lab: "right", wrap: 14, dashed: true,
    pts: [[234, 812], [255, 812], [255, 96], [375, 96]] },
  { id: "e_rzp_key", from: "svc-lambda", to: "svc-secrets", label: "fetch Razorpay key", lab: "right", wrap: 14, dashed: true,
    pts: [[545, 268], [545, 294], [700, 294], [700, 640], [726, 640]] },
  // Bank account numbers are sealed by KMS before they reach the payouts table. Only the masked number is returned.
  { id: "e_kms", from: "svc-lambda", to: "svc-kms", label: "seal account number", lab: "left", wrap: 12,
    pts: [[585, 256], [620, 256], [620, 800], [585, 800]] },
  { id: "e_payouts", from: "svc-lambda", to: "svc-payouts", label: "store sealed record", lab: "above", wrap: 14,
    pts: [[585, 244], [660, 244], [660, 800], [726, 800]] },
];

// A step is an edge id, or { edge, kind, label, ms, lane }. kind: allow | deny | wait | notify.
// "pause" is a short hold. { pause: ms, node } holds and pulses that node. { par: [...] } runs in parallel,
// and an array inside par is a sequence.
const FLOWS = {
  intro: [
    "e_site", "e_signin", "e_req", "e_invoke", "e_authz",
    { edge: "e_decision", kind: "allow" },
    { edge: "e_txn", kind: "allow" },
    { edge: "e_sfn", kind: "wait", label: "task token parked" },
    "pause",
    { edge: "e_stream", kind: "notify" },
    { edge: "e_trigger", kind: "notify" },
    { edge: "e_secret", kind: "notify" },
    { edge: "e_msg", kind: "notify" },
    { edge: "e_phone", kind: "notify" },
    "e_obs",
  ],
  allow: [
    "e_req", "e_invoke", "e_authz",
    { edge: "e_decision", kind: "allow" },
    { edge: "e_txn", kind: "allow" },
    "e_obs",
  ],
  deny: [
    "e_req", "e_invoke", "e_authz",
    { edge: "e_decision", kind: "deny", label: "DENY: donor cannot report distribution" },
    { edge: "e_txn", kind: "deny", label: "DENY recorded as an event" },
  ],
  wait: [
    { edge: "e_sfn", kind: "wait", label: "task token parked" },
    { pause: 1500, node: "svc-sfn" },
    { edge: "e_timeout", kind: "allow", label: "deadline passed: escalate" },
    { edge: "e_txn", kind: "allow" },
  ],
  txn: [
    { par: [
      { edge: "e_txn", kind: "allow", label: "committed", lane: -6 },
      { edge: "e_txn", kind: "deny", label: "rejected: stale version", lane: 6 },
    ] },
  ],
  notify: [
    { edge: "e_stream", kind: "notify" },
    { edge: "e_trigger", kind: "notify" },
    { par: [{ edge: "e_secret", kind: "notify" }, { pause: 450 }] },
    { edge: "e_msg", kind: "notify" },
    { edge: "e_phone", kind: "notify" },
  ],
  tamper: [
    { edge: "e_iam", kind: "deny", label: "edit an old event: AccessDenied (IAM)" },
  ],
  site: ["e_site"],
  money: [
    { edge: "e_req", kind: "allow", label: "Donate to a top donor" },
    "e_invoke",
    "e_authz",
    { edge: "e_decision", kind: "allow" },
    { edge: "e_rzp_order", kind: "allow", label: "Order created at the gateway" },
    { edge: "e_rzp_hook", kind: "notify", label: "Payment captured: signed webhook" },
    { edge: "e_invoke", kind: "allow", label: "Webhook verified" },
    { edge: "e_kms", kind: "allow", label: "Account number sealed by KMS" },
    { edge: "e_payouts", kind: "allow", label: "Stored: only the masked number is ever returned" },
  ],
  photo: [
    { edge: "e_req", kind: "allow" },
    { edge: "e_photo_up", kind: "allow" },
    { edge: "e_invoke", kind: "allow" },
    { edge: "e_photo_hash", kind: "allow", label: "fingerprint goes into the chained event" },
    { edge: "e_txn", kind: "allow" },
  ],
};

const EDGE_BY_ID = Object.fromEntries(EDGES.map((e) => [e.id, e]));
const NODE_BY_ID = Object.fromEntries(NODES.map((n) => [n.id, n]));

// Viewbox rectangle that frames the given nodes (plus pad), widened to the container aspect and never narrower than minW.
function frameFor(ids, aspect, pad, minW) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const n = NODE_BY_ID[id];
    if (!n) continue;
    const x = COL[n.c], y = ROW[n.r];
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + W); y1 = Math.max(y1, y + H);
  }
  if (x0 === Infinity) return FULL_VIEW;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let w = x1 - x0;
  let h = y1 - y0;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  if (w < minW) { w = minW; h = w / aspect; }
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
const MOUNTED = new WeakMap();
let seq = 0;

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function svgNode(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// Greedy word wrap for edge labels. Labels are short, so no measuring is needed.
function wrap(text, max) {
  const lines = [];
  let cur = "";
  for (const word of String(text).split(" ")) {
    if (cur && (cur + " " + word).length > max) { lines.push(cur); cur = word; }
    else cur = cur ? cur + " " + word : word;
  }
  if (cur) lines.push(cur);
  return lines;
}

function markup(uid) {
  const nodes = NODES.map((n) => {
    const x = COL[n.c];
    const y = ROW[n.r];
    return `<g class="arch-node${n.neutral ? " is-neutral" : ""}" data-node="${n.id}">
      <title>${esc(n.title)}: ${esc(n.sub)}</title>
      <rect x="${x}" y="${y}" width="${W}" height="${H}" rx="16"/>
      <text class="arch-title" x="${x + W / 2}" y="${y + 42}" text-anchor="middle">${esc(n.title)}</text>
      <text class="arch-sub" x="${x + W / 2}" y="${y + 66}" text-anchor="middle">${esc(n.sub)}</text>
    </g>`;
  }).join("");
  const edges = EDGES.map((e) => {
    const d = e.pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
    return `<path class="arch-edge${e.dashed ? " is-dashed" : ""}" data-edge="${e.id}" d="${d}" marker-end="url(#${uid}-arrow)"/>`;
  }).join("");
  return `<svg class="arch-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-labelledby="${uid}-title" xmlns="${NS}">
    <title id="${uid}-title">PantryPass on AWS, region ap-south-1. Choose a flow below to watch a request move through the services.</title>
    <defs>
      <marker id="${uid}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="arch-arrow" d="M0 0L10 5L0 10z"/>
      </marker>
    </defs>
    ${edges}
    ${nodes}
    <g class="arch-packets"></g>
    <g class="arch-tags"></g>
    <text class="arch-region" x="936" y="888" text-anchor="end">Region ap-south-1</text>
  </svg>`;
}

export function mountArchGraph(container, opts = {}) {
  const prev = MOUNTED.get(container);
  if (prev) prev.stop();

  const mini = !!opts.mini;
  const stage = !!opts.stage;
  const interactive = opts.interactive !== false;
  const uid = `arch${++seq}`;

  const root = document.createElement("div");
  root.className = "arch-graph" + (mini ? " arch-mini" : "") + (stage ? " arch-stage" : "")
    + (interactive ? " is-interactive" : "");
  root.innerHTML = markup(uid);
  container.replaceChildren(root);

  const layers = {
    packets: root.querySelector(".arch-packets"),
    tags: root.querySelector(".arch-tags"),
  };
  const nodeMap = {};
  for (const n of NODES) nodeMap[n.id] = root.querySelector(`[data-node="${n.id}"]`);
  const paths = {};
  for (const e of EDGES) paths[e.id] = root.querySelector(`[data-edge="${e.id}"]`);

  const reducedMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const svg = root.querySelector("svg");

  // Camera: the svg viewBox, animated. A new animation cancels the old one and resolves its promise.
  let cam = { ...FULL_VIEW };
  let camRaf = 0;
  let camToken = 0;
  let camResolve = null;
  function setView(v) {
    cam = v;
    svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  }
  function aspectOf() {
    const r = svg.getBoundingClientRect();
    return r.width && r.height ? r.width / r.height : VIEW_W / VIEW_H;
  }
  function animateTo(target, ms) {
    const token = ++camToken;
    if (camRaf) cancelAnimationFrame(camRaf);
    camRaf = 0;
    if (camResolve) { const done = camResolve; camResolve = null; done(); }
    const from = { ...cam };
    if (!ms || (reducedMq && reducedMq.matches)) { setView(target); return Promise.resolve(); }
    return new Promise((resolve) => {
      camResolve = resolve;
      const t0 = performance.now();
      const tick = (now) => {
        if (token !== camToken) return;
        const t = Math.min(1, Math.max(0, (now - t0) / ms));
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease-in-out cubic
        const lerp = (a, b) => a + (b - a) * e;
        setView({ x: lerp(from.x, target.x), y: lerp(from.y, target.y), w: lerp(from.w, target.w), h: lerp(from.h, target.h) });
        if (t >= 1) {
          camRaf = 0;
          camResolve = null;
          resolve();
        } else {
          camRaf = requestAnimationFrame(tick);
        }
      };
      camRaf = requestAnimationFrame(tick);
    });
  }
  function focusNodes(ids, ms, pad, minW) {
    return animateTo(frameFor(ids, aspectOf(), pad, minW), ms);
  }

  const geo = {};          // edge id -> { len, mid } (measured lazily, once)
  const active = new Set(); // packets in flight
  const timers = new Set(); // pending timeouts; sleeps also carry their resolver
  let run = 0;              // bumped by every play, stop and clear; old runs check it and bail out
  let raf = 0;

  function later(ms, fn) {
    const entry = {};
    entry.id = setTimeout(() => { timers.delete(entry); fn(); }, ms);
    timers.add(entry);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const entry = { resolve };
      entry.id = setTimeout(() => { timers.delete(entry); resolve(); }, ms);
      timers.add(entry);
    });
  }

  function cancelTimers() {
    for (const entry of timers) {
      clearTimeout(entry.id);
      if (entry.resolve) entry.resolve();
    }
    timers.clear();
  }

  function geoOf(edge) {
    if (!geo[edge.id]) {
      const el = paths[edge.id];
      const len = el.getTotalLength();
      geo[edge.id] = { len, mid: el.getPointAtLength(len / 2) };
    }
    return geo[edge.id];
  }

  function place(p, s) {
    const el = paths[p.edge.id];
    const { len } = geoOf(p.edge);
    const pt = el.getPointAtLength(s);
    let x = pt.x;
    let y = pt.y;
    if (p.lane) {
      const a = el.getPointAtLength(Math.max(0, s - 1));
      const b = el.getPointAtLength(Math.min(len, s + 1));
      const tx = b.x - a.x;
      const ty = b.y - a.y;
      const n = Math.hypot(tx, ty) || 1;
      x += (-ty / n) * p.lane;
      y += (tx / n) * p.lane;
    }
    p.dot.setAttribute("cx", x.toFixed(1));
    p.dot.setAttribute("cy", y.toFixed(1));
  }

  function frame(now) {
    raf = 0;
    for (const p of [...active]) {
      const f = Math.min(1, Math.max(0, (now - p.t0) / p.dur));
      place(p, f * geoOf(p.edge).len);
      if (f >= 1) active.delete(p);
    }
    if (active.size) raf = requestAnimationFrame(frame);
  }

  function spawn(edge, kind, lane, ms, deny) {
    const dot = svgNode("circle", { r: 7, class: `arch-pkt arch-pkt--${kind}` });
    layers.packets.append(dot);
    const p = { edge, lane, dot, dur: ms, t0: performance.now() };
    place(p, 0);
    active.add(p);
    if (deny) later(ms + DENY_LINGER_MS, () => dot.remove());
    if (!raf) raf = requestAnimationFrame(frame);
    return p;
  }

  // A label for one packet. Several labels on one edge stack, so "two at once" stays readable.
  function tagFor(edge, text, kind) {
    const { mid } = geoOf(edge);
    const k = layers.tags.querySelectorAll(`[data-tag-edge="${edge.id}"]`).length;
    const lines = wrap(text, edge.wrap || 22);
    const n = lines.length;
    const LH = 16;
    const step = n * LH + 6;
    let x = mid.x;
    let y0;
    let anchor = "middle";
    if (edge.lab === "above") y0 = mid.y - 9 - (n - 1) * LH - k * step;
    else if (edge.lab === "below") y0 = mid.y + 17 + k * step;
    else {
      // Side labels alternate sides of the line, so two packets on a short vertical edge stay clear.
      const onRight = (edge.lab === "right") !== (k % 2 === 1);
      y0 = mid.y - ((n - 1) * LH) / 2 + 4 + Math.floor(k / 2) * step;
      x = onRight ? mid.x + 10 : mid.x - 10;
      anchor = onRight ? "start" : "end";
    }
    const g = svgNode("g", { class: `arch-tag arch-tag--${kind}`, "data-tag-edge": edge.id });
    const t = svgNode("text", { x, y: y0, "text-anchor": anchor });
    lines.forEach((line, i) => t.append(svgNode("tspan", { x, dy: i ? LH : 0 }, line)));
    g.append(t);
    layers.tags.append(g);
    return g;
  }

  function pulse(node) {
    node.classList.add("is-pulse");
    later(PULSE_MS, () => node.classList.remove("is-pulse"));
  }

  async function runStep(step, ctx) {
    if (ctx.run !== run) return;
    if (step.pause != null) {
      const node = step.node ? nodeMap[step.node] : null;
      if (ctx.follow && step.node) {
        focusNodes([step.node, ...ctx.prev], FOLLOW_MS, 40, 520);
        ctx.prev = [step.node];
      }
      if (node) node.classList.add("is-waiting");
      await sleep(step.pause);
      if (node) node.classList.remove("is-waiting");
      return;
    }
    const edge = EDGE_BY_ID[step.edge];
    const kind = step.kind || "allow";
    const ms = step.ms ?? DEFAULT_MS;
    const deny = kind === "deny";
    const text = step.label || edge.label;
    const pathEl = paths[edge.id];
    const to = nodeMap[edge.to];

    if (ctx.onStep) {
      try { ctx.onStep({ edge: edge.id, kind, label: text, ms }); } catch (err) { console.error(err); }
    }
    if (ctx.follow) {
      const ids = [edge.from, edge.to];
      focusNodes([...ids, ...ctx.prev], FOLLOW_MS, 40, 520);
      ctx.prev = ids;
    }
    const tag = tagFor(edge, text, kind);
    pathEl.classList.add("is-on", `is-${kind}`);
    const p = ctx.reduce ? null : spawn(edge, kind, step.lane || 0, ms, deny);
    await sleep(ms);
    if (ctx.run !== run) return;

    pathEl.classList.remove("is-on", `is-${kind}`);
    if (p && !deny) p.dot.remove();
    if (deny) {
      // A refused packet stops at its target. The target gets a red outline and the label stays for a moment.
      to.classList.add("is-denied");
      later(DENY_LINGER_MS, () => { tag.remove(); to.classList.remove("is-denied"); });
    } else {
      pulse(to);
      tag.remove();
    }
  }

  async function runItem(item, ctx) {
    if (Array.isArray(item)) {
      for (const x of item) {
        if (ctx.run !== run) return;
        await runItem(x, ctx);
      }
      return;
    }
    if (item && item.par) {
      await Promise.all(item.par.map((x) => runItem(x, ctx)));
      return;
    }
    const step = item === "pause" ? { pause: PAUSE_MS } : typeof item === "string" ? { edge: item } : item;
    await runStep(step, ctx);
  }

  // Cancel whatever is playing and remove every packet, label and transient state class.
  function reset() {
    run++;
    cancelTimers();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    active.clear();
    layers.packets.replaceChildren();
    layers.tags.replaceChildren();
    for (const n of Object.values(nodeMap)) n.classList.remove("is-pulse", "is-denied", "is-waiting");
    for (const e of Object.values(paths)) e.classList.remove("is-on", ...KINDS.map((k) => `is-${k}`));
  }

  // follow: true frames each step's nodes with the camera. follow: "fit-end" also returns to the full view at the end.
  function play(name, { onStep, follow = false } = {}) {
    const steps = FLOWS[name];
    if (!steps) {
      console.warn(`archgraph: no flow named "${name}"`);
      return Promise.resolve();
    }
    reset();
    const ctx = { run, onStep, reduce: !!(reducedMq && reducedMq.matches), follow: !!follow, prev: [] };
    return runItem(steps, ctx).then(() => {
      if (follow === "fit-end" && ctx.run === run) return animateTo(FULL_VIEW, FOLLOW_MS);
    });
  }

  // focus(ids): frame the given nodes. focus(null) or fit(): back to the full view.
  function focus(ids, { ms = FOLLOW_MS, pad = 40, minW = 520 } = {}) {
    if (ids == null) return animateTo(FULL_VIEW, ms);
    return focusNodes([].concat(ids), ms, pad, minW);
  }
  function fit(ms = FOLLOW_MS) {
    return animateTo(FULL_VIEW, ms);
  }

  function highlight(ids) {
    const lit = new Set([].concat(ids || []));
    for (const [id, n] of Object.entries(nodeMap)) n.classList.toggle("is-lit", lit.has(id));
  }

  function clear() {
    reset();
    highlight([]);
  }

  function setMini(on) {
    root.classList.toggle("arch-mini", !!on);
  }

  const controller = {
    play,
    stop: reset,
    highlight,
    clear,
    setMini,
    focus,
    fit,
    flows: Object.keys(FLOWS),
  };

  if (interactive) {
    for (const n of NODES) {
      nodeMap[n.id].addEventListener("click", () => {
        const on = nodeMap[n.id].classList.contains("is-lit");
        highlight(on ? [] : [n.id]);
      });
    }
  }

  MOUNTED.set(container, controller);
  window.PPArch = controller;
  return controller;
}
