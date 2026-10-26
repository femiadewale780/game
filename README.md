# four. — Real-time Connect Four

A two-player Connect Four game with private room codes, a responsive charcoal interface, lime and lilac pieces, and a small authoritative Node.js server. No accounts, API keys, build step, external assets, or runtime packages are required.

## Start playing

Install Node.js 22 or later, extract the project, and run these commands from a terminal:

```sh
cd connect-four
npm start
```

Open **http://localhost:3000**. Choose **Create a room**, optionally enter a name, then share the six-character code. The second player opens the same game server and uses **Join a room**. Invite links prefill the code.

### Two devices on the same Wi-Fi

1. Run the server on one computer and leave it running.
2. Find that computer's local IPv4 address (Windows: `ipconfig`; macOS: System Settings → Wi-Fi → Details → TCP/IP; Linux: `hostname -I`).
3. On **both** devices, open `http://YOUR-COMPUTER-IP:3000`, replacing the placeholder with that address.
4. Create a room on one device and enter its code on the other. Allow local-network access to Node.js through the computer's firewall if prompted. Guest networks or Wi-Fi client isolation can prevent devices from connecting.

Using the LAN address on both devices also makes copied invite links usable. A link containing `localhost` points at the device opening it and cannot invite another device to your computer.

### Two devices anywhere

Deploy this folder to a host that runs a continuously available Node.js process or Docker container and provides HTTPS. Both players then open that deployment's URL. A static-only host cannot run the game server.

Example Node web-service settings (such as Render):

| Setting | Value |
| --- | --- |
| Service | Web service, Node runtime |
| Node | 24 |
| Build command | `npm test` |
| Start command | `npm start` |
| Health check | `/healthz` |
| Instances | **1** |
| Port | Hosting provider's `PORT` environment variable |
| Public origin | Optionally set `PUBLIC_ORIGIN` to your exact HTTPS origin, e.g. `https://your-game.example` |

1. Put the extracted `connect-four` folder's contents at the root of a Git repository.
2. Connect that repository to a Node web service and apply the settings above.
3. Deploy, open its HTTPS URL in two separate browsers/devices, create a room, and join it.
4. Keep one instance and disable autoscaling for this version.

The server listens on `0.0.0.0` and honors `PORT`. If you run a reverse proxy, preserve the Host header (or set `PUBLIC_ORIGIN`), disable buffering for `/api/rooms/*/events`, and allow long-running responses. The app sends a heartbeat every 15 seconds.

Docker is also supported:

```sh
docker build -t four-connect .
docker run --rm -p 3000:3000 four-connect
```

