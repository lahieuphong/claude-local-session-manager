# Microsoft Store distribution

Claude Local Session Manager ships through two **independent** Windows channels
built from the same repository and the same version number:

| Channel | Artifacts | Updates |
|---|---|---|
| **GitHub** (existing) | NSIS Setup `.exe`, Portable `.exe`, `latest.yml`, `.blockmap`, `SHA256SUMS.txt` | electron-updater + GitHub Releases (Setup); manual (Portable) |
| **Microsoft Store** (this document) | `.appx` package for a manual Partner Center upload | Managed by the Microsoft Store |

Nothing in this document publishes anything automatically. The Store package is
built locally (or by the manual `store-build` workflow) and uploaded by you in
Partner Center. Certification is decided by Microsoft and is **not guaranteed**.

---

## 1. How the Store build differs

- **Package format: AppX.** The project uses electron-builder **26.15.3**, whose
  stable Store target is `appx` (the `msix` target exists only in the v27 beta
  line; the project is deliberately not upgraded to a beta for it). Partner
  Center accepts `.appx` packages.
- **Full-trust desktop app.** The package runs the normal Electron app with
  `EntryPoint="Windows.FullTrustApplication"` and the `runFullTrust`
  restricted capability, so it can read `%USERPROFILE%\.claude`, Claude
  Desktop's metadata and your project folders exactly like the Setup build.
- **No AppData write virtualization.** Packaged desktop apps normally have their
  writes under `%APPDATA%` / `%LOCALAPPDATA%` redirected into a private package
  folder. Archive and permanent delete must change Claude Desktop's real files,
  so the manifest sets `desktop6:FileSystemWriteVirtualization=disabled`, which
  requires the restricted capability `unvirtualizedResources`. These two are the
  only capabilities requested. Minimum Windows version: 10.0.19041 (Windows 10 2004).
- **Updates come from the Store.** The packaged app is marked
  `distributionChannel: "store"`. In that channel the GitHub updater
  (electron-updater) is never loaded, never checks GitHub at startup and can
  never run the GitHub Setup over the package; it is not even included in the
  Store package. Settings → Updates shows *"Updates are managed by Microsoft
  Store"* with an **Open Microsoft Store** button (official
  `ms-windows-store://downloadsandupdates` URI). A **View in Microsoft Store**
  button appears only after a real Store ID is configured (§4).
- **Safe Mode is unchanged.** Every launch — fresh install, restart, after a
  Store update or a GitHub update — starts in SAFE MODE. Real Delete Armed is
  never saved. Delete plans, hashing, expiry, path validation, workspace
  protection, link rejection, the process guard and the typed `DELETE`
  confirmation are identical in both channels.
- **Not signed by us.** Store submissions do not need your own code-signing
  certificate: Microsoft signs the package after certification. No certificate
  or private key is used, generated or committed.

### Feature matrix

| Feature | GitHub Setup | GitHub Portable | Microsoft Store |
|---|---|---|---|
| Session scanning | Yes | Yes | Yes |
| Archive / Restore (Claude Desktop) | Yes | Yes | Yes |
| Hide in manager | Yes | Yes | Yes |
| Permanent delete (Safe Mode + armed, typed confirmation) | Yes | Yes | Yes |
| Safe Mode on every launch | Yes | Yes | Yes |
| Languages (English, Tiếng Việt, 简体中文) | Yes | Yes | Yes |
| GitHub updater (electron-updater) | Yes | Notify only | **No** (not included) |
| Store-managed updates | No | No | **Yes** |
| Install location | `%LOCALAPPDATA%\Programs\…` | wherever you run it | Windows app package |
| SmartScreen | direct download (unsigned for now) | direct download | Store distribution |

### Where data lives

| | GitHub Setup / Portable | Microsoft Store |
|---|---|---|
| App data (`app.getPath("userData")`): settings, language, hidden list, scan cache, logs | `%APPDATA%\Claude Local Session Manager` | the **same** folder (write virtualization is disabled, so it is not redirected into the package) |
| Claude data (`~\.claude`, Claude Desktop metadata) | read from the real locations | read from the real locations |

- Language, motion and other manager preferences therefore persist across Store
  updates (and are shared if both channels are installed on the same account).
- Nothing important is stored inside the installed package directory.
- Uninstalling the Store app does not delete `%APPDATA%\Claude Local Session
  Manager`; delete it yourself if you want. Neither channel ever deletes or
  migrates `~\.claude`, Claude transcripts, Claude Desktop metadata or your
  source projects on install, update or uninstall.
- Settings → About → Diagnostics shows the distribution, user home, Claude
  transcript root, Claude metadata roots and the app data folder for
  troubleshooting. These paths are only displayed locally.

---

