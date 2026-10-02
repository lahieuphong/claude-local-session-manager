# Microsoft Store materials

Everything needed for the Microsoft Store channel that is not code.
The full procedure is in [`docs/MICROSOFT_STORE.md`](../docs/MICROSOFT_STORE.md).

| Path | What it is |
|---|---|
| [`identity.json`](identity.json) | Package identity copied from Partner Center → Product identity (empty until the name is reserved). Not secret. |
| [`AppxManifest.template.xml`](AppxManifest.template.xml) | Manifest template used by `yarn dist:store` (full trust, no AppData write virtualization). |
| [`listing/`](listing/) | Draft Store listing text: `en-US.md`, `vi-VN.md`, `zh-CN.md`. |
| [`listing-assets/`](listing-assets/) | Store listing images to upload: 4 screenshots per language (1920×1080, demo data only), the 300×300 app tile icon, captions, and a field-by-field upload checklist ([`README.md`](listing-assets/README.md)). |
| [`privacy.md`](privacy.md) | Privacy policy text to publish and link from Partner Center. |
| [`certification-notes.md`](certification-notes.md) | Restricted-capability justifications (runFullTrust, unvirtualizedResources), notes for certification, and the audit behind them. |

Visual assets (StoreLogo, Square44x44, Square150x150, Wide310x150, Small/Large
tiles, unplated taskbar icons) are generated into `build/appx/` by `yarn icon`
from `src/shared/appMark.json` — the app's own neutral mark, never Anthropic's
Claude logo. The same command writes the listing's 300×300 app tile icon to
`listing-assets/common/`. Screenshots come from `yarn store:screenshots` (Store
screenshot mode, static demo data) and are checked by `yarn store:validate-assets`.

The listing must always say that this is an **unofficial local utility, not
affiliated with Anthropic**.
