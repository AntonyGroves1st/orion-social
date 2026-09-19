# Orion Node Network

Orion Node Mode turns browsers and phones into opt-in edge nodes. Nodes do not act like hidden background servers. They advertise signed capability heartbeats while the user explicitly allows the device to participate.

## Current MVP

- `web/src/lib/orionNodeProtocol.ts` defines the shared node contract.
- `web/src/components/NodeModePanel.tsx` lets a logged-in member start Node Mode from the lobby.
- `web/public/manifest.webmanifest` and `web/public/orion-sw.js` make the web client installable on phones as a PWA.
- `services/orion-anchor-node` runs an always-on signed heartbeat node for VPS, desktop, or Raspberry Pi.
- Nodes generate a local ECDSA P-256 signing key and publish signed `NODE_HEARTBEAT` envelopes.
- Heartbeats broadcast over Supabase Realtime channel `orion-node-heartbeats`.
- Other active clients verify signatures before showing a peer as live.

## Phone PWA

Run the web app over HTTPS or localhost, then install it from the browser:

- Android Chrome: menu -> Add to Home screen / Install app.
- iPhone Safari: Share -> Add to Home Screen.

The phone participates while the PWA is open or foregrounded. When the phone sleeps, anchor nodes keep the network reachable.

## Anchor Node

Install and run from the repo root:

```bash
npm run anchor:install
```

Create `services/orion-anchor-node/.env` from `.env.example`, then:

```bash
npm run anchor:start
```

The anchor stores its local signing key under `services/orion-anchor-node/.orion-anchor/`. Do not commit that folder.

## Node Roles

- `BROWSER_ACTIVE`: current web client, tab open.
- `PHONE_ACTIVE`: native mobile app open or foregrounded.
- `PHONE_SLEEPING`: native app can receive push wakeups and sync later.
- `ANCHOR`: always-on VPS, desktop, or Raspberry Pi node.
- `TURN_RELAY`: regional TURN relay for WebRTC fallback.

## Phone Reality

iOS and Android should not be treated as always-on servers. A native app should:

- run full relay/node behavior while foregrounded;
- use visible Android foreground service only when the user explicitly enables it;
- use push notifications and short background sync for wakeups;
- obey battery, charging, cellular, and data cap policies;
- fall back to anchor nodes when phones sleep.

## Finish-Line Build Order

1. Keep Node Mode in the web lobby as the control surface.
2. Add a native Expo app that reuses the protocol contract.
3. Add regional TURN servers and include region/capability selection in heartbeats.
4. Add anchor nodes that publish the same signed heartbeats.
5. Add store-forward encrypted message envelopes.
6. Add trust scoring from signed uptime, relay success, and policy compliance.

## Envelope Rule

Any future phone app, anchor node, or relay must sign the same canonical payload shape and verify peer envelopes before trusting them.
