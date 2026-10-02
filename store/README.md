# Microsoft Store materials

Everything needed for the Microsoft Store channel that is not code.
The full procedure is in [`docs/MICROSOFT_STORE.md`](../docs/MICROSOFT_STORE.md).

| Path | What it is |
|---|---|
| [`identity.json`](identity.json) | Package identity copied from Partner Center → Product identity (empty until the name is reserved). Not secret. |
| [`AppxManifest.template.xml`](AppxManifest.template.xml) | Manifest template used by `yarn dist:store` (full trust, no AppData write virtualization). |
| [`listing/`](listing/) | Draft Store listing text: `en-US.md`, `vi-VN.md`, `zh-CN.md`. |
| [`screenshots/README.md`](screenshots/README.md) | Which screenshots to take and how (no real session data). |
| [`privacy.md`](privacy.md) | Privacy policy text to publish and link from Partner Center. |
| [`certification-notes.md`](certification-notes.md) | Restricted-capability justifications (runFullTrust, unvirtualizedResources), notes for certification, and the audit behind them. |

Visual assets (StoreLogo, Square44x44, Square150x150, Wide310x150, Small/Large
tiles, unplated taskbar icons) are generated into `build/appx/` by `yarn icon`
from `src/shared/appMark.json` — the app's own neutral mark, never Anthropic's
Claude logo.

The listing must always say that this is an **unofficial local utility, not
affiliated with Anthropic**.
