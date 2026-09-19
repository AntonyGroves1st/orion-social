# Orion Social — Android APK Build

## For users receiving `OrionSocial.apk`

1. Copy `OrionSocial.apk` to your Android phone.
2. Open the file and allow install from this source if prompted.
3. Launch **Orion Social** from the app drawer.
4. Sign in with your invite code and enable **Phone Node Mode** in the lobby when ready.

---

## For developers — building the APK

**Prerequisites (build machine only):**

| Tool | Notes |
|------|-------|
| Node.js 18+ | https://nodejs.org/ |
| Java JDK 17+ | https://adoptium.net/ |
| Android SDK | Install via [Android Studio](https://developer.android.com/studio) |

Set your SDK path (PowerShell example):

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
```

### Build steps

1. Put Supabase keys in `web\.env` (same as desktop):

   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```

2. Run the builder:

   ```
   packaging\build-apk.bat
   ```

   Or from repo root:

   ```
   npm run build:apk
   ```

3. Output:

   ```
   packaging\output\OrionSocial.apk
   ```

First run creates `web\android\` via Capacitor and may download Gradle dependencies (several minutes).

### Rebuild after code changes

Run `packaging\build-apk.bat` again. It always rebuilds the web bundle and syncs into Android.

### Release (signed) APK

The default builder produces a **debug** APK for testing. For Play Store or sideload distribution with your own signing key, open the Android project in Android Studio:

```
cd web
npx cap open android
```

Then use **Build → Generate Signed Bundle / APK**.

---

## Desktop EXE (separate builder)

Windows single-file desktop app:

```
packaging\build-exe.bat
```

Or:

```
npm run build:exe
```

Output: `packaging\output\OrionSocial.exe`

See `packaging\DESKTOP_ONLY_README.md` for details.
