# Orion Social

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

Invite-only community app (~**1000** members) on **Supabase** (free Postgres + Auth + Realtime): **DM messaging** with optional **zero-server-secret Orion sealing** (ephemeral secret + ECDH wrap to peers), **public browseable Live rooms**, an interactive **3D live network map**, and **up to 7 on-camera publishers** per room in a **TikTok-style grid** — mesh WebRTC (signaling in Postgres, **no video storage** wired in).

Orion cryptography uses your existing package at `../orion-key/` (MIT / see that repo’s `SECURITY.md`).


## Security / secrets (read this)

**Do not commit real keys.** This repo ships `.env.example` files only.

- Copy `web/.env.example` → `web/.env` and fill your own Supabase URL + **anon** key.
- Service-role / Stripe / TURN credentials belong in **server** `.env` files that are gitignored.
- Never paste service-role keys into `web/` or the client.
- The default invite code in docs is a **dev seed** — rotate it for any public deploy.

If you find a leaked secret in git history, rotate it immediately and open an issue.

## 1) Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → run **`supabase/RUN_ONCE_IN_SQL_EDITOR.sql`** once (rolls up migrations), *or* run files under **`supabase/migrations/`** in timestamp order via **`supabase db push`** / **`npm`** scripts.

   **Already ran an older bootstrap?** Paste **`supabase/DELTA_RUN_IN_SQL_EDITOR.sql`** once — it includes the RLS recursion fix, listed-live reads, Realtime publication, DM/live-room hardening, and stale WebRTC signal cleanup.

   **Or from this folder (hosted project):** one-time **`npx supabase login`** and **`npm run db:link`** (paste your **project ref** from `https://<ref>.supabase.co`), then **`npm run db:fix-invite`** to apply **`supabase/FIX_CLAIM_INVITE_RPC_ONLY.sql`**, **`npm run db:harden`** to apply the production hardening migration, and **`npm run db:verify-invite`** to sanity-check (**`npm run db:run-once-sql`** runs the entire run-once file remotely).
3. **Database → Replication** → ensure Realtime includes `messages`, `webrtc_signals`, and `conversation_members` (the DELTA migration adds them via `supabase_realtime` when possible; Dashboard toggle is the fallback).
4. **Authentication → Providers → Email** → for local dev, turn **off** “Confirm email” (or complete email flow before claiming invite).
5. Copy **Project URL** and **anon public/publishable key** into `web/.env` (from `.env.example`). Never place the Supabase **service role** key in the web folder.

Default invite code seeded: `ORION-FOUNDER-2026` (1000 uses). Mint more in SQL:

```sql
insert into public.invite_codes (code, uses_left) values ('FRIEND-001', 5);
```

## 2) Python deps (bridge + Orion Key)

**Orion Key** (`F:\socialmedia G\orion-key`):

```bash
pip install -e .
```

**Bridge** (FastAPI + uvicorn, from `services/orion-bridge`):

```bash
pip install -r requirements.txt
```

(Ephemeris / Hipparcos data will download on first Orion Key use — see that repo’s README.)

## 3) Run the web app + bridge

**Option A — Windows**

Double-click `Start-Orion-Social.bat` (starts `python main.py` in `services/orion-bridge` and `npm run dev` in `web`).

**Option B — manual**

```bash
cd "services/orion-bridge"
python main.py
```

```bash
cd ".\web"
npm install
npm run dev
```

Open **http://localhost:5732**

Vite proxies `/orion/*` → `http://127.0.0.1:8790` for legacy Orion bridge compatibility. New sealed DMs use browser-native Orion Key sealing and do not send the per-message secret to the bridge.

## 4) Phone node mode

The web app is now installable on phones as a PWA. Serve it from HTTPS for real devices, then install:

- Android Chrome: menu -> Add to Home screen / Install app.
- iPhone Safari: Share -> Add to Home Screen.

Open the installed app, sign in, go to the lobby, and enable **Phone Node Mode**. Phones participate while the app is open/foregrounded. Use anchor nodes below for always-on network presence.

## 5) Always-on anchor node

Anchor nodes keep Orion reachable when phones sleep.

```bash
npm run anchor:install
```

