# Microsoft Store materials

Everything needed for the Microsoft Store channel that is not code.
The full procedure is in [`docs/MICROSOFT_STORE.md`](../docs/MICROSOFT_STORE.md).

| Path | What it is |
|---|---|
| [`identity.json`](identity.json) | Package identity copied from Partner Center → Product identity, plus the Store-facing display name (**LHP Local Session Manager**). Not secret. |
| [`listing/`](listing/) | Draft Store listing text for the Store edition: `en-US.md`, `vi-VN.md`, `zh-CN.md` (no third-party product names in the name or search terms). |
| [`listing-assets/`](listing-assets/) | Store listing images to upload: 4 screenshots per language (1920×1080, demo data only), the 300×300 app tile icon, captions, and a field-by-field upload checklist ([`README.md`](listing-assets/README.md)). |
| [`privacy.md`](privacy.md) | Privacy policy source. `yarn store:privacy` builds the public page `docs/privacy/index.html` (GitHub Pages): <https://lahieuphong.github.io/claude-local-session-manager/privacy/>. |
| [`certification-notes.md`](certification-notes.md) | The `runFullTrust` justification, notes for certification, and the Store-edition limitations (no changes to Claude Desktop's AppData files). |

Visual assets (StoreLogo, Square44x44, Square150x150, Wide310x150, Small/Large
tiles, unplated taskbar icons) are generated into `build/appx/` by `yarn icon`
from `src/shared/appMark.json` — the app's own neutral mark, never Anthropic's
Claude logo. The same command writes the listing's 300×300 app tile icon to
`listing-assets/common/`. Screenshots come from `yarn store:screenshots` (Store
screenshot mode, static demo data) and are checked by `yarn store:validate-assets`.

The package uses electron-builder's default AppX manifest with one capability,
`runFullTrust`. There is no manifest template in this folder any more.

The listing must always say that this is an **unofficial local utility, not
affiliated with Anthropic**. The product name and the search terms must not
contain another company's product name.
