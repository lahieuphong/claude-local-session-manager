# Store certification notes — restricted capabilities

The Store package declares exactly two restricted capabilities. Both are
required; nothing else is requested (no broadFileSystemAccess, no
packageManagement, no registry virtualization changes).

## Text to paste in Partner Center

**Submission → Submission options → Restricted capabilities.**

### `runFullTrust`

> Claude Local Session Manager is a Win32 desktop application (Electron) packaged
> with the Desktop Bridge entry point Windows.FullTrustApplication, so it needs
> runFullTrust to run as a normal desktop process. It reads Claude Code session
> files in the user's profile (%USERPROFILE%\.claude) and Claude Desktop's local
> session metadata, checks read-only whether Claude processes are running so it
> never touches a session in use, exports sessions to a folder the user picks, and
> opens session folders in File Explorer. These local file and process operations
> are not possible from an AppContainer. The app has no server, collects no
> telemetry, and always starts in a read-only Safe Mode.

### `unvirtualizedResources`

> The app manages Claude Desktop's local session data, which Claude Desktop stores
> under the user's AppData (%APPDATA%\Claude\claude-code-sessions, or
> %LOCALAPPDATA%\Packages\<Claude package>\LocalCache\Roaming\Claude\claude-code-sessions).
> When the user archives or restores a session, the app updates Claude Desktop's
> metadata file and archive index with a crash-safe write (new temporary file in
> the same folder, then rename). When the user permanently deletes a session after
> explicit confirmation, the app also creates Claude Desktop's own deletion marker
> files (deleted_<id>). With AppData write virtualization, newly created files are
> redirected into this package's private storage, so these changes would be seen
> only by this app and never by Claude Desktop: the user would get a success
> message while Claude Desktop stays unchanged and could re-import a "deleted"
> session. We therefore set FileSystemWriteVirtualization=disabled (registry
> virtualization is unchanged). Writes are limited to the exact files listed in a
> plan the user reviews; deletion must first be armed by typing ENABLE DELETE and
> then confirmed by typing DELETE, and the app writes nowhere else in AppData
> except its own settings folder.

### Notes for certification (optional field)

> Unofficial local utility, not affiliated with Anthropic. It shows the Claude Code
> / Claude Desktop sessions stored on this PC; without Claude data installed the
> list is empty (that is expected). The app starts in Safe Mode (dry run): nothing
> can be modified until deletion is armed in Settings → Deletion safety by typing
> ENABLE DELETE, which lasts for one delete or 10 minutes. Every delete shows the
> exact files that will and will not be removed and requires a typed confirmation.
> No account, sign-in or network service is required. Updates come only from the
> Microsoft Store.

## Audit (October 2026, package 1.2.3.0)

### Why `runFullTrust` is present

- electron-builder's AppX target always adds it (`AppxTarget.getCapabilities()`
  adds `runFullTrust` unconditionally), because every desktop app packaged with
  `EntryPoint="Windows.FullTrustApplication"` needs it.
- The app is an Electron (Win32) process. Without full trust it would run in an
  AppContainer, where it could not read `%USERPROFILE%\.claude`, Claude
  Desktop's metadata, other apps' package data or the user's project folders,
  start the read-only PowerShell process query, or reveal folders in Explorer.
- It is required for the app to work at all.

### Why `unvirtualizedResources` is present

- Added deliberately in `scripts/store-config.mjs` together with
  `desktop6:FileSystemWriteVirtualization=disabled` in
  `store/AppxManifest.template.xml`. Microsoft requires this restricted
  capability for that property (and for Windows 11 flexible virtualization).

### Is it technically necessary? — Yes

Microsoft's documented behavior for packaged desktop apps on Windows 10 1903+
([how packaged desktop apps run](https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-behind-the-scenes),
[flexible virtualization](https://learn.microsoft.com/windows/msix/desktop/flexible-virtualization)):

| Operation by the packaged app | With AppData write virtualization (default) |
|---|---|
| Read files anywhere (incl. AppData) | Works (private copy first, then the real file) |
| Create a **new** file under AppData | **Redirected to a private per-package location**, visible only to this app |
| Modify an existing file under AppData in place | Goes to the real file |
| Delete a file under AppData | Allowed |
| Anything outside AppData, e.g. `%USERPROFILE%\.claude` | Real location, never virtualized |

What the app writes, and the effect without `unvirtualizedResources`:

| App operation | Where | Without the capability |
|---|---|---|
| Archive / Restore: rewrite `local_*.json` (temp file + rename, `src/main/util/atomicWrite.ts`) | Claude Desktop metadata, AppData | **Broken**: the temp file is a new file → private copy; Claude Desktop keeps the old file while the app shows success |
| Archive index `archived-sessions.idx` update (same write) | AppData | **Broken** (same reason) |
| Permanent delete: create `deleted_<id>` tombstones | AppData | **Broken**: Claude Desktop never sees the markers and may re-import the session |
| Permanent delete: remove metadata file | AppData | Works |
| Delete transcripts, session folders, file-history, session-env | `%USERPROFILE%\.claude` | Works (outside AppData) |
| Scanning / reading everything | anywhere | Works |
| The app's own settings, hidden list, cache, logs | `%APPDATA%\Claude Local Session Manager` | Works, but would be private to the Store install and removed on uninstall |

So the capability is needed for Claude Desktop session management to be
correct; removing it would make archive/restore and delete silently diverge
from what Claude Desktop sees. It is kept.

### Alternatives considered (not adopted)

- **Remove the capability** — breaks the operations above. Rejected.
- **Rewrite files in place instead of temp + rename** — would only fix
  modifications, loses crash safety (a crash could leave Claude's metadata
  truncated), and tombstones are inherently new files. Rejected.
- **Windows 11 flexible virtualization** (`virtualization:ExcludedDirectories`
  for only Claude's folders) — still requires `unvirtualizedResources`, only works
  on Windows 11, and Claude Desktop's package folder name varies by install.
  Could narrow the scope later; it does not remove the capability.
- **Store "Win32 app (EXE/MSI)" submission** — no package virtualization, but
  requires a code-signed installer. Not chosen.
