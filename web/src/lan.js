// LAN backend for Kwent's Online Mode.
// Drop-in replacement for firebase.js: same four-function interface
// (dbGet, dbSet, dbUpdate, dbListen) so App.jsx doesn't need to know which
// backend is active — see net.js for the switch. Talks to the small Node
// relay in /lan-server over a plain WebSocket instead of Firebase, so two
// browsers on the same network can play with zero internet access.

let ws = null;
let wsUrl = null;
let connectPromise = null;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}
const listeners = new Map(); // key -> Set<callback>

// Populated from the server's "hello" message on connect — the LAN IPs the
// host can share with the other player. Read via getLastHello().
let lastHello = null;
export function getLastHello() { return lastHello; }

function connect(url) {
  if (ws && wsUrl === url && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return connectPromise;
  }
  wsUrl = url;
  if (ws) { try { ws.close(); } catch (e) { /* already closing */ } }
  connectPromise = new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => { settled = true; resolve(socket); };
    socket.onerror = () => {
      if (!settled) { settled = true; reject(new Error("Could not reach LAN server at " + url)); }
    };
    socket.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (msg.type === "hello") {
        lastHello = { addresses: msg.addresses, port: msg.port };
        return;
      }
      if (msg.type === "result" || msg.type === "ack") {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg); }
        return;
      }
      if (msg.type === "value") {
        const set = listeners.get(msg.key);
        if (set) set.forEach((cb) => cb(msg.value));
        return;
      }
    };
    socket.onclose = () => {
      if (!settled) { settled = true; reject(new Error("LAN connection closed before it opened")); }
      for (const [, p] of pending) p.reject(new Error("LAN connection closed"));
      pending.clear();
    };
  });
  return connectPromise;
}

// Call once, before hosting/joining, with e.g. "ws://192.168.1.42:3131".
export function setLanServerUrl(url) {
  return connect(url);
}

export function isLanConnected() {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

async function ensureConnected() {
  if (!ws || !connectPromise) throw new Error("LAN server address not set — call setLanServerUrl() first.");
  await connectPromise;
}

function send(msg) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    try {
      ws.send(JSON.stringify({ ...msg, id }));
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

export async function dbGet(key) {
  try {
    await ensureConnected();
    const res = await send({ type: "get", key });
    return res.value === undefined ? null : res.value;
  } catch (e) {
    return null;
  }
}

export async function dbSet(key, value) {
  try {
    await ensureConnected();
    await send({ type: "set", key, value });
    return true;
  } catch (e) {
    return false;
  }
}

export async function dbUpdate(updates) {
  try {
    await ensureConnected();
    await send({ type: "update", updates });
    return true;
  } catch (e) {
    return false;
  }
}

export function dbListen(key, callback) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(callback);
  ensureConnected()
    .then(() => ws.send(JSON.stringify({ type: "subscribe", key })))
    .catch(() => { /* not connected yet — subscription is a no-op until it is */ });
  return () => {
    listeners.get(key)?.delete(callback);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "unsubscribe", key })); } catch (e) { /* socket already gone */ }
    }
  };
}
