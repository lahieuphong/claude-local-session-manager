# Microsoft Store listing assets

Images for Partner Center → the product (*LHP Local Session Manager*) →
Submission → **Store listings**. They are uploaded by hand and are not part of the app package.
The listing text (description, features, search terms) is in
[`../listing/`](../listing/); screenshot captions are in
[`captions.md`](captions.md).

```
store/listing-assets/
  README.md                this file
  captions.md              captions for every screenshot, per language
  common/
    app-tile-300x300.png   1:1 App tile icon (all languages)
  en-US/  vi-VN/  zh-CN/
    01-sessions.png        session overview: list, search, filters, projects
    02-session-details.png session details: project, IDs, model, storage, files
    03-delete-plan.png     safe deletion preview of a transcript-only session (dry run)
    04-settings.png        settings and safety: Safe Mode, Store updates, version, limits
```

All screenshots are PNG, exactly 1920 × 1080, captured from the **Microsoft
Store package's own binaries** with the UI in that language. The product name
is LHP Local Session Manager, and only features of that edition appear (every
demo session is transcript-only; nothing is archived, restored or deleted).
`yarn store:validate-assets` checks the files.

## Microsoft requirements (checked 2 October 2026)

Sources:
[App screenshots, images, and trailers for MSIX app](https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/screenshots-and-images)
(updated 24 Aug 2026) and
[Add and edit Store listing info for MSIX app](https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/add-and-edit-store-listing-info)
(updated 24 Aug 2026).

- **Screenshots:** at least one is required to submit; Microsoft suggests at
  least four per supported device family. Desktop allows up to 10. PNG,
  at most 50 MB, Desktop size 1366 × 768 or larger (up to 3840 × 2160).
  Captions are optional, up to 200 characters. Images and captions are
  uploaded separately for each listing language.
- **1:1 App tile icon (300 × 300):** Microsoft strongly recommends it; if you
  upload it, the Store uses it instead of the logo in the package.
- **2:3 Poster art and 1:1 Box art:** used for games; Microsoft states that
  they do not apply to apps. Required only for Xbox listings.
- **16:9 Super hero art:** recommended for all products. Required only for
  games that have trailers. It must not contain text and should not show the
  app's UI.
- **Trailers:** optional.
- **Xbox images, Holographic image:** only for products published to Xbox or
  HoloLens.
- **Minimum to complete the Store listing step:** a description and at least
  one screenshot.

This product is a Windows 10/11 desktop app. It is not a game and does not
target Xbox or HoloLens.

## Partner Center fields

| Partner Center field | For this app | File to upload | Per language? | Notes |
|---|---|---|---|---|
| Screenshots → Desktop | **Required** (≥ 1) | `<locale>/01-sessions.png` … `04-settings.png` | Yes | Upload all 4 in order 01 → 04, in each language. Paste the captions from `captions.md`. |
| Screenshots → Xbox / Holographic / other device families | Not applicable | — | — | The app does not support these devices; Microsoft asks not to add them. |
| Store logos → 1:1 App tile icon (300 × 300) | **Recommended** | `common/app-tile-300x300.png` | Yes (same file each time) | Takes priority over the package logo on Store pages. |
| Store logos → 2:3 Poster art (720 × 1080) | Not applicable | — | — | Used for games only ("does not apply to apps"). Leave blank. |
| Store logos → 1:1 Box art (1080 × 1080) | Not applicable | — | — | Used for games only ("does not apply to apps"). Leave blank. |
| Store logos → "only use images I upload here" | Optional | — | — | Leave unchecked, so the Store can still use the package logos where no upload exists. |
| Trailers (video, thumbnail, captions, audio description) | Optional | — | — | Intentionally omitted for the first release. |
| Windows 10/11 and Xbox image → 16:9 Super hero art | Optional (recommended) | — | — | Not required for a non-game app without trailers. It needs original artwork with no text and no app UI, which this pack does not invent. Leave blank; it can be added later to be considered for featured placements. |
| Xbox images (branded key art, titled hero art, featured promotional square art) | Not applicable | — | — | Not published to Xbox. Leave blank. |
| Holographic image (2:1) | Not applicable | — | — | Not a HoloLens app. Leave blank. |

## Upload checklist

Repeat for each listing language: **English (United States)**, **Vietnamese
(Vietnam)** and **Chinese (Simplified, China)**. Use the folder of that language:
`en-US`, `vi-VN` or `zh-CN`.

1. Partner Center → the app → open the submission → **Store listings** → select
   the language.
2. **Screenshots → Desktop → Add images:** upload `01-sessions.png`,
   `02-session-details.png`, `03-delete-plan.png`, `04-settings.png` from that
   language's folder. Keep the order 01 → 04. Paste each caption from
   `captions.md` (same language).
3. **Store logos → 1:1 App tile icon (300 × 300 px):** upload
   `common/app-tile-300x300.png`. Leave 2:3 Poster art and 1:1 Box art blank.
   Leave "only use images I upload here" unchecked.
