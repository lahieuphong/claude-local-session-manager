# Microsoft Store distribution

The project ships through two **independent** Windows channels built from the
same repository and the same version number:

| Channel | Product name | Artifacts | Updates |
|---|---|---|---|
| **GitHub** | Claude Local Session Manager | NSIS Setup `.exe`, Portable `.exe`, `latest.yml`, `.blockmap`, `SHA256SUMS.txt` | electron-updater + GitHub Releases (Setup); manual (Portable) |
| **Microsoft Store** (this document) | **LHP Local Session Manager** | `.appx` package for a manual Partner Center upload | Managed by the Microsoft Store |

Nothing in this document publishes anything automatically. The Store package is
built locally (or by the manual `store-build` workflow) and uploaded by you in
Partner Center. Certification is decided by Microsoft and is **not guaranteed**.

---

## 1. How the Store edition differs

- **Its own product name.** Store certification refused a product name that
  contains the title of another product (policy 10.1.1). The Store edition is
  therefore called **LHP Local Session Manager** everywhere a customer sees a
  name: package display name, executable, window title, sidebar, About page,
  dialogs, exports and reports. The name comes from `STORE_APP_NAME` in
  `src/shared/appIdentity.ts` and `displayName` in `store/identity.json`
  (`yarn store:check` and a test keep them equal). GitHub Setup and Portable
  keep their name. The package identity (§4) is separate and never changes.
- **Package format: AppX.** The project uses electron-builder **26.15.3**, whose
  stable Store target is `appx` (the `msix` target exists only in the v27 beta
  line; the project is deliberately not upgraded to a beta for it). Partner
  Center accepts `.appx` packages.
- **Full-trust desktop app, one capability.** The package runs the normal
  Electron app with `EntryPoint="Windows.FullTrustApplication"` and the
  `runFullTrust` restricted capability, so it can read `%USERPROFILE%\.claude`,
  Claude Desktop's metadata and your project folder names. **No other
  capability is requested.** Minimum Windows version: 10.0.19041 (Windows 10
  2004).
- **Claude Desktop's AppData files are read-only.** Certification denied
  `unvirtualizedResources` (policy 10.6.3), so the package uses electron-builder's
  default manifest and Windows' default virtualization: files a packaged app
  newly creates under `AppData` go to a private per-package location. Claude
  Desktop keeps its session metadata under `AppData`. **The Microsoft Store
  edition does not modify Claude Desktop's AppData files.** It may still write
  its own application data, such as settings and manager state, inside the
  app's own user-data location. See the feature matrix below and
  [`store/certification-notes.md`](../store/certification-notes.md).
- **Updates come from the Store.** The packaged app is marked
  `distributionChannel: "store"`. In that channel the GitHub updater
  (electron-updater) is never loaded, never checks GitHub at startup and can
  never run the GitHub Setup over the package; it is not even included in the
  Store package. Settings → Updates shows *"Updates are managed by Microsoft
  Store"* with an **Open Microsoft Store** button (official
  `ms-windows-store://downloadsandupdates` URI). A **View in Microsoft Store**
  button appears only when a real Store ID is configured (§4).
- **Safe Mode is unchanged.** Every launch starts in SAFE MODE. Real Delete
  Armed is never saved. Delete plans, hashing, expiry, path validation,
  workspace protection, link rejection, the process guard and the typed
  `DELETE` confirmation are identical in both channels.
- **Not signed by us.** Store submissions do not need your own code-signing
  certificate: Microsoft signs the package after certification. No certificate
  or private key is used, generated or committed.

### Feature matrix

| Feature | GitHub Setup | GitHub Portable | Microsoft Store |
|---|---|---|---|
| Session scanning, browsing, search, grouping | Yes | Yes | Yes |
| Session details and storage overview | Yes | Yes | Yes |
| Export (JSONL, JSON, Markdown) | Yes | Yes | Yes (not into `AppData`) |
| Open project folder | Yes | Yes | Yes |
| Hide / Show in manager | Yes | Yes | Yes |
| Permanent delete of transcript-only sessions (`~\.claude`) | Yes | Yes | Yes |
| Archive / Restore (Claude Desktop) | Yes | Yes | **No** (blocked) |
| Permanent delete of sessions with Claude Desktop metadata | Yes | Yes | **No** (blocked as a whole) |
| Safe Mode on every launch | Yes | Yes | Yes |
| Languages (English, Tiếng Việt, 简体中文) | Yes | Yes | Yes |
| GitHub updater (electron-updater) | Yes | Notify only | **No** (not included) |
| Store-managed updates | No | No | **Yes** |
| Install location | `%LOCALAPPDATA%\Programs\…` | wherever you run it | Windows app package |

