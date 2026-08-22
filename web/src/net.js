// Runtime backend switch for Kwent's Online Mode.
// App.jsx imports dbGet/dbSet/dbUpdate/dbListen from HERE (not firebase.js
// directly) so the same code path works over the internet (Firebase) or
// over a LAN with zero internet access (the local relay in lan.js),
// decided once when a game is hosted/joined.
import * as firebaseBackend from "./firebase.js";
import * as lanBackend from "./lan.js";

let active = firebaseBackend;

export function setNetBackend(mode) {
  active = mode === "lan" ? lanBackend : firebaseBackend;
}

export function getNetBackend() {
  return active === lanBackend ? "lan" : "internet";
}

export async function dbGet(key) { return active.dbGet(key); }
export async function dbSet(key, value) { return active.dbSet(key, value); }
export async function dbUpdate(updates) { return active.dbUpdate(updates); }
export function dbListen(key, callback) { return active.dbListen(key, callback); }

// Stable per-session id used by the DB security rules to confirm a write is
// coming from one of the two actual players in a room. Firebase mode signs
// in anonymously and returns the real auth UID; LAN mode has no DB rules to
// satisfy (the relay is local-network-only) so it just hands back a random
// per-tab id to keep the call uniform for App.jsx.
export async function dbGetUid() { return active.getUid(); }
