// About (#/about): a short intro, the AWS services as compact rows, and the long prose
// (why the count holds, what is not claimed, the diagram) in collapsed <details>. Works signed in or out.
import { el, clear } from "../dom.js";
import { icon } from "../icons.js";
import { mountArchGraph } from "../archgraph.js";

// icon: Lucide name for the row badge. purpose: one short line for the list. without: why the service matters (shown in details).
// The diagram itself (nodes, edges, flows) lives in js/archgraph.js.
const SERVICES = [
  { id: "svc-cognito", icon: "lock", title: "Amazon Cognito",
    purpose: "Signs people in; the token carries their role.",
    without: "nobody can prove who is asking, so the role on a request can't be trusted." },
  { id: "svc-apigw", icon: "arrow-right", title: "API Gateway",
    purpose: "Front door; checks the token on every request.",
    without: "anonymous requests would reach the logic, and every rule would have to re-check identity itself." },
  { id: "svc-avp", icon: "shield-check", title: "Verified Permissions",
    purpose: "Allows or denies each action before data is touched.",
    without: "role rules would be scattered if-statements in the code, and a refused action could still slip through." },
  { id: "svc-sfn", icon: "clock", title: "Step Functions",
    purpose: "Waits durably for a receiver to claim it; silence becomes an exception.",
    without: "an unanswered pickup would sit forever, invisible to the coordinator." },
  { id: "svc-lambda", icon: "scale", title: "AWS Lambda",
    purpose: "Python and Go; runs the handoff rules and webhooks.",
    without: "nothing would enforce the count rules, and the database would store whatever was sent." },
  { id: "svc-whatsapp", icon: "users", title: "WhatsApp Cloud API",
    purpose: "Web app's rules; live round trip needs Meta credentials.",
    without: "people who prefer chat have no way to report a count." },
  { id: "svc-cw", icon: "info", title: "CloudWatch and X-Ray",
    purpose: "Dashboard, metrics and traces; refusals stay visible.",
    without: "a wrong count or a failed webhook would only show up when someone complained." },
  { id: "svc-ddb", icon: "layers", title: "DynamoDB",
    purpose: "Lots and a hash-chained event log; writes are conditional.",
    without: "two people editing the same lot would silently overwrite each other, and retries would double-count." },
  { id: "svc-stream", icon: "refresh-cw", title: "DynamoDB Streams",
    purpose: "Streams each change to the notifier Lambda.",
    without: "receivers, coordinators and donors would have to keep reopening the app to see what changed." },
  { id: "svc-s3cf", icon: "package", title: "S3 and CloudFront",
    purpose: "Hosts this site over HTTPS. No server to run.",
    without: "nobody could open the app." },
  { id: "svc-secrets", icon: "eye-off", title: "Secrets Manager",
    purpose: "Keeps WhatsApp and Razorpay keys out of code and the site.",
    without: "the WhatsApp and Razorpay keys would sit in source or environment files." },
  { id: "svc-razorpay", icon: "coins", title: "Razorpay",
    purpose: "Payment gateway: creates each order and posts a signed webhook when money lands.",
    without: "donations could not be taken, and nothing would confirm that a payment actually cleared." },
  { id: "svc-kms", icon: "lock", title: "AWS KMS",
    purpose: "Seals bank account numbers; only the masked form is ever returned.",
    without: "bank account numbers would sit readable in the database, one leak away from exposure." },
  { id: "svc-payouts", icon: "handshake", title: "DynamoDB payouts",
    purpose: "Holds bank details, donations and transfers, each with a conditional write.",
    without: "payouts would live in a spreadsheet, with no record of who was paid and when." },
];
const ARCH_BUTTONS = [
  ["Play full journey", "intro"],
  ["Wrong person", "deny"],
  ["Nobody answers", "wait"],
  ["Two at once", "txn"],
  ["Tell the phone", "notify"],
  ["Donate and pay out", "money"],
];

