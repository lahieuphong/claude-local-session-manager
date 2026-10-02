# Privacy policy — Claude Local Session Manager

_Last updated: October 2026. Applies to the Microsoft Store, GitHub Setup and Portable versions._

Claude Local Session Manager is an **unofficial** local utility for managing
Claude Code and Claude Desktop sessions stored on your own computer. It is not
made by, affiliated with or endorsed by Anthropic.

## What the app reads

- Claude Code session files under your user profile (for example
  `%USERPROFILE%\.claude\projects`, `file-history`, `session-env`, `sessions`).
- Claude Desktop's local session metadata (under `%APPDATA%` /
  `%LOCALAPPDATA%`).
- The list of running processes named `claude`, `node` or `bun` (name,
  executable path, command line, start time), to avoid touching sessions that
  are in use. This is done locally with a read-only Windows query.

Session files can contain your prompts, code and file paths. They are read only
on your computer to display, search, export, archive or delete sessions.

## What the app sends

- **No session content, file paths or prompts are sent anywhere.** The app has
  no server and no account.
- **No telemetry, analytics, advertising or crash reporting** is collected by
  the app.
- **GitHub Setup and Portable versions** check GitHub Releases
  (`github.com/lahieuphong/claude-local-session-manager`) for new versions: at
  startup and when you click *Check for updates*. These requests are made by
  electron-updater and contain only what a normal HTTPS download request
  contains (such as your IP address and standard request headers). The update
  library keeps a random local ID to decide staged rollouts; this app does not
  send it.
- **Microsoft Store version** never contacts GitHub. Updates are delivered by
  the Microsoft Store under Microsoft's own terms and privacy statement.
- Buttons such as *Open GitHub Releases* or *Open Microsoft Store* open those
  pages in your browser or the Store app only when you click them.

## What the app stores

On your computer only, in `%APPDATA%\Claude Local Session Manager`:
settings (language, motion, refresh mode, display options), the manager's own
"hidden in manager" list, a cache of parsed session summaries, and log files.
The deletion safety mode is never stored: every launch starts in Safe Mode.

Exports are written only to a folder you choose. Copy buttons put text on your
clipboard only when you click them.

## Changing and deleting data

- **Archive / Restore** changes Claude Desktop's own archive flag in its local
  metadata file.
- **Permanent delete** removes the exact local session files shown in a plan
  you review, only after you arm real deletion and type a confirmation. Deleted
  files are not sent anywhere and cannot be recovered by the app.
- Uninstalling the app does not delete your Claude data. You can delete the
  app's own data folder (`%APPDATA%\Claude Local Session Manager`) yourself.

## Contact

Questions and reports: <https://github.com/lahieuphong/claude-local-session-manager/issues>