Copy `services/orion-anchor-node/.env.example` to `services/orion-anchor-node/.env`, fill in your Supabase URL and public anon/publishable key, then:

```bash
npm run anchor:start
```

For production, run it under a service manager such as systemd, PM2, Docker, or Windows Task Scheduler.

## 6) Verify

To rehearse launch before members arrive, sign in, open the lobby, and click **Test 8 agents**. Orion creates a live room with eight simulated agent cameras and chat responders so you can verify the stage, thumbnails, live chat flow, and Battle Mode.

Battle Mode is currently a client-side launch rehearsal layer: teams buy discounted battle gifts into inventory, then fire them as animated hits. Direct Snowball adds +1 toward Godmode, breakpoint hold unlocks bonus mode, and all battle gifts show the unlimited 20% discount.

Revenue split is set to **85% to the live room creator/user** and **15% to the network designers**. The UI shows this split per gift and in running battle totals. The host can also offer to share part of their user payout bounty with room users; the rehearsal UI reserves those offers from the available bounty pool.

Battle Mode now has **100 gifts**, with **50 premium animated gifts**. The **Stripe** button opens Stripe Checkout; the **Demo** button keeps local rehearsal testing available without charging.

Before taking real money, run the ledger migration and let the Stripe webhook insert purchases from the trusted payment service. The same migration adds `battle_bounty_share_offers` so bounty shares can be offered, accepted, declined, or canceled against the trusted creator payout pool:

```bash
npm run db:battle-split
```

## 7) Stripe payments

Copy `services/orion-payments/.env.example` to `services/orion-payments/.env`, then fill in:

- `JWT_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PUBLIC_ORIGIN`

Start the gateway:

```bash
npm run payments:install
npm run payments:start
```

The web app proxies `/payments/*` to `http://127.0.0.1:8791` in local dev. For live creator payouts, store each creator’s Stripe Connect account id in `profiles.stripe_account_id`; when present, the Checkout Session uses a destination charge so the creator receives the payout and the network keeps the 15% application fee. If no connected account is present, the payment is recorded in the ledger for manual payout.

```bash
npm run typecheck
npm run build
```

## Security notes (plain language)

- **Do not** expose `orion-bridge` to the internet unauthenticated/TLS-less — anyone who can reach it becomes part of your trust boundary for **opening** Orion tokens locally.
- **Plain chat** lives as normal rows behind Supabase RLS (**TLS-only** confidentiality vs operators).
- **“Seal with Orion Key”** in DMs: the browser picks a random Orion `secret`, encrypts the message locally with AES-256-GCM, and **never writes plaintext or the secret to Postgres**. Supabase receives only the browser-native Orion ciphertext token plus an **ECDH-wrapped secret envelope**, so only recipients with matching **device-held private keys** can reconstruct the secret and open the message in browser. Device keys sit in **`localStorage`** unless you migrate to secure enclave/OS keystore-backed storage later. Legacy bridge-made sealed messages can still fall back to local `/orion/v1/open`.
- **WebRTC**: public **STUN** only → add **TURN** for hard NAT/mobile; mesh at 8 is expensive — plan an **SFU** for production reliability.
- Truncate/cron-delete `webrtc_signals`; it grows fast with ICE.

## Portable packaging

**Windows desktop (single EXE):**

```bash
npm run build:exe
```

Output: `packaging/output/OrionSocial.exe` — double-click to run; no Node.js needed on user machines.

**Android APK:**

```bash
npm run build:apk
```

Requires JDK 17+ and Android SDK (`ANDROID_HOME`). Output: `packaging/output/OrionSocial.apk`.

See `packaging/DESKTOP_ONLY_README.md` and `packaging/APK_BUILD_README.md` for full build instructions.

This repo is a **web client** + optional **Python bridge**. The EXE bundles the built web app with a tiny Node static server via `@yao-pkg/pkg`. The APK wraps the same build with Capacitor.

## Licence

The social app scaffold is for your use alongside Orion Key’s MIT licence (see `orion-key/LICENSE`).

## License

Copyright (c) 2026 Antony John Groves.

Released under the [MIT License](./LICENSE). Orion Key crypto lives in the sibling [`orion-key`](../orion-key) package (also MIT).

