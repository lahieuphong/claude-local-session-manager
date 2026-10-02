# Microsoft Store listing assets

Images for Partner Center → *Claude Local Session Manager* → Submission →
**Store listings**. They are uploaded by hand and are not part of the app package.
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
    01-sessions.png        session browser
    02-session-details.png session details
    03-delete-plan.png     delete plan in Safe Mode (dry run)
    04-settings.png        Safe Mode, Microsoft Store updates, version
```

All screenshots are PNG, exactly 1920 × 1080, captured from the real app with
its UI in that language. `yarn store:validate-assets` checks the files.

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
yarn build
yarn store:screenshots          # all languages, or: --locale vi-VN
yarn store:validate-assets
```

`store:screenshots` starts the unpackaged app in **Store screenshot mode**
(`CLAUDE_SESSION_MANAGER_SCREENSHOT_MODE=true`, see
[`src/main/screenshot/`](../../src/main/screenshot/)). In this mode:

- the session list, details and delete plan come from static demo data
  (user `C:\Users\Demo`, projects `C:\Projects\DemoWebApp`, `SampleAPI`,
  `DesignSystem`, session IDs `a1b2c3d4-0000-4000-8000-0000000000NN`). The
  app's real session builder and delete-plan rules turn this data into what
  the UI shows;
- nothing is read from `~\.claude`, Claude Desktop's metadata or running
  processes. No settings, cache or log file is written. Every action that
  would change, delete, export or open something is refused. Deletion stays
  in Safe Mode and cannot be armed;
- a packaged build ignores the variable (tests in
  `tests/screenshotMode.test.ts`).

The script renders the page at 1920 × 1080 with a device scale factor of 1, so
the output size does not depend on the monitor or Windows scaling. It checks
the size of every image. Before saving each image, it stops if any on-screen
text contains this PC's user name, home folder or checkout path, or a
session-like ID outside the demo series. The images show only the app
content: no title bar, taskbar, cursor, tooltip, DevTools or added marketing
text.

Microsoft notes that text overlays may cover the bottom third of a
screenshot. The key content (SAFE MODE strip, list headers, the delete plan's
Will delete / Will not delete) sits in the upper two thirds.

The four screenshots cannot also show the language selector at the top of
Settings: Settings is taller than 1080 px, so `04-settings.png` shows Deletion
safety, Updates and About. The localized screenshots show the three
languages instead.

## App tile icon

`common/app-tile-300x300.png` is generated by `yarn icon` from
`src/shared/appMark.json`, the same source as the window, installer and AppX
icons. It is the app's own mark (stacked session cards, 272 px, centered on a
transparent background, no text). It is not Anthropic's or Claude's logo and
not a Microsoft logo. `tests/appIcon.test.ts` fails if it is out of date.

## Branding

The name contains "Claude" only to describe what the utility works with. The
assets use no Anthropic or Microsoft logos and no third-party artwork. The app
shows "Unofficial local utility · Not affiliated with Anthropic" in Settings →
About, which is visible in `04-settings.png`. The listing text says the same.