How the Store edition blocks (code: `src/main/services/packagingPolicy.ts`,
tests: `tests/storeEdition.test.ts`):

- A delete plan is built per session. If any Claude file in the plan is inside
  Claude Desktop's AppData storage (the metadata file, the archive index, a new
  `deleted_<id>` marker) or anywhere else under the user's `AppData`, the whole
  session is refused. Nothing of it is deleted, so there is never a partial
  delete. The app's own records (its hidden list and scan cache) are not Claude
  files and do not count.
- The check runs when the plan is created, again when it is executed (before
  any file is touched) and once more right before each file operation.
- Archive and Restore are refused before the metadata file is read.
- The UI hides Archive / Restore and disables Delete for these sessions and
  says why: *not available in the Microsoft Store edition because Windows Store
  packaging isolates certain AppData writes*.

### Where data lives

| | GitHub Setup / Portable | Microsoft Store |
|---|---|---|
| App data (`app.getPath("userData")`): settings, language, hidden list, scan cache, logs | `%APPDATA%\Claude Local Session Manager` | `%APPDATA%\LHP Local Session Manager`, which Windows keeps in the app's private package storage |
| Claude data (`~\.claude`, Claude Desktop metadata) | read from the real locations | read from the real locations |

- The two editions do not share settings.
- Uninstalling the Store app removes its own data. Uninstalling the Setup build
  keeps `%APPDATA%\Claude Local Session Manager`.
- Neither channel ever deletes or migrates `~\.claude`, Claude transcripts,
  Claude Desktop metadata or your source projects on install, update or
  uninstall.
- Settings → About → Diagnostics shows the distribution, user home, Claude
  transcript root, Claude metadata roots and the app data folder for
  troubleshooting. These paths are only displayed locally.

---

**This product (configured in `store/identity.json`):** Identity Name `LaHieuPhong.ClaudeLocalSessionManager`,
Publisher `CN=CA5468D0-A735-4CDB-9F0A-A0CDD47D1EA5`, Publisher display name
`La Hieu Phong`, Store ID `9N5XNN8H1TSZ`, display name `LHP Local Session Manager`.
The Identity Name and Publisher were issued by Partner Center when the product
was created. They are internal and cannot be changed; the display name can.

## 2. Prerequisites

- A Microsoft **Partner Center** developer account enrolled in the Windows &
  Xbox (apps and games) program.
- Windows 10 2004+ or Windows 11 with Node.js 24 and Yarn 1.x (same as the
  GitHub build). No Windows SDK is needed: electron-builder downloads the
  `makeappx`/`makepri` tools.
- A public **privacy policy URL** that opens as a normal web page (§2.1).

### 2.1 Privacy policy page (GitHub Pages)

Partner Center needs a URL that resolves to a working web page (policy 10.5.1).
The policy text is [`store/privacy.md`](../store/privacy.md). `yarn store:privacy`
turns it into [`docs/privacy/index.html`](privacy/index.html) (plus a small
landing page and `.nojekyll`). A test fails when the pages are out of date.

Enable GitHub Pages once (it cannot be switched on from the repository files):

1. Push `main` (the `docs/` folder must be on GitHub).
2. On GitHub open the repository → **Settings** → **Pages**.
3. Under **Build and deployment** → **Source**, choose **Deploy from a branch**.
4. **Branch:** `main`, folder **`/docs`** → **Save**.
5. Wait for the *pages build and deployment* run in **Actions** to finish
   (about a minute).
6. Open <https://lahieuphong.github.io/claude-local-session-manager/privacy/>
   in a private browser window (not signed in to GitHub). It must show the
   policy for *LHP Local Session Manager*.

GitHub Pages on a free account needs a **public** repository. Use the URL above
as the **Privacy policy URL** in Partner Center only after step 6 works.

