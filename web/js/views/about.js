// About (#/about): what PantryPass is, why the count stays right, what it does not claim,
// and how it is built on AWS (diagram plus a per-service list). Works signed in or out.
import { el, clear } from "../dom.js";

const SERVICES = [
  { id: "svc-cognito", x: 30, y: 24, title: "Amazon Cognito", sub: "sign-in, token carries role",
    what: "Signs people in and issues a signed token that carries their role: donor, receiver or coordinator.",
    without: "nobody can prove who is asking, so the role on a request can't be trusted." },
  { id: "svc-apigw", x: 375, y: 24, title: "API Gateway", sub: "front door, checks token",
    what: "The front door. Every request is checked for a valid token before it reaches the logic.",
    without: "anonymous requests would reach the logic, and every rule would have to re-check identity itself." },
  { id: "svc-avp", x: 720, y: 24, title: "Verified Permissions", sub: "Cedar: allow or deny per action",
    what: "Decides allow or deny for each action on a lot, before any data is read or written. Refusals are logged as DENY.",
    without: "role rules would be scattered if-statements in the code, and a refused action could still slip through." },
  { id: "svc-sfn", x: 30, y: 170, title: "Step Functions", sub: "durable wait for the receiver",
    what: "Standard workflow that waits durably for the receiver to confirm. If nobody answers in time, the lot becomes an exception.",
    without: "an unanswered pickup would sit forever, invisible to the coordinator." },
  { id: "svc-lambda", x: 375, y: 170, title: "AWS Lambda", sub: "Python and Go: the logic",
    what: "Runs the handoff rules (offer, accept, declare, count) plus the WhatsApp webhook and the notifier function.",
    without: "nothing would enforce the count rules, and the database would store whatever was sent." },
  { id: "svc-whatsapp", x: 720, y: 170, title: "WhatsApp Cloud API", sub: "messages to the three roles",
    what: "Sends and receives messages for receiver, coordinator and donor under the same rules as the web app. Built and tested with signed test messages; a live round trip needs Meta credentials.",
    without: "people who prefer chat have no way to report a count." },
  { id: "svc-cw", x: 30, y: 316, title: "CloudWatch and X-Ray", sub: "dashboard, metrics, traces",
    what: "A dashboard, metric filters on the logs and traces across calls, so failures and refusals are visible.",
    without: "a wrong count or a failed webhook would only show up when someone complained." },
  { id: "svc-ddb", x: 375, y: 316, title: "DynamoDB", sub: "lots, hash-chained events",
    what: "Stores lots, the hash-chained event log, idempotency markers and chat links. Writes are conditional, so stale or repeated writes are refused.",
    without: "two people editing the same lot would silently overwrite each other, and retries would double-count." },
  { id: "svc-stream", x: 720, y: 316, title: "DynamoDB Streams", sub: "notifier Lambda",
    what: "Streams each change to a notifier Lambda, which decides who should hear about it on WhatsApp.",
    without: "receivers, coordinators and donors would have to keep reopening the app to see what changed." },
  { id: "svc-s3cf", x: 30, y: 430, title: "S3 and CloudFront", sub: "serves this site",
    what: "Hosts this static site over HTTPS. There is no server to run for the web interface.",
    without: "nobody could open the app." },
  { id: "svc-secrets", x: 375, y: 430, title: "Secrets Manager", sub: "WhatsApp credentials",
    what: "Holds the WhatsApp credentials so they are not stored in code or in the site.",
    without: "the WhatsApp keys would sit in source or environment files." },
];

const LINKS = [
  [240, 76, 375, 76],   // Cognito -> API Gateway
  [585, 76, 720, 76],   // API Gateway -> Verified Permissions (checked on the way in)
  [480, 124, 480, 170], // API Gateway -> Lambda
  [585, 196, 720, 124], // Lambda -> Verified Permissions (decision)
  [375, 220, 240, 220], // Lambda -> Step Functions (wait for receiver)
  [480, 270, 480, 316], // Lambda -> DynamoDB
  [585, 366, 720, 366], // DynamoDB -> Streams
  [825, 316, 825, 270], // Streams -> WhatsApp
];

const W = 210;
const H = 100;

