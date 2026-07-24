# Kwent LAN server

Play Online Mode with **zero internet** — one player runs this server, both
players connect to it over the local network (same Wi-Fi/router) instead of
Firebase.

## Setup (one-time, needs internet)

```bash
cd web
npm install
npm run build

cd ../lan-server
npm install
```

## Play (no internet needed from here on)

```bash
cd lan-server
node server.js
```

It prints two things:

```
  This machine:        http://localhost:3131
  Other players (same network) open one of:
                        http://192.168.1.42:3131
```

- **Host**: open the `localhost` link.
- **Other player**: open the `192.168.x.x` link the host sees printed (must
  be on the same Wi-Fi/network as the host).

In the game, both players pick **Online → LAN** in the lobby (instead of
Internet), then Host/Join with a room code as usual.

## Notes

- Whoever runs `node server.js` is hosting for the whole LAN session — if
  they close the terminal, the game state is lost (it's all in memory).
- Rebuild (`npm run build` in `web/`) and restart the server after pulling
  any App.jsx changes — the server serves whatever is in `web/dist`.
- Default port is 3131; override with `PORT=4000 node server.js` if that's
  taken.
