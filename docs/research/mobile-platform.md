# Research: one app on iOS and Android, no app store

Date: 22 Oct 2026 · Status: research done, decision taken (see `DECISIONS.md` D-001)

## The question

Staff and the owner need the app on Android phones (mostly low-to-mid range) and
iPhones. It will **not** be published on Google Play or the Apple App Store. What
is the best way to build and install it?

## First, what "on the local device" can and cannot mean

The app *lives* on the phone: an icon on the home screen, opens full-screen,
captures invoices with no internet, and keeps a local copy of the work in progress.

It cannot keep **all** data only on one phone. Six stores, many staff and one
owner have to see the same vendors, bills and payables, and the owner approves
payments for every store. That needs one shared database that every phone syncs
with. So the setup is:

```
 Phones (staff + owner)              One small server (owned by the business)
 ┌──────────────────────┐   HTTPS    ┌───────────────────────────────────────┐
 │ Home-screen app      │ ─────────► │ API + database + invoice images + OCR │
 │ offline capture queue│ ◄───────── │ bank file export, ERP export          │
 └──────────────────────┘   sync     └───────────────────────────────────────┘
```

"No app store" changes **how the app is installed**. It does not remove the need
for this server.

## Options compared

| | A. Installable web app (PWA) | B. Capacitor (web code inside a native shell) | C. React Native / Expo (native app) |
|---|---|---|---|
| One codebase for iOS + Android | Yes | Yes | Yes |
| Install on Android without Play | Open link → "Install app" | Sideload APK | Sideload APK |
| Install on iPhone without App Store | Safari → Share → Add to Home Screen | Needs Apple Developer Program ($99/yr), max 100 registered devices per year, profile renewed yearly | Same as B |
| Android developer verification (rolling out globally from 2027) | Not affected (not an APK) | Affected: sideloaded APKs need a verified developer, or users go through a 24-hour "advanced flow" | Same as B |
| Updates | Automatic on next open | Rebuild and reinstall (or a live-update service) | Rebuild and reinstall (or EAS Update) |
| Camera capture | Yes, through the browser | Yes, native plugin | Yes, native, best quality |
| Offline storage | IndexedDB; home-screen apps on iOS 17+ get a large quota; request persistent storage | Native file storage | Native file storage |
| Background upload when app is closed | No on iOS | Limited | Yes |
| Push notifications on iPhone | iOS 16.4+, only once added to the home screen | Yes | Yes |
| Owner second factor (fingerprint / Face ID) | WebAuthn passkeys | Native biometrics | Native biometrics |
| Matches the brief's default (§9) | Yes | Brief allows it as "wrapper later" | Would need a written reason |

## Recommendation

**Build option A: one installable PWA** (React + TypeScript + Vite), served by
our own server over HTTPS. Keep the code portable so option B (Capacitor) is
possible later without a rewrite.

Why A is the best fit for this business:

1. **iPhone without the App Store is only easy as a PWA.** Every native route
   needs an Apple developer account, device registration and yearly renewal.
   A PWA needs a link.
2. **Android sideloading is getting harder.** Google's developer verification
   puts friction on unverified APKs. A PWA is not an APK, so it avoids this.
3. **Updates reach all phones the next time staff open the app.** Nobody has to
   reinstall anything on 50 or 500 phones.
4. **The hard work is on the server anyway.** OCR, AI extraction, validation,
   payments and bank files run on the server. The phone only captures, checks
   and approves, which a PWA handles well.
5. **Adding store 7 or store 100** means sending staff a link, not managing devices.

### Known PWA limits and how we handle them

| Limit | Mitigation |
|---|---|
| iOS has no install prompt | An in-app "How to install" screen with pictures (Hindi + English); one-time setup by the store manager |
| iOS may clear site data in rare cases | Ask for persistent storage (`navigator.storage.persist()`), upload captures as soon as there is signal, show an "unsynced" badge, never treat the phone as the only copy |
| No background upload on iOS | Upload when the app is open; show a clear "3 bills waiting to upload" banner |
| Safari lacks the `BarcodeDetector` API | Use one WebAssembly QR/barcode decoder (zxing) on both platforms |
| Low-end Android performance | Edge detection and compression in a Web Worker; heavy OCR on the server, not the phone |
| Camera permission prompts | Use `<input capture>` as a fallback that always works; live camera when allowed |

### When we would switch to Capacitor (option B)

Only if field tests in M1 show one of these is a blocker: unreliable camera or
storage on the staff's actual iPhones, a need for background upload, or a need
for native document scanning. The same React code then goes inside a Capacitor
shell. Android: sideload the APK. iPhone: Apple Developer Program ad hoc
distribution (up to 100 devices per year).

## Where the server runs

The server must be reachable over **HTTPS** from all stores, because iPhones
only allow camera access, offline caching and install for secure sites.

- **Recommended:** a small Linux VPS in an Indian data centre (keeps data in India,
  always online), domain name + free Let's Encrypt certificate, Docker Compose.
- **Cheaper alternative:** a PC at the head office running the same Docker
  Compose stack, exposed with a tunnel (for example Cloudflare Tunnel or Tailscale).
  The PC has to stay on, and backups are our job.

## Facts still to verify on real devices (M1 gate)

These come from vendor blogs and secondary reporting, not first-hand tests:

- Live camera, IndexedDB size and persistence in a home-screen web app on the
  staff's actual iPhone models and iOS version.
- Smoothness of capture and swiping on the cheapest Android phone in use.
- Android developer-verification dates for India (reported as global from 2027);
  only matters if we ever ship an APK.
- Apple ad hoc limits and fees, only if we move to option B.

## Sources

- WebKit: Updates to Storage Policy (Safari 17 quotas) — https://webkit.org/?p=14403
- MDN: Storage quotas and eviction criteria — https://developer.mozilla.org/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- Ionic: A note on iOS 17.4 and PWAs (EU reversal) — https://ionic.io/blog/a-note-on-ios-17-4-and-pwas
- MagicBell: PWA iOS limitations — https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide
- Microsoft Learn: iOS ad hoc distribution — https://learn.microsoft.com/en-us/dotnet/maui/ios/deployment/publish-ad-hoc
- TestApp.io: distributing iOS apps without the App Store — https://blog.testapp.io/how-to-distribute-your-ios-app-without-using-the-app-store/
- Android Developers: developer verification — https://developer.android.com/developer-verification
- Google support: Understanding Android developer verification — https://support.google.com/android-developer-console/answer/16561738
- The Hacker News: 24-hour wait for unverified apps — https://thehackernews.com/2026/03/google-adds-24-hour-wait-for-unverified.html
- PkgPulse: React Native vs Expo vs Capacitor 2026 — https://www.pkgpulse.com/guides/react-native-vs-expo-vs-capacitor-cross-platform-mobile-2026