## 3. Reserve the product name

The Store-facing name is **LHP Local Session Manager**. For the existing
product (first submission failed certification), add it as a second reserved
name:

1. Sign in to [Partner Center](https://partner.microsoft.com/dashboard) →
   **Apps and games** → open the product.
2. **Product management** → **Manage app names**.
3. Under **Reserve more names**, enter `LHP Local Session Manager` → **Check
   availability** → **Reserve product name**.
4. After the new package is uploaded (§7), select the new name as **Product
   name** in each Store listing language. You may then delete the old name on
   the same page.

If the name is not available, reserve another one and put it in **both**
`displayName` (`store/identity.json`) and `STORE_APP_NAME`
(`src/shared/appIdentity.ts`). It must not contain another company's product
name.

## 4. Copy the package identity

1. In Partner Center open the product → **Product management** →
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
IDENTITY` and the list of fields to copy. A display name that differs from the
name the app shows, or that contains another product's name, also stops the
build. The Store ID only enables the optional **View in Microsoft Store**
button.

## 5. Build the package

```powershell
yarn store:check      # identity, name, version mapping and assets — no build
yarn dist:store       # → dist\store\LHP-Local-Session-Manager-X.Y.Z.0-x64.appx
```

`dist\store\` then contains:

| File | Purpose |
|---|---|
| `LHP-Local-Session-Manager-X.Y.Z.0-x64.appx` | the package to upload |
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
only. **Never upload it.**

On GitHub: **Actions → Microsoft Store package (manual) → Run workflow** builds
the same files after test/typecheck/build and keeps them as a workflow artifact
(`microsoft-store-package-<commit>`). It never creates a release or submits
anything, and needs no secrets.

### Version mapping

`package.json` stays the only version source. The Store package version is
derived as **`X.Y.Z` → `X.Y.Z.0`** (e.g. `1.2.4` → `1.2.4.0`). The fourth part
is reserved by the Store and stays `0`; each part must be ≤ 65535 and the major
version ≥ 1. Every new Store submission must have a higher version than the
previous one, so bump `package.json` (`yarn version:patch`) before building a
new Store package.

## 6. Validate the package

1. Read `dist\store\manifest-review.txt`: every check must say PASS — identity
   name, publisher, publisher display name, display name, version, `x64`,
   `Windows.Desktop`, full-trust entry point, `runFullTrust` present and **no
   other capability**, no `unvirtualizedResources`, no
   `FileSystemWriteVirtualization` override, no third-party product name in the
   Store-facing names, languages `en-US, vi-VN, zh-CN`, all visual assets, no
   `app-update.yml`, the `store` channel marker, the Store product name in the
   app metadata and no electron-updater in the package.
2. Optional local install test (requires **Developer Mode**; Settings → System →
   For developers). An unsigned package cannot be installed with a double-click.
   With Developer Mode on you can register the unpacked layout:
   ```powershell
   # makeappx.exe is in %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\…\windows-10\x64
   makeappx.exe unpack /p dist\store\LHP-Local-Session-Manager-X.Y.Z.0-x64.appx /d %TEMP%\lsm-store-layout
   Add-AppxPackage -Register "$env:TEMP\lsm-store-layout\AppxManifest.xml"
   # …test, then remove it:
   Get-AppxPackage *ClaudeLocalSessionManager* | Remove-AppxPackage
   ```
   Then check: the window, sidebar and Settings → About say *LHP Local Session
   Manager*; *Distribution: Microsoft Store*; the session list loads; the
   status strip shows SAFE MODE; a session with Claude Desktop metadata has no
   Archive button and a disabled Delete button with the Store-edition note. Do
   not test deletion on real sessions.
3. Optional: run the Windows App Certification Kit (part of the Windows SDK)
   against the installed app.

## 7. Submit

1. In the product, open the submission (**Update** after a failed
   certification).
2. **Pricing and availability:** markets, visibility, free.
3. **Properties:** category (*Developer tools*), **Privacy policy URL**
   `https://lahieuphong.github.io/claude-local-session-manager/privacy/` (must
   be live, §2.1), support contact, system requirements.
