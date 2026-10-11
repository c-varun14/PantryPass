// Signed-out front page (shown at #/signin with no role): purpose, problem, how it works,
// and the three role cards that double as the demo sign-in entry.
import { el } from "../dom.js";
import * as auth from "../auth.js";
import { ROLE_LABEL } from "../logic.js";

const ROLE_CARDS = [
  { role: "donor", fallback: "Asha", text: "offers food, can't report what was given out" },
  { role: "receiver", fallback: "Ravi", text: "confirms the count and reports what went out" },
  { role: "coordinator", fallback: "Meera", text: "resolves what nobody answered or counts that don't match" },
];

const STEPS = [
  "Donor offers and hands over",
  "Receiver counts what really arrived",
  "Coordinator sees anything unconfirmed",
];

/** "Asha (donor)" -> "Asha". Demo names in config carry the role in brackets. */
export function displayName(name) {
  return String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

export function render(container, ctx) {
  const people = (window.PP_CONFIG && window.PP_CONFIG.people) || [];
  const signedIn = ctx.signedInAs || {};

  const hero = el("section", { class: "welcome-hero" },
    el("p", { class: "welcome-eyebrow", text: "PantryPass" }),
    el("h1", { class: "welcome-title", text: "A shared record of surplus-food handoffs where the count stays right." }),
    el("p", { class: "welcome-problem", text: "Today a donor says 10, someone taps done, and nobody can say how many actually arrived." }),
    el("p", { class: "welcome-claim", text: "The count can't be wrong, because the person who benefits from saying \u201cdone\u201d isn't allowed to say it." }));

  const steps = el("section", { class: "welcome-section", "aria-labelledby": "welcome-how" },
    el("h2", { class: "welcome-h2", id: "welcome-how", text: "How it works" }),
    el("ol", { class: "welcome-steps" },
      STEPS.map((text, i) => el("li", { class: "welcome-step" },
        el("span", { class: "welcome-step-num", "aria-hidden": "true", text: String(i + 1) }),
        el("span", { class: "welcome-step-text", text })))));

  const cards = el("section", { class: "welcome-section", "aria-labelledby": "welcome-who" },
    el("h2", { class: "welcome-h2", id: "welcome-who", text: "Who does what" }),
    el("p", { class: "welcome-note", text: "Demo people, not real accounts. Pick one to sign in." }),
    el("div", { class: "welcome-roles" }, ROLE_CARDS.map((c) => roleCard(c, people, signedIn, ctx))));

  const about = el("p", { class: "welcome-about" },
    el("a", { class: "welcome-about-link", href: "#/about", text: "How it's built on AWS" }));

  container.append(el("div", { class: "welcome" }, hero, steps, cards, about));
}

function roleCard({ role, fallback, text }, people, signedIn, ctx) {
  const person = people.find((p) => p.role === role);
  const name = displayName(person ? person.name : fallback);
  const label = ROLE_LABEL[role];
  const isSignedIn = !!signedIn[role];
  return el("button", {
    class: `welcome-role role-${role}`,
    type: "button",
    "aria-label": `${name}, ${label}: ${text}${isSignedIn ? ", signed in" : ""}`,
    onclick: async () => {
      if (isSignedIn) {
        auth.setActive(role);
        await ctx.afterSignIn();
      } else {
        ctx.go(`#/signin/${role}`);
      }
    },
  },
    el("span", { class: "welcome-role-head" },
      el("span", { class: "welcome-role-name", text: `${name} · ${label}` }),
      isSignedIn ? el("span", { class: "chip chip-done", text: "Signed in" }) : null),
    el("span", { class: "welcome-role-desc", text }));
}
