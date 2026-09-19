# Orion Social Mobile Only

This bundle is the mobile/PWA build of Orion Social.

## What to Send Members

Send the hosted HTTPS link to the folder in `deploy-this-folder/`. Mobile browsers cannot reliably run this app by opening `index.html` directly from a zip. It must be hosted over HTTPS or localhost.

## Install on Phone

Android Chrome:

1. Open the hosted Orion Social link.
2. Open the browser menu.
3. Tap **Add to Home screen** or **Install app**.
4. Open Orion from the home screen and enable **Phone Node Mode** in the lobby.

iPhone Safari:

1. Open the hosted Orion Social link.
2. Tap **Share**.
3. Tap **Add to Home Screen**.
4. Open Orion from the home screen and enable **Phone Node Mode** in the lobby.

## Notes

- Phone Node Mode participates while the app is open or foregrounded.
- Phones are not treated as hidden always-on servers.
- Keep at least one desktop/anchor node online for reliability when phones sleep.
- Sealed DMs use browser-native **Orion Key** sealing. The phone encrypts/decrypts sealed message payloads locally; Supabase receives ciphertext plus a wrapped secret envelope, not plaintext.
- For launch rehearsal, create a live room from the lobby with **Test 8 agents**. It opens eight simulated agent cameras and agent chat responses so you can check the room before real members join.
- Live rooms include **Battle Mode**. Teams buy discounted battle gifts into inventory, then fire animated hits. Direct Snowball gives +1 toward Godmode, breakpoint hold unlocks bonus mode, and all battle gifts show the unlimited 20% discount.
- Battle gift revenue is shown as **85% to the live room creator/user** and **15% to the network designers**. Real payments must be recorded by the trusted backend ledger, not by the phone UI alone.
- The host can offer to share part of their bounty with room users. In rehearsal this is local; real bounty shares must use the trusted backend offer/accept ledger.
- Battle Mode includes **100 gifts**, with **50 premium animated gifts**. The Stripe checkout gateway must be hosted separately and configured with your Stripe webhook before real mobile purchases.