function diagramSvg() {
  const nodes = SERVICES.map((s) => `
    <g id="${s.id}" class="aws-node">
      <title>${s.title}: ${s.sub}</title>
      <rect x="${s.x}" y="${s.y}" width="${W}" height="${H}" rx="16"/>
      <text class="aws-title" x="${s.x + W / 2}" y="${s.y + 42}" text-anchor="middle">${s.title}</text>
      <text class="aws-sub" x="${s.x + W / 2}" y="${s.y + 66}" text-anchor="middle">${s.sub}</text>
    </g>`).join("");
  const links = LINKS.map(([x1, y1, x2, y2]) =>
    `<line class="aws-link" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#aws-arrow)"/>`).join("");
  return `<svg class="arch-svg" viewBox="0 0 960 548" role="img" aria-labelledby="arch-title" xmlns="http://www.w3.org/2000/svg">
    <title id="arch-title">PantryPass on AWS, region ap-south-1</title>
    <defs>
      <marker id="aws-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="aws-arrow-head" d="M0 0L10 5L0 10z"/>
      </marker>
    </defs>
    ${links}
    ${nodes}
    <text class="aws-region" x="930" y="536" text-anchor="end">Region ap-south-1</text>
  </svg>`;
}

export function render(container, ctx) {
  clear(container);
  const backHref = ctx.session ? "#/" : "#/signin";

  container.append(el("article", { class: "about" },
    el("a", { class: "back-link", href: backHref, text: ctx.session ? "← Back to lots" : "← Back" }),
    el("h1", { class: "about-title", text: "How PantryPass works" }),

    el("section", { class: "about-section", "aria-labelledby": "about-what" },
      el("h2", { class: "about-h2", id: "about-what", text: "What PantryPass is" }),
      el("p", { text: "PantryPass is a shared record of surplus-food handoffs between a donor, a receiver and a coordinator. The donor offers food and declares the handover. The receiver counts what really arrived and reports what went out. The coordinator sees anything nobody answered and any count that doesn't match." }),
      el("p", { class: "about-core", text: "The count can't be wrong because the person who benefits from saying 'done' isn't allowed to say it." }),
      el("p", { class: "about-note", text: "Everyone in the demo is a demo persona." })),

    el("section", { class: "about-section", "aria-labelledby": "about-why" },
      el("h2", { class: "about-h2", id: "about-why", text: "Why the count stays right" }),
      el("ol", { class: "about-points" },
        el("li", null, el("strong", { text: "Permission first. " }), "Verified Permissions decides before any data is touched. The role comes from the signed token, and every refusal is logged as DENY."),
        el("li", null, el("strong", { text: "Conditional writes. " }), "Writes carry idempotency keys and only apply if the lot is still in the state the writer saw. Stale or repeated writes are refused, not applied twice."),
        el("li", null, el("strong", { text: "The sum is checked. " }), "Received must equal distributed + returned + disposed + remaining. That is checked on every write."),
        el("li", null, el("strong", { text: "No silent waits. " }), "A durable Step Functions wait turns an unanswered pickup into an exception the coordinator sees."),
        el("li", null, el("strong", { text: "Proof of pickup. " }), "A one-time pickup code, and a hash-chained 'Record verified' step, make each handoff record hard to edit quietly."),
        el("li", null, el("strong", { text: "Same rules everywhere. " }), "WhatsApp goes through the same checks as the web app."))),

    el("section", { class: "about-section", "aria-labelledby": "about-not" },
      el("h2", { class: "about-h2", id: "about-not", text: "What it does not claim" }),
      el("ul", { class: "about-points about-not-list" },
        el("li", null, "It records who reported what. It does not prove the food was eaten or was safe."),
        el("li", null, "It does not prove food waste was avoided."),
        el("li", null, "Two people agreeing on a false number would pass."),
        el("li", null, "The hash chain detects edits, but not someone who can rewrite both the event table and the chain."),
        el("li", null, "The WhatsApp channel is built and tested with signed test messages. A live round trip needs Meta credentials."))),

    el("section", { class: "about-section", "aria-labelledby": "about-aws" },
      el("h2", { class: "about-h2", id: "about-aws", text: "How it's built on AWS" }),
      el("p", { class: "about-note", text: "Each box is one service. Arrows show the main request path." }),
      el("div", { class: "arch-scroll", "data-arch": "" }),
      el("h3", { class: "about-h3", text: "What runs where" }),
      el("ol", { class: "svc-list" }, SERVICES.map((s) => el("li", { class: "svc-item", "data-svc": s.id },
        el("h4", { class: "svc-name", text: s.title }),
        el("p", { class: "svc-what", text: s.what }),
        el("p", { class: "svc-without" }, el("strong", { text: "Without it: " }), s.without)))))));

  container.querySelector("[data-arch]").innerHTML = diagramSvg();
}
