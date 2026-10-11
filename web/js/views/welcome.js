// Signed-out landing (#/ with no session, and #/signin with no role): a light page with a
// 3D picture, a display headline, three role cards that double as the demo sign-in entry, and a quiet link to How it works.
import { el } from "../dom.js";
import * as auth from "../auth.js";
import { ROLE_LABEL } from "../logic.js";
import { avatar, img3d } from "../ui.js";
import { icon } from "../icons.js";

const ROLE_CARDS = [
  { role: "donor", fallback: "Asha", desc: "Announce food and hand it over." },
  { role: "receiver", fallback: "Ravi", desc: "Claim it and collect. Confirm what arrived." },
  { role: "coordinator", fallback: "Meera", desc: "Settle what doesn't add up." },
];

/** "Asha (donor)" -> "Asha". Demo names in config carry the role in brackets. */
export function displayName(name) {
  return String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

export function render(container, ctx) {
  const people = (window.PP_CONFIG && window.PP_CONFIG.people) || [];
  const signedIn = ctx.signedInAs || {};

  document.body.classList.add("is-welcome");

  const page = el("div", { class: "welcome" },
    el("div", { class: "welcome-art" }, img3d("package", 168)),
    el("div", { class: "welcome-main" },
      el("header", { class: "welcome-head" },
        el("h1", { class: "display welcome-title", text: "Surplus food, counted right." }),
        el("p", { class: "welcome-sub", text: "Each handoff recorded, and the count checked by whoever received it." })),
      el("section", { class: "welcome-section", "aria-labelledby": "welcome-who" },
        el("h2", { class: "welcome-who", id: "welcome-who", text: "Try it in three steps" }),
        el("div", { class: "welcome-roles" }, ROLE_CARDS.map((c, i) => roleCard(c, i + 1, people, signedIn, ctx))),
        el("p", { class: "welcome-note", text: "Demo people, not real accounts. Switch role any time from the menu." })),
      el("p", { class: "welcome-about" },
        el("a", { class: "welcome-about-link", href: "#/about", text: "How it works" }))));

  container.append(page);

  return () => document.body.classList.remove("is-welcome");
}

function roleCard({ role, fallback, desc }, step, people, signedIn, ctx) {
  const person = people.find((p) => p.role === role);
  const full = displayName(person ? person.name : fallback);
  const first = full.split(/\s+/)[0] || full;
  const label = ROLE_LABEL[role];
  const isSignedIn = !!signedIn[role];
  return el("button", {
    class: `welcome-role role-${role}`,
    type: "button",
    "aria-label": `Step ${step}: ${first}, ${label}. ${desc}${isSignedIn ? " Signed in." : ""}`,
    onclick: async () => {
      if (isSignedIn) {
        auth.setActive(role);
        await ctx.afterSignIn();
      } else {
        ctx.go(`#/signin/${role}`);
      }
    },
  },
    avatar(full, role, "m"),
    el("span", { class: "welcome-role-text" },
      el("span", { class: "welcome-role-line" },
        el("span", { class: "welcome-role-step", text: `Step ${step}` }),
        el("span", { class: "welcome-role-name", text: first }),
        el("span", { class: "welcome-role-label", text: label }),
        isSignedIn ? el("span", { class: "chip chip-done", text: "Signed in" }) : null),
      el("span", { class: "welcome-role-desc", text: desc })),
    el("span", { class: "welcome-role-chev", "aria-hidden": "true" }, icon("chevron-right", 22)));
}