4. **Trailers:** leave blank.
5. **Windows 10 or Windows 11 and Xbox image (16:9 Super hero art):** leave blank.
6. **Xbox images:** leave blank.
7. **Holographic image:** leave blank.
8. Save, then go to the next language.

## How the screenshots are made

```powershell
yarn dist:store                 # once: the package and dist\store\win-unpacked
yarn store:screenshots          # all languages, or: --locale vi-VN
                                # add --software-rendering if the graphics card is busy
yarn store:validate-assets
```

`store:screenshots` does not build or imitate anything. It runs the packaged
Store app and takes pictures of its window content:

- **The build.** `dist\store\win-unpacked\LHP Local Session Manager.exe`, the
  layout that electron-builder packed into `dist\store\*.appx` as its `app\`
  folder. Before it starts, the script compares every file of that folder with
  the entries inside the `.appx` (size and CRC-32; nothing may be missing or
  extra), checks the manifest copy the same way and prints the package's
  SHA-256, so the screenshots can be tied to the uploaded package. The app
  must report itself as packaged, distribution *Microsoft Store*, with the
  package's version. If `win-unpacked` is gone, do not rebuild a package that
  was already submitted: unpack it (`makeappx unpack /p <package> /d <folder>`)
  and use its `app\` folder as `dist\store\win-unpacked`.
- **The data.** `scripts/store-demo-data.mjs` writes 12 synthetic Claude Code
  sessions as real files (transcripts, session folders, file history) into a
  throw-away user folder, by default `<drive>:\Users\Demo`. Projects are
  `C:\Projects\DemoWebApp`, `SampleAPI` and `DesignSystem`; session IDs are
  `a1b2c3d4-0000-4000-8000-0000000000NN`. All of them are transcript-only
  sessions, the kind the Store edition supports in full. The app's profile
  folders (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`) point at that folder, so
  the real scanner reads these files and no real Claude data. The folder is
  removed afterwards.
- **One run of the app.** The app is started once and closed by closing its
  window. The other languages are chosen in *Settings → Language*, as a user
  does. Only Chromium switches are passed on the command line: a DevTools port
  to drive the window, 100% scale and, with `--software-rendering`,
  `--disable-gpu` (the window is drawn by the CPU; its content is the same).
- **What is clicked.** A session row, the group-by menu, *Delete permanently*
  (which opens the plan preview), *Cancel*, *Settings* and the language
  options. The typed confirmation enables *Run dry-run validation*, which is
  not clicked. Nothing is deleted, exported or changed; the app stays in Safe
  Mode.
- **The delete preview is the app's own plan.** The app's delete service
  builds it from the files on disk. The script checks that every Claude path
  the plan would delete exists, and still exists after *Cancel*. After the app
  has closed, the whole synthetic profile is compared with a hash taken before
  the app started: not one file may differ.
- **Claude Desktop must be closed** on the PC. If it is running, the app
  (correctly) disables deletion and shows a warning, and the script stops
  instead of capturing that state.
- **Checks before each image is saved.** No on-screen text may contain this
  PC's user name, home folder or checkout path, a session ID outside the demo
  series, or the GitHub product name; no label or button may be clipped; the
  image must be exactly 1920 × 1080.

The images show the window's content area at 1920 × 1080 and 100% scale: no
title bar, taskbar, cursor, tooltip, DevTools, and no added text or artwork.
`dist\store\screenshot-capture-report.json` records the package hash, the
command-line switches, the app's own version and state, the delete-preview
checks, the profile hash and the hash of every image.

The app's development-only screenshot mode (`src/main/screenshot/`) is not
used for these assets.

Microsoft notes that text overlays may cover the bottom third of a
screenshot. The key content (SAFE MODE strip, list headers, the delete plan's
Will delete / Will not delete) sits in the upper two thirds.

`04-settings.png` is one scroll position of Settings, starting at Deletion
safety. Settings is taller than 1080 px, so the language selector at its top
is not in the picture; the localized screenshots show the three languages
instead.

## App tile icon

`common/app-tile-300x300.png` is generated by `yarn icon` from
`src/shared/appMark.json`, the same source as the window, installer and AppX
icons. It is the app's own mark (stacked session cards, 272 px, centered on a
transparent background, no text). It is not Anthropic's or Claude's logo and
not a Microsoft logo. `tests/appIcon.test.ts` fails if it is out of date.

## Branding

The Store-facing product name is **LHP Local Session Manager**; it contains no
other company's product name. Names such as Claude Code or Claude Desktop appear
in the screenshots only where the app states what it reads or checks. The
assets use no Anthropic or Microsoft logos and no third-party artwork. The app
shows "Unofficial local utility · Not affiliated with Anthropic" in Settings →
About, which is visible in `04-settings.png`. The listing text says the same.
