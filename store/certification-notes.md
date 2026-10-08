# Store certification notes

For the Microsoft Store edition, **LHP Local Session Manager** (package
1.2.4.0 and later). The package declares exactly one restricted capability,
`runFullTrust`. Nothing else is requested: no `unvirtualizedResources`, no
`broadFileSystemAccess`, no `packageManagement`, and no change to file system
or registry virtualization.

## Text to paste in Partner Center

**Submission → Submission options → Restricted capabilities.**

### `runFullTrust`

> LHP Local Session Manager is a Win32 desktop application (Electron) packaged
> with the Desktop Bridge entry point Windows.FullTrustApplication, so it needs
> runFullTrust to run as a normal desktop process. It reads session files in
> the user's profile (%USERPROFILE%\.claude) and Claude Desktop's local session
> metadata, checks read-only whether related processes are running so it never
> touches a session in use, exports sessions to a folder the user picks, and
> opens the project folder in File Explorer. These local file and process
> operations are not possible from an AppContainer. The app has no server,
> collects no telemetry, and always starts in a read-only Safe Mode.

### Notes for certification (optional field)

> Unofficial local utility, not affiliated with Anthropic. It lists the
> AI coding session files stored on this PC (written by Claude Code and Claude
> Desktop). Without such files installed the list is empty; that is expected.
>
> This package no longer requests unvirtualizedResources. The Store edition does
> not create, replace, rename, or delete files inside Claude Desktop's AppData
> storage. Unsupported Claude Desktop metadata mutations are blocked before any
> filesystem change occurs.
> - Sessions that have Claude Desktop metadata are read-only: they can be viewed
>   and exported. Archive, Restore and Delete are not offered for them.
> - Sessions that only have a transcript under %USERPROFILE%\.claude (outside
>   AppData) can be hidden in the app or permanently deleted.
> - The app writes its own application data (settings, its hidden-sessions list,
>   a scan cache and logs) only in its own user-data location.
>
> The app starts in Safe Mode (dry run): nothing can be modified until deletion
> is armed in Settings → Deletion safety by typing ENABLE DELETE, which lasts
> for one delete or 10 minutes. Every delete shows the exact files that will and
> will not be removed and requires a typed confirmation. No account, sign-in or
> network service is required. Updates come only from the Microsoft Store.

## Store-edition limitations

Store certification denied `unvirtualizedResources`, so the Store package keeps
Windows' default AppData write virtualization. For a packaged full-trust app,
Windows redirects files that the app newly creates under the user's `AppData`
to a private per-package location
([how packaged desktop apps run](https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)).
Claude Desktop keeps its session metadata under `AppData`, so a redirected write
would look successful to this app while Claude Desktop never sees it.

The Store edition does not create, replace, rename, or delete files inside
Claude Desktop's AppData storage. Unsupported Claude Desktop metadata mutations
are blocked before any filesystem change occurs.

The Store edition may still write its own application data, such as settings
and manager state, inside the app's own user-data location.

The rule is implemented in `src/main/services/packagingPolicy.ts` and enforced
in the main process:

| Operation | Store edition | Why |
|---|---|---|
| Scan, browse, search, group, inspect | Available | Read only |
| Storage overview | Available | Read only |
| Export | Available | Writes a copy to a folder the user picks (not into `AppData`) |
| Open project folder | Available | Opens File Explorer |
| Hide / Show in manager | Available | Changes only this app's own list |
| Delete a transcript-only session (`%USERPROFILE%\.claude`) | Available | All files are outside `AppData`; every existing safety guard applies |
| Archive / Restore a Claude Desktop session | **Blocked** | Needs a temp file + rename of the metadata file and the archive index under `AppData` |
| Delete a session that has Claude Desktop metadata | **Blocked** | Needs changes under `AppData`: the metadata file, the archive index and new `deleted_<id>` marker files |
| Export into `AppData` | **Blocked** | The file would be redirected to a location the user cannot find |

How the block works:

- A delete plan is built per session. If any Claude file in the plan is inside
  Claude Desktop's AppData storage, or anywhere else under the user's `AppData`,
  the whole session is refused with "not available in the Microsoft Store
  edition". Nothing of that session is deleted: there is no partial delete. The
  app's own records (its hidden list and scan cache) are not Claude files and
  do not count.
- The same check runs again when the plan is executed, before any file is
  touched, and once more immediately before each individual file operation.
- Archive and Restore are refused before the metadata file is read.
- The user interface hides Archive / Restore and disables Delete for these
  sessions, and explains why.
- GitHub Setup and Portable builds are ordinary desktop programs and keep the
  full feature set.

Tests: `tests/storeEdition.test.ts`.

## Why `runFullTrust` is present

- electron-builder's AppX target always adds it
  (`AppxTarget.getCapabilities()`), because every desktop app packaged with
  `EntryPoint="Windows.FullTrustApplication"` needs it.
- The app is an Electron (Win32) process. Without full trust it would run in an
  AppContainer, where it could not read `%USERPROFILE%\.claude`, Claude
  Desktop's metadata or the user's project folder names, start the read-only
  process query, or open folders in Explorer.
- It is required for the app to work at all.

## History

- 1.2.3.0 (first submission) requested `unvirtualizedResources` with
  `desktop6:FileSystemWriteVirtualization=disabled`. Certification denied it
  (policy 10.6.3).
- 1.2.4.0 removes both and blocks the operations that depended on them.