**This product (configured in `store/identity.json`):** Identity Name `LaHieuPhong.ClaudeLocalSessionManager`,
Publisher `CN=CA5468D0-A735-4CDB-9E0A-A0CDD47D1EA5`, Publisher display name
`La Hieu Phong`, Store ID `9N5XNN8H1TSZ`
(<https://apps.microsoft.com/detail/9N5XNN8H1TSZ>, live after certification).

## 2. Prerequisites

- A Microsoft **Partner Center** developer account enrolled in the Windows &
  Xbox (apps and games) program — check Partner Center for the current
  registration requirements.
- Windows 10 2004+ or Windows 11 with Node.js 24 and Yarn 1.x (same as the
  GitHub build). No Windows SDK is needed: electron-builder downloads the
  `makeappx`/`makepri` tools.
- A public **privacy policy URL** (Partner Center asks for one for apps that
  access personal information; this app reads local session files). You can
  link the repository's [`store/privacy.md`](../store/privacy.md).

## 3. Reserve the app name

1. Sign in to [Partner Center](https://partner.microsoft.com/dashboard).
2. Open **Apps and games**.
3. Select **+ New product** → **MSIX or PWA app**.
4. Enter **Claude Local Session Manager**, select **Check availability**, then
   **Reserve product name**.
   - If the name is not available, reserve another name. The build does not
     depend on this exact name: put the reserved name in `displayName` (§4).
   - **Trademark warning:** "Claude" is Anthropic's trademark. A product name
     containing a third-party trademark can be refused at reservation or
     certification. The listing must state that this is an unofficial tool not
     affiliated with Anthropic (the drafts in `store/listing/` do).

## 4. Copy the package identity

1. In Partner Center open the new product → **Product management** →
   **Product identity**.
2. Copy these values **exactly**:

| Partner Center field | Our setting | Environment variable |
|---|---|---|
| `Package/Identity/Name` | `identityName` | `STORE_IDENTITY_NAME` |
| `Package/Identity/Publisher` (starts with `CN=`) | `publisher` | `STORE_PUBLISHER` |
| `Package/Properties/PublisherDisplayName` | `publisherDisplayName` | `STORE_PUBLISHER_DISPLAY_NAME` |
| The reserved product name | `displayName` | `STORE_DISPLAY_NAME` |
| **Store ID** (12 characters, starts with `9`) — optional | `storeProductId` | `STORE_PRODUCT_ID` (or `STORE_ID`) |

3. Put them either in [`store/identity.json`](../store/identity.json) (not
   secret; can be committed) or in environment variables (which override the
   file). For the `store-build` workflow, add them as repository **variables**
   (Settings → Secrets and variables → Actions → **Variables**).

The values are validated before anything is built. Missing or placeholder
values stop the build with `STORE BUILD BLOCKED WAITING FOR PARTNER CENTER
IDENTITY` and the list of fields to copy — electron-builder's own fallbacks
(`CN=ms`, the npm package name) are never used. The Store ID only enables the
optional **View in Microsoft Store** button; leave it empty until Partner Center
shows it.

## 5. Build the package

```powershell
yarn store:check      # identity, version mapping and assets — no build
yarn dist:store       # → dist\store\Claude-Local-Session-Manager-X.Y.Z.0-x64.appx
```

`dist\store\` then contains:

| File | Purpose |
|---|---|
| `Claude-Local-Session-Manager-X.Y.Z.0-x64.appx` | the package to upload |
| `AppxManifest.xml` | the generated manifest (for review) |
| `manifest-review.txt` | field-by-field review with PASS/FAIL checks |
| `SHA256SUMS.txt` | checksum of the package |
| `win-unpacked\` | the unpacked app (local testing only, never upload) |

`yarn dist` (= `yarn dist:github`) is unchanged and still produces only the
GitHub Setup/Portable artifacts in `dist\`; the Store output lives in
`dist\store\`. Note that `yarn dist` cleans the whole `dist\` folder.

**Toolchain check without an identity:** `yarn dist:store:test` builds
`dist\store-test\…-TEST-NOT-FOR-STORE.appx` with an obviously fake identity
(`CN=LOCAL-TEST-NOT-FOR-STORE`). It exercises packaging and the manifest review
only. **Never upload it** — the Store would reject it anyway.

On GitHub: **Actions → Microsoft Store package (manual) → Run workflow** builds
the same files after test/typecheck/build and keeps them as a workflow artifact
(`microsoft-store-package-<commit>`). It never creates a release or submits
anything, and needs no secrets.

### Version mapping

`package.json` stays the only version source. The Store package version is
derived as **`X.Y.Z` → `X.Y.Z.0`** (e.g. `1.3.0` → `1.3.0.0`, GitHub tag
`v1.3.0`). The fourth part is reserved by the Store and stays `0`; each part
must be ≤ 65535 and the major version ≥ 1. Every new Store submission must have
a higher version than the previous one, so bump `package.json` (the usual
`yarn release:patch|minor|major`) before building a new Store package.

## 6. Validate the package

1. Read `dist\store\manifest-review.txt`: every check must say PASS — identity
   name, publisher, publisher display name, display name, version, `x64`,
   `Windows.Desktop`, full-trust entry point, `runFullTrust`, only
   `unvirtualizedResources` besides it, write virtualization disabled,
   languages `en-US, vi-VN, zh-CN`, all visual assets, no `app-update.yml`, the
   `store` channel marker and no electron-updater in the package.
2. Optional local install test (requires **Developer Mode**; Settings → System →
   For developers). An unsigned package cannot be installed with a double-click.
   With Developer Mode on you can register the unpacked layout:
   ```powershell
   # makeappx.exe is in %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\…\windows-10\x64
   makeappx.exe unpack /p dist\store\Claude-Local-Session-Manager-X.Y.Z.0-x64.appx /d %TEMP%\clsm-store-layout
   Add-AppxPackage -Register "$env:TEMP\clsm-store-layout\AppxManifest.xml"
   # …test, then remove it:
   Get-AppxPackage *ClaudeLocalSessionManager* | Remove-AppxPackage
   ```
   Then check Settings → About: *Distribution: Microsoft Store*, *Updates:
   Managed by Microsoft Store*; the session list loads; the status strip shows
   SAFE MODE. Do not test deletion on real sessions.
3. Optional: run the Windows App Certification Kit (part of the Windows SDK)
   against the installed app.

## 7. Submit

1. In the product, select **Start your submission**.
2. **Pricing and availability:** markets, visibility, free.
3. **Properties:** category (e.g. *Developer tools*), privacy policy URL, support
   contact, system requirements (keyboard/mouse; Windows 10 2004+).
4. **Age ratings:** complete the questionnaire.
5. **Packages:** upload `dist\store\Claude-Local-Session-Manager-X.Y.Z.0-x64.appx`.
   Partner Center checks the identity against the reservation here.
   Device families: Windows 10/11 Desktop.
6. **Store listings:** use the drafts in [`store/listing/`](../store/listing/)
   (English, Tiếng Việt, 简体中文) and screenshots (see
   [`store/screenshots/README.md`](../store/screenshots/README.md)).
7. **Submission options → Restricted capabilities:** explain why they are needed:
   - `runFullTrust`: *Desktop (Electron) application. It reads Claude Code and
     Claude Desktop session files in the user's profile, shows which Claude
     processes are running, and opens folders in File Explorer.*
   - `unvirtualizedResources`: *The app archives, and on explicit typed user
     confirmation permanently deletes, Claude Desktop session files stored under
     the user's AppData. With write virtualization those changes would go to the
     app's private package copy and never reach Claude Desktop, showing the user
     a false result. Writes only touch the exact files listed in a plan the user
     reviewed.*
8. **Notes for certification:** e.g. *The app starts in Safe Mode (dry run) and
   cannot delete anything until the user arms deletion in Settings → Deletion
   safety by typing ENABLE DELETE. It needs local Claude Code/Claude Desktop
   data to show sessions; without it the list is empty. No account or network
   service is required. Not affiliated with Anthropic.*
9. **Submit to the Store** and wait for certification.

## 8. Later versions

1. Bump the version and release on GitHub as usual (`yarn release:minor`, push
   the commit and the tag → GitHub Releases).
2. `yarn dist:store` (or run the `store-build` workflow on that commit).
3. Partner Center → **Update** submission → **Packages** → upload the new
   `.appx` (version must be higher than the last Store version) → submit.

Store users receive the update from the Store; GitHub Setup users from GitHub
Releases; Portable users download manually.

## 9. Certification notes and risks

- **Trademark/name** — the most likely blocker (see §3). Have an alternative
  name ready; the build accepts any reserved `displayName`.
- **Restricted capabilities** — `runFullTrust` is standard for desktop apps;
  `unvirtualizedResources` gets extra review and needs the justification above.
- **Deleting another app's data** — permanent delete removes Claude session
  files. It is always explicit: Safe Mode by default, arming by typing
  `ENABLE DELETE`, an exact reviewed plan, a typed `DELETE`/`DELETE <n>`
  confirmation, one delete per arming, 10-minute expiry.
- **Process detection** runs Windows PowerShell (`Get-CimInstance
  Win32_Process`, read-only, fixed script, hidden window). Reviewers or security
  tools may notice a PowerShell child process.
- **Opening folders/links** uses `shell.openPath` / `showItemInFolder` on paths
  from the scanner, and fixed GitHub / Microsoft Store URLs only.
- **Self-update** — not present in the Store package (electron-updater is
  excluded and never initialized in the Store channel).
- **Privacy** — see [`store/privacy.md`](../store/privacy.md); answer the
  Partner Center privacy questions consistently with it.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| `STORE BUILD BLOCKED WAITING FOR PARTNER CENTER IDENTITY` | Copy the values from Product identity (§4). |
| Upload error about package identity / publisher | The values must match Product identity character for character (including spaces in `CN=…`). |
| Upload error about version | The version must be higher than the previous Store version and end with `.0`. Bump `package.json`. |
| `Cannot create symbolic link … darwin … libcrypto.dylib` while building | Harmless: electron-builder's tool archive contains macOS links that Windows cannot create without Developer Mode; the Windows tools are extracted. |
| The installed Store app offers a GitHub update | It should not. Check Settings → About → Distribution. If it says GitHub, the wrong package was installed. |
| Archive/Delete in the Store app seem to have no effect on Claude Desktop | Check that the installed manifest has `FileSystemWriteVirtualization=disabled` (manifest review). |
| Need the app data folder | Settings → About → Diagnostics. |
