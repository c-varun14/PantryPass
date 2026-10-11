// Sign-in: pick a role, then sign in with its username (and password in real mode).
import { el, clear } from "../dom.js";
import * as auth from "../auth.js";
import { avatar, button, setLoading } from "../ui.js";
import { icon } from "../icons.js";
import { render as renderWelcome, displayName } from "./welcome.js";

const ROLES = [
  { role: "donor", label: "Donor" },
  { role: "receiver", label: "Receiver" },
  { role: "coordinator", label: "Coordinator" },
];

export function render(container, ctx) {
  clear(container);
  const people = (window.PP_CONFIG && window.PP_CONFIG.people) || [];
  const meta = ROLES.find((r) => r.role === (ctx.params && ctx.params.role));

  // No role: the welcome page (role cards that start sign-in). Its cleanup comes back to the router.
  if (!meta) return renderWelcome(container, ctx);

  // White page for the form; the class comes off again when the router moves on.
  document.body.classList.add("is-signin");
  container.append(formFor(meta, people, ctx));
  return () => document.body.classList.remove("is-signin");
}

function formFor(meta, people, ctx) {
  const roleName = meta.label.toLowerCase();
  const candidates = people.filter((p) => p.role === meta.role);
  const first = candidates[0] || null;
  const name = first ? displayName(first.name) : "";
  const errSlot = el("div", { "aria-live": "polite" });

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
    class: "btn btn-secondary signin-toggle",
    type: "button",
    "aria-pressed": "false",
    "aria-label": "Show password",
    onclick: () => {
      const showing = passwordInput.type === "text";
      passwordInput.type = showing ? "password" : "text";
      toggle.replaceChildren(icon(showing ? "eye" : "eye-off", 22));
      toggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      toggle.setAttribute("aria-pressed", String(!showing));
    },
  }, icon("eye", 22)) : null;

  // Present only when the deploy opted in (infra/70_hosting.sh with PUBLISH_DEMO_PASSWORD=1).
  const demoPassword = (window.PP_CONFIG && window.PP_CONFIG.demoPassword) || "";

  const submitBtn = button("Sign in", { variant: "primary", block: true });
  submitBtn.type = "submit"; // button() makes type="button"; the form needs a real submit control

  const showError = (msg) => {
    clear(errSlot);
    errSlot.append(el("p", { class: "field-error signin-error", role: "alert", text: msg }));
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

  const form = el("form", { class: "signin-form", novalidate: true, onsubmit: submit },
    ctx.mock ? el("p", { class: "field-hint", text: "Demo mode: no password" }) : null,
    el("div", { class: "field" },
      el("label", { class: "field-label", for: "signin-username", text: "Username" }),
      usernameInput),
    passwordInput ? el("div", { class: "field" },
      el("label", { class: "field-label", for: "signin-password", text: "Password" }),
      el("div", { class: "signin-password-row" }, passwordInput, toggle),
      demoPassword
        ? el("button", {
          class: "btn btn-ghost signin-demo", type: "button",
          onclick: () => { passwordInput.value = demoPassword; passwordInput.focus(); },
        }, "Use the demo password")
        : el("p", { class: "field-hint", text: "Judging? Use the demo password from the submission notes." })) : null,
    errSlot,
    submitBtn);

  // main.js moves focus to the view after render, so defer our focus.
  setTimeout(() => {
    const target = passwordInput && usernameInput.value ? passwordInput : usernameInput;
    target.focus();
  }, 0);

  return el("div", { class: "signin" },
    el("a", { class: "back-link", href: "#/signin", text: "← Back" }),
    el("header", { class: "signin-head" },
      avatar(name || meta.label, meta.role, "l"),
      el("h1", { class: "page-title display", text: name ? `Sign in as ${name}` : `Sign in as ${meta.label}` }),
      el("p", { class: "signin-role", text: meta.label })),
    form);
}
