// Sign-in: pick a role, then sign in with its username (and password in real mode).
import { el, clear, svgIcon } from "../dom.js";
import * as auth from "../auth.js";
import { button, setLoading } from "../ui.js";
import { roleJob } from "../logic.js";
import { render as renderWelcome, displayName } from "./welcome.js";

const ROLES = [
  {
    role: "donor",
    label: "Donor",
    path: "M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10",
    desc: "Offer surplus food and declare when it is handed over.",
  },
  {
    role: "receiver",
    label: "Receiver",
    path: "M3 13l3-7h12l3 7v6H3zM3 13h5l1 2h6l1-2h5",
    desc: "Accept lots, then report what arrived and what went out.",
  },
  {
    role: "coordinator",
    label: "Coordinator",
    path: "M16 11a4 4 0 10-8 0M4 21a8 8 0 0116 0",
    desc: "See every lot, resolve exceptions and count disputes.",
  },
];

export function render(container, ctx) {
  clear(container);
  const people = (window.PP_CONFIG && window.PP_CONFIG.people) || [];
  const meta = ROLES.find((r) => r.role === (ctx.params && ctx.params.role));

  // No role: the welcome page (purpose, how it works, role cards that start sign-in).
  if (!meta) {
    renderWelcome(container, ctx);
    return;
  }

  const intro = el("header", { class: "stack" },
    el("h1", { class: "page-title", text: "Welcome to PantryPass" }),
    el("p", { class: "page-sub", text: "Only the receiver can say what was distributed." }));

  container.append(el("div", { class: "stack" }, intro, formFor(meta, people, ctx)));
}

function formFor(meta, people, ctx) {
  const roleName = meta.label.toLowerCase();
  const candidates = people.filter((p) => p.role === meta.role);
  const first = candidates[0] || null;
  const who = first ? displayName(first.name) : `a demo ${roleName}`;
  const errSlot = el("div", { class: "stack", "aria-live": "polite" });

  const usernameInput = el("input", {
    class: "input",
    id: "signin-username",
    name: "username",
    autocomplete: "username",
    autocapitalize: "none",
    spellcheck: "false",
    value: first ? first.username : "",
  });

  const passwordInput = ctx.mock ? null : el("input", {
    class: "input",
    id: "signin-password",
    name: "password",
    type: "password",
    autocomplete: "current-password",
    autocapitalize: "none",
    spellcheck: "false",
  });

  const toggle = passwordInput ? el("button", {
    class: "btn btn-ghost",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Show password",
    text: "Show",
    onclick: () => {
      const showing = passwordInput.type === "text";
      passwordInput.type = showing ? "password" : "text";
      toggle.textContent = showing ? "Show" : "Hide";
      toggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      toggle.setAttribute("aria-pressed", String(!showing));
    },
  }) : null;

  const submitBtn = button("Sign in", { variant: "primary", block: true });
  submitBtn.type = "submit"; // button() makes type="button"; the form needs a real submit control

  const showError = (msg) => {
    clear(errSlot);
    errSlot.append(el("div", { class: "banner banner-danger", role: "alert", text: msg }));
  };

  const submit = async (e) => {
    e.preventDefault();
    clear(errSlot);
    const username = usernameInput.value.trim();
    if (!username) { showError("Enter your username."); usernameInput.focus(); return; }
    if (!ctx.mock && !passwordInput.value) { showError("Enter your password."); passwordInput.focus(); return; }

    setLoading(submitBtn, true);
    try {
      if (ctx.mock) {
        const person = candidates.find((p) => p.username === username);
        if (!person) { showError(`No demo ${roleName} called "${username}".`); return; }
        auth.mockSignIn(person);
        await ctx.afterSignIn();
      } else {
        const res = await auth.signIn(username, passwordInput.value);
        if (!res.ok) {
          showError(res.message);
          passwordInput.value = "";
          passwordInput.focus();
          return;
        }
        // Account role comes from its Cognito group; the switcher shows the real one.
        await ctx.afterSignIn();
      }
    } catch (err) {
      console.error(err);
      showError("Sign-in didn't work. Please try again.");
    } finally {
      setLoading(submitBtn, false);
    }
  };

  const form = el("form", { class: "stack", novalidate: true, onsubmit: submit },
    errSlot,
    ctx.mock ? el("p", { class: "field-hint", text: "Demo mode: no password" }) : null,
    el("div", { class: "field" },
      el("label", { class: "field-label", for: "signin-username", text: "Username" }),
      usernameInput),
    passwordInput ? el("div", { class: "field" },
      el("label", { class: "field-label", for: "signin-password", text: "Password" }),
      el("div", { class: "row" }, passwordInput, toggle)) : null,
    submitBtn);

  // main.js moves focus to the view after render, so defer our focus.
  setTimeout(() => {
    const target = passwordInput && usernameInput.value ? passwordInput : usernameInput;
    target.focus();
  }, 0);

  return el("div", { class: "stack" },
    el("a", { class: "back-link", href: "#/signin", text: "← Back" }),
    el("div", { class: "row" },
      el("span", { class: "role-icon" }, svgIcon(meta.path, 24)),
      el("h2", { class: "section-title", text: `Sign in as ${meta.label}` })),
    el("p", { class: "page-sub role-job-line",
      text: `You are signing in as ${who}, the ${roleName}. ${roleJob(meta.role)}` }),
    form,
    el("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Choose a different role",
      onclick: () => ctx.go("#/signin"),
    }));
}