Deployment documentation: [Render Node web services](https://render.com/docs/deploy-node-express-app), [Render port binding](https://render.com/docs/web-services), [Dockerfile reference](https://docs.docker.com/reference/dockerfile/).

## Build plan and implementation

1. **Design the interface.** `public/index.html` and `public/style.css` define the lobby, create/join form, player cards, board, room sharing, rule dialog, and mobile layouts. Everything uses local HTML/CSS; no font or image downloads.
2. **Model the rules.** `game.mjs` owns the 7-column × 6-row board, gravity, turn order, wins in all four directions, and draws. It has no browser or transport dependency.
3. **Create private rooms.** `server.mjs` generates random six-character codes and unguessable per-seat credentials. Joining atomically reserves the second seat. A third player is rejected.
4. **Synchronize devices.** A JSON POST sends each action to the server. An authenticated server-sent event stream immediately sends the authoritative state to both players. Clients never decide whether a move is legal.
5. **Handle the full game lifecycle.** Refresh restores the same seat in the same tab. Network interruptions pause moves and trigger automatic reconnect. Winning lines are marked, scores persist through rematches, both players must agree to a rematch, and the first player alternates.
6. **Validate and launch.** Run the rule/server tests, exercise two browsers with the checklist below, and deploy one server for internet play.

## Included features

- Six-character room codes and invite links; exactly two seats.
- Live moves and opponent presence across independent connections.
- Optional player names; no login.
- Server-validated turns, full columns, all win directions, and draws.
- Falling pieces, last-move marker, winning-line rings, and session scores.
- Mutual rematches with alternating starting player.
- Same-tab refresh recovery, stream reconnect, and stale/duplicate move protection.
- Touch-friendly columns, keys **1–7**, focus styles, readable column labels, distinct piece symbols, and reduced-motion support.
- Copy-code fallback for HTTP on a home network.
- Input limits, room capacity, basic rate limits, security headers, and origin checks.

## Testing

```sh
npm test
```

The dependency-free suite uses `node:test` and real local HTTP/event-stream connections. It covers gravity, turn validation, full columns, horizontal/vertical/both diagonal wins, a legal 42-move draw, private seat credentials, simultaneous joins, duplicate requests, stream synchronization, reconnects, mutual rematches, scores, leaving, and idle expiration.

Validation in the build environment: **17 automated tests passed** on Node.js 24. JavaScript syntax checks also passed. A graphical browser could not be run against the local app: the environment's browser binary download was blocked, and the remote browser could not reach the local server. Desktop/mobile visual checks therefore remain unverified. The Docker image and public deployment were not run here.

Manual browser checklist:

1. Open the game in two independent browsers or devices (separate tabs also work when opened directly, without cloning a player's tab).
2. Create a room as Ada. Join as Lin. Confirm both boards say Connected and identify the local player.
3. Verify only Ada can move first. Refresh each tab after a move; the same seat and pieces should return.
4. Alternate columns **1, 2, 1, 2, 1, 2, 1**. Ada wins vertically; both boards show the winning pieces and the score is 1–0.
5. Choose Play again on each device. The board resets only after both agree; Lin goes first.
6. Turn one device's network off, then on. Moves pause and resume with the same board.
7. Try a third browser, a bad room code, and filling a column. Verify clear feedback and no illegal move.
8. Check 320 px, 390 px, tablet, and desktop widths; keyboard-only navigation; reduced motion; copy code; invite links; and the rules/leave dialogs.
9. Complete the round, agree to rematch, and verify scores persist. Leave the room and verify the other player sees it end.

## Architecture and limits

This is a working small-game implementation, intended for one Node.js server. Room state lives **in memory**. Server restarts, deploys, or host sleep clear active rooms and scores. Rooms expire after 30 minutes with both players disconnected. An explicit Leave ends the room for both players. A seat stays reserved while its player is disconnected; a different browser cannot claim it. Closing the tab discards its session credential; refreshing the same tab preserves it where session storage is enabled. A duplicated tab takes over the same seat's live stream.

Six-character codes are invitation codes, not private-account access controls. Only share a code with the friend you want to join. Seat credentials are kept in `sessionStorage`, sent in Authorization headers, and never included in opponent snapshots or invite URLs.

Rate limits use the direct connection address, intentionally ignoring untrusted forwarded headers. Behind a reverse proxy, clients may share a limit. For a larger public service, add trusted-proxy-aware limiting at the edge, persistent/shared room storage, coordinated atomic moves, and distributed pub/sub before adding server replicas. There are no analytics or external trackers.

Server-sent events provide the server-to-browser live channel; ordinary POST requests carry moves back. Reference: [MDN server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).

## Files

| File | Purpose |
| --- | --- |
| `server.mjs` | HTTP API, room lifecycle, streams, static assets, security |
| `game.mjs` | Pure Connect Four rules |
| `public/index.html` | Accessible page structure and dialogs |
| `public/style.css` | Dark theme, responsive layouts, animation |
| `public/app.js` | UI, room actions, stream reconnect, session recovery |
| `public/favicon.svg` | Original four-piece mark |
| `test/*.test.mjs` | Rules and HTTP integration tests |
| `Dockerfile` | Optional container deployment |