const WHY_POINTS = [
  ["Permission first. ", "Verified Permissions decides before any data is touched. The role comes from the signed token, and every refusal is logged as DENY."],
  ["Conditional writes. ", "Writes carry idempotency keys and only apply if the lot is still in the state the writer saw. Stale or repeated writes are refused, not applied twice."],
  ["The sum is checked. ", "Received must equal distributed + returned + disposed + remaining. That is checked on every write."],
  ["No silent waits. ", "A durable Step Functions wait turns an unanswered pickup into an exception the coordinator sees."],
  ["Proof of pickup. ", "A one-time pickup code, and a hash-chained 'Record verified' step, make each handoff record hard to edit quietly."],
  ["Same rules everywhere. ", "WhatsApp goes through the same checks as the web app."],
];

const NOT_CLAIMED = [
  "It records who reported what. It does not prove the food was eaten or was safe.",
  "It does not prove food waste was avoided.",
  "Two people agreeing on a false number would pass.",
  "The hash chain detects edits, but not someone who can rewrite both the event table and the chain.",
  "The WhatsApp channel is built and tested with signed test messages. A live round trip needs Meta credentials.",
];

function details(summary, children) {
  return el("details", { class: "about-more" },
    el("summary", { text: summary }),
    el("div", { class: "about-more-body" }, children));
}

export function render(container, ctx) {
  clear(container);
  const backHref = ctx.session ? "#/" : "#/signin";

  container.append(el("article", { class: "about" },
    el("a", { class: "back-link", href: backHref, text: ctx.session ? "← Back to lots" : "← Back" }),
    el("h1", { class: "page-title display", text: "How it works" }),
    el("p", { class: "about-intro", text: "The count can't be wrong: whoever benefits from saying “done” isn't allowed to say it." }),

    el("section", { class: "about-section", "aria-labelledby": "about-aws" },
      el("h2", { class: "pg-h2", id: "about-aws", text: "Built on AWS" }),
      el("ul", { class: "card svc-card" }, SERVICES.map((s) => el("li", { class: "svc-row", "data-svc": s.id },
        el("span", { class: "svc-icon", "aria-hidden": "true" }, icon(s.icon, 18)),
        el("span", { class: "svc-text" },
          el("strong", { class: "svc-name", text: s.title }),
          el("span", { class: "svc-what", text: s.purpose })))))),

    el("div", { class: "about-stack" },
      details("Why the count stays right", el("ol", { class: "about-points" },
        WHY_POINTS.map(([head, body]) => el("li", null, el("strong", { text: head }), body)))),
      details("What it does not claim", el("ul", { class: "about-points" },
        NOT_CLAIMED.map((text) => el("li", null, text)))),
      details("Why each service is there", el("ol", { class: "about-points" },
        SERVICES.map((s) => el("li", null, el("strong", { text: `${s.title}: ` }), s.without)))),
      el("details", { class: "about-more" },
        el("summary", { text: "Architecture diagram" }),
        el("div", { class: "arch-scroll", "data-arch": "" }),
        el("div", { class: "arch-controls", role: "group", "aria-label": "Play a flow through the diagram" },
          ARCH_BUTTONS.map(([text, flow]) => el("button", { type: "button", class: "btn btn-secondary", "data-flow": flow, text }))),
        el("p", { class: "arch-status", "data-arch-status": "", "aria-live": "polite" }))),

    el("p", { class: "about-note", text: "Everyone in the demo is a demo persona." })));

  const graph = mountArchGraph(container.querySelector("[data-arch]"));
  const status = container.querySelector("[data-arch-status]");
  container.querySelectorAll("[data-flow]").forEach((btn) => {
    btn.addEventListener("click", () => {
      status.textContent = "";
      graph.play(btn.dataset.flow, {
        onStep: (step) => { status.textContent = step.label; },
      });
    });
  });
  return () => graph.stop();
}
