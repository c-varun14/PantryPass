// Cognito sign-in without an SDK: InitiateAuth (USER_PASSWORD_AUTH) over fetch.
// Sessions are kept per role in sessionStorage so the header switcher can flip roles instantly.
import { roleFromClaims } from "./logic.js";

const KEY = "pp.sessions";
const ACTIVE = "pp.active";

function cfg() { return window.PP_CONFIG || {}; }

function load() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
function save(all) {
  try { sessionStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode: session lives in memory only */ }
}

export function decodeJwt(token) {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(p))));
  } catch { return {}; }
}

function cognito(target, body) {
  return fetch(`https://cognito-idp.${cfg().region}.amazonaws.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
}

function nameFor(sub, username) {
  const p = (cfg().people || []).find((x) => x.sub === sub);
  return p ? p.name : username;
}

function toSession(auth, username, prev) {
  const idToken = auth.IdToken;
  const claims = decodeJwt(idToken);
  return {
    username,
    sub: claims.sub,
    role: roleFromClaims(claims),
    name: nameFor(claims.sub, username),
    idToken,
    refreshToken: auth.RefreshToken || (prev && prev.refreshToken) || null,
    exp: claims.exp,
  };
}

// Returns {ok, session} or {ok:false, message}
export async function signIn(username, password) {
  let r;
  try {
    r = await cognito("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: cfg().clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    });
  } catch {
    return { ok: false, message: "You look offline. Check your connection and try again." };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.AuthenticationResult) {
    const t = (data.__type || "").split("#").pop();
    if (t === "NotAuthorizedException" || t === "UserNotFoundException") return { ok: false, message: "That username or password isn't right." };
    if (t === "PasswordResetRequiredException") return { ok: false, message: "This account needs a password reset." };
    return { ok: false, message: "Sign-in didn't work. Please try again." };
  }
  const s = toSession(data.AuthenticationResult, username);
  const all = load();
  all[s.role] = s;
  save(all);
  setActive(s.role);
  return { ok: true, session: s };
}

async function refresh(s) {
  if (!s.refreshToken) return null;
  try {
    const r = await cognito("InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: cfg().clientId,
      AuthParameters: { REFRESH_TOKEN: s.refreshToken },
    });
    const data = await r.json();
    if (!data.AuthenticationResult) return null;
    return toSession(data.AuthenticationResult, s.username, s);
  } catch { return null; }
}

export function sessions() { return load(); }
export function activeRole() {
  try { return sessionStorage.getItem(ACTIVE); } catch { return null; }
}
export function setActive(role) {
  try { sessionStorage.setItem(ACTIVE, role); } catch { /* ignore */ }
}

// Current session, refreshed if the token expires within 60s. null if signed out.
export async function currentSession() {
  const role = activeRole();
  const all = load();
  let s = role && all[role];
  if (!s) return null;
  if (s.exp && s.exp * 1000 - Date.now() < 60000) {
    const fresh = await refresh(s);
    if (!fresh) { delete all[role]; save(all); return null; }
    all[role] = fresh;
    save(all);
    s = fresh;
  }
  return s;
}

export function signOut(role) {
  const all = load();
  delete all[role];
  save(all);
  const rest = Object.keys(all);
  setActive(rest[0] || "");
}

// ?mock=1: no Cognito, pick a person from the config directory.
export function mockSignIn(person) {
  const s = { username: person.username, sub: person.sub, role: person.role, name: person.name, idToken: "mock", refreshToken: null, exp: 0 };
  const all = load();
  all[s.role] = s;
  save(all);
  setActive(s.role);
  return s;
}
