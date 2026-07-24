#!/usr/bin/env node
"use strict";
// Kwent LAN server.
//
// Does two jobs on one port:
//   1. Serves the built static site (web/dist) so a second browser on the
//      same network can load the game without hitting kwent.com/GitHub Pages.
//   2. Relays Online Mode's state over WebSocket, mirroring the tiny
//      key/value + pub/sub interface that firebase.js exposes
//      (get / set / update / subscribe -> "value" push), so App.jsx's
//      online-mode code doesn't need to know it isn't talking to Firebase.
//
// Usage:
//   cd web && npm run build   (only needed after code changes)
//   cd ../lan-server && npm install && node server.js
//   Host opens the printed localhost link; the other player opens the
//   printed LAN IP link (must be on the same Wi-Fi/network).

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3131;
const DIST_DIR = path.join(__dirname, "..", "web", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function localAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

// ---------- static file server ----------

const server = http.createServer((req, res) => {
  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(
      "web/dist not found.\n\nRun this first:\n  cd web\n  npm install\n  npm run build\n\nThen restart this server."
    );
    return;
  }
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = path.normalize(path.join(DIST_DIR, reqPath));
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback for client-side routes.
      fs.readFile(path.join(DIST_DIR, "index.html"), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------- in-memory store + pub/sub (mirrors Firebase RTDB semantics) ----------

const store = new Map(); // key -> value
const subs = new Map(); // key -> Set<ws>

function currentValue(key) {
  return store.has(key) ? store.get(key) : null;
}

function pushValue(key) {
  const set = subs.get(key);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify({ type: "value", key, value: currentValue(key) });
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function writeKey(key, value) {
  if (value === null || value === undefined) store.delete(key);
  else store.set(key, value);
  pushValue(key);
}

// ---------- WebSocket relay ----------

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.subscribedKeys = new Set();
  ws.send(JSON.stringify({ type: "hello", addresses: localAddresses(), port: PORT }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    switch (msg.type) {
      case "get": {
        ws.send(JSON.stringify({ type: "result", id: msg.id, value: currentValue(msg.key) }));
        break;
      }
      case "set": {
        writeKey(msg.key, msg.value);
        ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: true }));
        break;
      }
      case "update": {
        const updates = msg.updates || {};
        for (const k of Object.keys(updates)) writeKey(k, updates[k]);
        ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: true }));
        break;
      }
      case "subscribe": {
        ws.subscribedKeys.add(msg.key);
        if (!subs.has(msg.key)) subs.set(msg.key, new Set());
        subs.get(msg.key).add(ws);
        ws.send(JSON.stringify({ type: "value", key: msg.key, value: currentValue(msg.key) }));
        break;
      }
      case "unsubscribe": {
        ws.subscribedKeys.delete(msg.key);
        subs.get(msg.key)?.delete(ws);
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => {
    for (const key of ws.subscribedKeys) subs.get(key)?.delete(ws);
  });
});

server.listen(PORT, () => {
  const addrs = localAddresses();
  console.log("Kwent LAN server running.\n");
  console.log(`  This machine:        http://localhost:${PORT}`);
  if (addrs.length) {
    console.log("  Other players (same network) open one of:");
    addrs.forEach((a) => console.log(`                        http://${a}:${PORT}`));
  } else {
    console.log("  Could not detect a LAN IP — check your network connection.");
  }
  console.log("\nBoth players pick \"Online\" -> \"LAN\" in the menu, then Host/Join as usual.");
});