4. **Age ratings:** complete the questionnaire.
5. **Packages:** remove the previous package and upload
   `dist\store\LHP-Local-Session-Manager-X.Y.Z.0-x64.appx`. Partner Center
   checks the identity and the display name against the reserved names here.
   Device families: Windows 10/11 Desktop.
6. **Store listings:** for each language select the product name **LHP Local
   Session Manager**, then use the drafts in [`store/listing/`](../store/listing/)
   and the images in [`store/listing-assets/`](../store/listing-assets/): 4
   screenshots per language, the 300×300 app tile icon and the captions. The
   search terms in the drafts contain no third-party product names (policy
   10.1.3); keep it that way.
7. **Submission options → Restricted capabilities:** only `runFullTrust` is
   listed now. Paste its justification from
   [`store/certification-notes.md`](../store/certification-notes.md).
8. **Notes for certification:** use the text in the same file.
9. **Submit to the Store** and wait for certification.

## 8. Later versions

1. Bump the version (`yarn version:patch|minor|major`). Release on GitHub as
   usual if the GitHub builds should get the same version.
2. `yarn dist:store` (or run the `store-build` workflow on that commit).
3. If the UI changed: `yarn build && yarn store:screenshots`.
4. Partner Center → **Update** submission → **Packages** → upload the new
   `.appx` (version must be higher than the last Store version) → submit.

Store users receive the update from the Store; GitHub Setup users from GitHub
Releases; Portable users download manually.

## 9. Certification history and risks

First submission (package 1.2.3.0) failed four policies. The fixes:

| Policy | Finding | Fix |
|---|---|---|
| 10.1.1 Inaccurate representation | Product name contained the title of another product | Store-facing name **LHP Local Session Manager** (§1, §3) |
| 10.1.3 Search terms | Search terms used third-party product titles | Generic search terms only (`store/listing/`) |
| 10.5.1 Privacy policy | The privacy policy link was not a working web page | Public GitHub Pages page (§2.1) |
| 10.6.3 Capabilities | `unvirtualizedResources` denied | Capability removed; dependent operations blocked in the Store edition (§1) |

Remaining risks:

- **Factual third-party names in the description.** The description still says
  which session files the app works with and carries the "not affiliated"
  disclaimer. If a reviewer objects, shorten those sentences; never put the
  names back into the product name or search terms.
- **Deleting another app's data** — permanent delete removes local transcript
  files. It is always explicit: Safe Mode by default, arming by typing
  `ENABLE DELETE`, an exact reviewed plan, a typed `DELETE`/`DELETE <n>`
  confirmation, one delete per arming, 10-minute expiry.
- **Process detection** runs Windows PowerShell (`Get-CimInstance
  Win32_Process`, read-only, fixed script, hidden window). Reviewers or security
  tools may notice a PowerShell child process.
- **Opening folders/links** uses `shell.openPath` / `showItemInFolder` on paths
  from the scanner, and fixed Microsoft Store URIs only.
- **Self-update** — not present in the Store package.
- **Privacy** — answer the Partner Center privacy questions consistently with
  the published policy.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| `STORE BUILD BLOCKED WAITING FOR PARTNER CENTER IDENTITY` | Copy the values from Product identity (§4). |
| `STORE BUILD BLOCKED: Store-facing name` | `displayName` in `store/identity.json` and `STORE_APP_NAME` in `src/shared/appIdentity.ts` must be the same reserved name, without another product's name. |
| Upload error: the display name is not one of your reserved names | Reserve the name first (§3). |
| Upload error about package identity / publisher | The values must match Product identity character for character (including spaces in `CN=…`). |
| Upload error about version | The version must be higher than the previous Store version and end with `.0`. Bump `package.json`. |
| `Cannot create symbolic link … darwin … libcrypto.dylib` while building | Harmless: electron-builder's tool archive contains macOS links that Windows cannot create without Developer Mode; the Windows tools are extracted. |
| The installed Store app offers a GitHub update | It should not. Check Settings → About → Distribution. If it says GitHub, the wrong package was installed. |
| Archive / Restore / Delete are unavailable for a session in the Store app | Expected for sessions with Claude Desktop metadata (§1). |
| Privacy policy URL returns 404 | GitHub Pages is not enabled or still building (§2.1). |
| Need the app data folder | Settings → About → Diagnostics. |
