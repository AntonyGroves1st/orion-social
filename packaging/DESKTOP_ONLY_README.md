# Orion Social — Desktop EXE Build

## For users receiving `OrionSocial.exe`

**Just double-click `OrionSocial.exe`.** That's it.

- No Node.js needed
- No npm needed
- No Python needed
- No install wizard

The app opens automatically in your default browser at `http://127.0.0.1:5732`.
Keep the black console window open while you use the app — closing it stops the server.

---

## For developers — building the EXE

**Prerequisites (on your build machine only):**
- Node.js 18+ — https://nodejs.org/
- npm (comes with Node.js)
- Must run from a **local drive** (e.g. `C:\Orion`) — not a UNC/network path like `\\Mac\Home\...`

### If you have a UNC/network path problem

Copy the project to a local path first:
```
xcopy /e /i "\\Mac\Home\Downloads\Orion-Social-Desktop-Only" "C:\Orion"
cd C:\Orion
```

### Build steps

1. Make sure `web\.env` has your Supabase keys:
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```
   These keys get baked into the build — share the EXE only with trusted members.

2. Double-click `packaging\build-exe.bat`
   (or run `npm run build:exe` from the repo root)

3. Wait ~2 minutes. The output is:
   ```
   packaging\output\OrionSocial.exe   (~50 MB)
   ```

4. Share `OrionSocial.exe` with your users. Nothing else needed.

### What the EXE contains

- Pre-built React/Vite app (talks directly to Supabase cloud)
- Minimal Node.js HTTP server (no Express, pure built-ins)
- Full Node.js 18 runtime (~40 MB)
- All web assets embedded via `@yao-pkg/pkg`

### Rebuild after code changes

Run `packaging\build-exe.bat` again. It always does a fresh web build.

### Troubleshooting

**Browser says "connection refused" but the black window says RUNNING**

The old build did not embed web files into the EXE. Rebuild with `Build-OrionSocial-EXE.bat` and run the new `packaging\output\OrionSocial.exe`.

**AVG / antivirus "Suspicious file detected" (CyberCapture)**

Unsigned EXEs are often scanned or blocked. When AVG prompts:

1. Choose **Allow** / **Add exception** for `OrionSocial.exe`
2. Or add folder `packaging\output\` to AVG exceptions
3. Run `OrionSocial.exe` again — keep the black console window open

The app only listens on `127.0.0.1:5732` (your PC, not the internet).

**Port 5732 already in use**

Close any other Orion Social / Vite window, then run the EXE again.

---

The EXE covers the core social app. Optional services for advanced features:

| Service | Purpose | Start |
|---------|---------|-------|
| `services/orion-anchor-node` | Always-on mesh relay | `npm run anchor:start` |
| `services/orion-payments` | Stripe battle gifts | `npm run payments:start` |

These still require Node.js if you want to run them. They're not needed for most users.

---

## Notes

- The EXE serves the app at `http://127.0.0.1:5732` (local only — not exposed to internet)
- If port 5732 is already in use, close any other Orion Social windows and retry
- Supabase anon keys are public by design — RLS policies protect the data
- For live room testing: launch 8 agents from the lobby before real members join
- Battle Mode, Royale, Rivalry Arcs, and Clip It all work in the EXE build
