# Claude Local Session Manager

Unofficial local session manager for Claude Code/Desktop on Windows.

A desktop app (Electron + React + TypeScript) that reads the Claude Code /
Claude Desktop session data stored **on this machine**. It lists every
session, shows its details and exact files, and can archive, restore,
export or permanently delete sessions.

> **This is an unofficial local utility and is not affiliated with Anthropic.**
> It only works with local files. It never talks to any network service.

---

## Features

- Automatic discovery of Claude storage. Nothing is hard-coded: everything comes from `USERPROFILE` / `APPDATA` / `LOCALAPPDATA` (and `CLAUDE_CONFIG_DIR` if set).
- Session list with search (title, prompts, project, paths, IDs, accent-insensitive: `nha hat` finds `Nhà hát`), sorting, grouping by date or project, and filters (All / Active / Archived / Transcript only / Metadata only & problems / per project).
- Details panel:
  - display title vs. **raw** metadata title (`null`, `""` and a missing field are shown separately)
  - IDs, dates, model, message counts and size breakdown
  - every file path, with reveal in Explorer
  - first and last prompt preview
  - raw metadata JSON (collapsed)
- **Archive / Restore** (Claude Desktop's own `isArchived` flag, atomic metadata writes) for Desktop sessions;
  **Hide / Show in manager** for Claude Code transcript-only sessions (this app's list only, never Claude's files).
- **Permanent delete**:
  - an exact preview of every path that will be removed
  - typed confirmation
  - path validation before each removal
  - a full per-file result report (partial failures are reported as such)
- Bulk select: archive/restore (Desktop sessions), hide/show in manager, export and delete (bulk delete requires typing `DELETE <n>`).
- Export: raw `.jsonl` copy, session info `.json`, readable Markdown conversation. Exports are copies; originals are never modified.
- Storage dashboard: totals, disk usage breakdown, top projects, largest sessions.
- Safety guards:
  - modifying actions are blocked while Claude Desktop runs
  - sessions open in a running Claude Code process are blocked
  - Safe Mode (DRY RUN) on every launch; real deletion is armed in the app for one delete / 10 minutes
- A parsed-transcript cache, so restarts and rescans are fast even with 100 MB+ transcripts.
- Optional auto refresh (file watching or an interval), plus manual **Refresh** (F5).
- UI in **English, Tiếng Việt and 简体中文** (see [UI languages](#ui-languages)).
- Keyboard: <kbd>Ctrl</kbd>+<kbd>K</kbd>, <kbd>Ctrl</kbd>+<kbd>F</kbd> or <kbd>/</kbd> focus search
  (<kbd>Esc</kbd> clears it), <kbd>↑</kbd>/<kbd>↓</kbd>/<kbd>Home</kbd>/<kbd>End</kbd> move through
  the list, <kbd>F5</kbd> rescans, <kbd>Esc</kbd> closes dialogs.

## UI languages

The interface is available in **English**, **Tiếng Việt** and **简体中文**
(Simplified Chinese).

- **First launch** follows the Windows display language: `vi-*` → Tiếng Việt;
  `zh-CN`, `zh-SG`, `zh-Hans*` → 简体中文; anything else → English
  (Traditional Chinese falls back to English until it is added).
- **Settings → General → Language** switches immediately, without a restart.
  The choice is saved in `%APPDATA%\Claude Local Session Manager\settings.json`
  and kept across restarts and updates. "Use system language" clears it.
- **Settings → Appearance → Motion**: "Follow system" respects the Windows
  animation setting (`prefers-reduced-motion`); "Reduce motion" turns
  transitions off in the app.
- Never translated: file paths, session/plan IDs, model IDs, branch names,
  raw metadata, the typed confirmation phrases (`DELETE`, `DELETE <n>`,
  `ENABLE DELETE`), and session titles/prompts (user content).
- Logs and the text copied with **Copy delete plan** stay in English, so a
  plan can be reviewed independently of the UI language.
- The UI language never affects deletion safety: the app still starts in
  **Safe Mode** on every launch, and **Real Delete Armed** is never saved.

Translations live in `src/shared/locales/<language>/<namespace>.json`
(`common`, `sessions`, `inspector`, `deletion`, `safety`, `settings`,
`storage`, `updater`, `messages`). English is the source. `yarn i18n:check`
(also part of `yarn test`) fails if any language misses a key, adds one,
changes a `{{placeholder}}`, lacks a plural form, or drifts from the safety
glossary (Safe Mode / Real Delete Armed / Delete permanently / Hide in
manager / Transcript only). To add a language (for example `zh-TW`): add it to
`SUPPORTED_LOCALES` in `src/shared/locale.ts`, copy `locales/en/`, translate
it, and register it in `src/shared/locales/index.ts`.

**Typography.** The app uses system font stacks only and bundles no font
files: `"SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont,
"Segoe UI Variable", "Segoe UI", sans-serif` for the UI (Segoe UI Variable on
Windows), `"SFMono-Regular", "SF Mono", "Cascadia Code", "Cascadia Mono",
Consolas, monospace` for technical values only (paths, IDs, models), and
Microsoft YaHei UI / PingFang SC for Simplified Chinese. Apple's SF fonts
are used only if they are already installed on the machine.

## Installation

Download from **[GitHub Releases](https://github.com/lahieuphong/claude-local-session-manager/releases)**:

| File | Use it when |
|---|---|
| `Claude-Local-Session-Manager-Setup-X.Y.Z-x64.exe` | **Recommended.** Normal installation. |
| `Claude-Local-Session-Manager-Portable-X.Y.Z-x64.exe` | Advanced/testing: runs without installing. |

(GitHub shows dashes instead of spaces in the file names. Locally `yarn dist`
writes `Claude Local Session Manager-Setup-X.Y.Z-x64.exe` /
`…-Portable-X.Y.Z-x64.exe` into `dist/`.)

**Setup (recommended)**
- Installs per user, no admin rights, into
  `%LOCALAPPDATA%\Programs\claude-local-session-manager\`.
- Adds a **Start Menu** entry *Claude Local Session Manager* (press Windows, type the name).
- Adds a **Desktop** shortcut on the first install only. Delete it if you don't
  want it — upgrades will not recreate it. To skip it entirely, run
  `Setup.exe --no-desktop-shortcut`.
- Pin it to the **Taskbar** yourself (right-click the running app or the Start
  entry → *Pin to taskbar*). The app has a stable Windows identity
  (AppUserModelID `com.lahieuphong.claude-local-session-manager`), so pins keep
  working across upgrades.
- Appears in **Settings → Apps → Installed apps** for uninstalling.
- Checks GitHub Releases for updates and can install them.

**Portable**
- A single exe; nothing is installed or registered (no Start Menu entry, no
  uninstall entry). It checks for updates but never replaces itself — download
  the new release manually.
- Don't pin a portable exe from a build folder as your everyday app; use Setup.

> **Unsigned builds / SmartScreen.** Releases are not code-signed yet, so
> Windows SmartScreen may warn the first time ("Windows protected your PC" →
> *More info* → *Run anyway*). Verify a download against `SHA256SUMS.txt` in
> the release.

### One-time migration from an old shortcut

Older test builds were sometimes pinned straight from `dist\`, which breaks
("Problem with Shortcut") whenever `dist\` is rebuilt. Once:
1. Unpin/delete the broken shortcut.
2. Install the **Setup** build.
3. Launch it from the Start Menu.
4. Pin the installed app to the Taskbar.

`dist/` only holds build output; it is never the installed application path.

## Updating

- **Setup:** the app checks GitHub Releases in the background a few seconds
  after start (never delaying startup), and on **Settings → About → Check for
  updates**. States: *Checking for updates… · You're up to date · Update
  available: X.Y.Z · Downloading update… · Update ready to install · Update
  failed*. Downloading and installing only happen when you click
  **Download update** and then **Restart and install** — never silently, and
  not automatically on quit. The installer replaces the app in the same folder;
  settings and data are kept.
- **Portable:** shows *Update available: X.Y.Z* and a link to GitHub Releases.
- **Development (`yarn dev`):** update checks are disabled.
- Every start after an update is in **Safe Mode** (real-delete arming is never stored).

Update security: everything runs in the main process via electron-updater,
over HTTPS from this repository's GitHub Releases only (configured at build
time in `app-update.yml`). The renderer can only call `checkForUpdates()`,
`downloadUpdate()`, `installUpdate()` and `openReleasesPage()` — no URLs,
paths or commands. Downloads are verified against the SHA-512 in `latest.yml`.

## Uninstalling

Windows **Settings → Apps → Installed apps → Claude Local Session Manager →
Uninstall** removes:
- the installed files in `%LOCALAPPDATA%\Programs\claude-local-session-manager\`
- the Start Menu and Desktop shortcuts it created
- its Installed-apps (uninstall registry) entry

It intentionally **keeps** the app's own data in
`%APPDATA%\Claude Local Session Manager\` (settings, hidden-in-manager list,
scan cache, logs), so reinstalling picks up where you left off. To remove that
too, delete the folder manually or run the uninstaller with `--delete-app-data`
(it then removes only `%APPDATA%\Claude Local Session Manager` and
`%APPDATA%\claude-local-session-manager`).

Uninstalling **never** touches `~\.claude`, `~\.claude\projects`, Claude
Desktop storage, Claude session transcripts or your source-code projects.

## Development

Requirements: Windows 10/11 x64 (macOS/Linux discovery paths exist but are
untested), Node.js 24 (CI uses 24), Yarn 1.x classic (the project uses
`yarn.lock`; there is no npm lockfile).

To review the update UI without a real release, a development run can use a
fake updater (no network, nothing is installed; packaged builds ignore it):
`$env:CLAUDE_SESSION_MANAGER_DEV_FAKE_UPDATE = "9.9.9"; yarn dev`.

```bash
yarn install
yarn dev        # development app (always starts in Safe Mode / DRY RUN)
yarn test       # automated tests (fixtures in temp folders only)
yarn i18n:check # translation completeness (en / vi / zh-CN)
yarn typecheck  # TypeScript, main + renderer
yarn build      # production bundles into out/
yarn dist       # clean dist/, build, then Setup + Portable into dist/ (never publishes)
yarn clean      # remove build output only: dist/, release/, out/
```

`yarn dist` produces in `dist/`: the Setup exe + `.blockmap`, the Portable
exe, `latest.yml` (updater metadata) and `win-unpacked/` (unpacked app for
debugging). `yarn icon` regenerates `build/icon.ico` / `build/icon.png` (a
neutral glyph, not a Claude logo).

## Versioning and releases

`package.json` `"version"` is the single source of truth (shown in the About
page, embedded in the build and in the artifact names). Versions are
`MAJOR.MINOR.PATCH`.

```bash
yarn version:patch   # 1.0.0 -> 1.0.1   (only edits package.json; prints the result)
yarn version:minor   # 1.0.1 -> 1.1.0
yarn version:major   # 1.1.0 -> 2.0.0
```

**Release process** (GitHub Actions does the packaging and publishing):

```bash
git pull
yarn test
yarn typecheck
yarn build

yarn version:patch                  # e.g. 1.0.0 -> 1.0.1
git add package.json
git commit -m "release: v1.0.1"
git tag v1.0.1
git push origin main
git push origin v1.0.1              # starts .github/workflows/release.yml
```

Or prepare the commit and tag in one step (still pushes nothing):

```bash
yarn release:patch                  # bump + commit "release: vX.Y.Z" + tag vX.Y.Z (requires a clean tree)
git push origin main
git push origin vX.Y.Z
```

The **Release** workflow runs on `v*.*.*` tags on a Windows runner (Node 24):
it fails unless the tag equals `v` + package.json version, then runs
`yarn install --frozen-lockfile`, `yarn test`, `yarn typecheck`, `yarn build`
and `yarn dist`, collects the assets (`yarn release:assets`) and publishes the
GitHub Release *Claude Local Session Manager vX.Y.Z* with generated notes,
using only the built-in `GITHUB_TOKEN` (`contents: write`). Attached assets:
`Claude-Local-Session-Manager-Setup-X.Y.Z-x64.exe`, its `.blockmap`,
`Claude-Local-Session-Manager-Portable-X.Y.Z-x64.exe`, `latest.yml` and
`SHA256SUMS.txt` (never `win-unpacked/` or debug files). The names use dashes
because that is what `latest.yml` references.

### Code signing (future)

Builds are unsigned unless a certificate is provided at build time. Later,
add repository secrets (e.g. `WIN_CSC_LINK` = base64 .pfx, `WIN_CSC_KEY_PASSWORD`)
and uncomment the `CSC_LINK` / `CSC_KEY_PASSWORD` lines in
`.github/workflows/release.yml` (electron-builder also reads `WIN_CSC_LINK` /
`WIN_CSC_KEY_PASSWORD`, or Azure Trusted Signing via `win.azureSignOptions`).
Once signed, set `win.signtoolOptions.publisherName` so electron-updater also
verifies the publisher of downloaded updates. Never commit certificates,
private keys, passwords or tokens.

## Where Claude stores local data

| What | Location |
|---|---|
| Claude Code transcripts | `%USERPROFILE%\.claude\projects\<sanitized-cwd>\<uuid>.jsonl` |
| Session data (subagents, tool results, `custom-title.json`, workflows) | `%USERPROFILE%\.claude\projects\<sanitized-cwd>\<uuid>\` |
| Subagent logs (**not** sessions) | `…\<uuid>\subagents\agent-*.jsonl` (older versions: `…\<sanitized-cwd>\agent-*.jsonl`) |
| Project memory (never touched) | `%USERPROFILE%\.claude\projects\<sanitized-cwd>\memory\` |
| File-edit history per session | `%USERPROFILE%\.claude\file-history\<uuid>\` |
| Session environment per session | `%USERPROFILE%\.claude\session-env\<uuid>\` |
| Running Claude Code sessions | `%USERPROFILE%\.claude\sessions\<pid>.json` |
| Claude Desktop "Code" session metadata (MSIX / Microsoft Store) | `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code-sessions\<accountId>\<orgId>\local_<id>.json` |
| Claude Desktop metadata (classic installer) | `%APPDATA%\Claude\claude-code-sessions\<accountId>\<orgId>\local_<id>.json` |
| Desktop archive hint / delete tombstones | `archived-sessions.idx`, `deleted_<id>` next to the `local_*.json` files |

`<sanitized-cwd>` is the project path with every non-alphanumeric character
replaced by `-` (e.g. `e:\Phong_Nho_IT\185` → `e--Phong-Nho-IT-185`). The app
reads the real project path from the transcript's `cwd` field instead of
decoding the folder name.

The Settings page lists every location that was checked and which ones exist.

## How sessions are recognised

- **Desktop session** (`local_*.json`): linked to its transcript by
  `cliSessionId` (also `unarchivedCliSessionId` / `priorCliSessionIds`),
  matched against the `<uuid>.jsonl` file name. If the same UUID exists in
  several project folders, the one matching the metadata's `cwd` is used;
  otherwise the link is reported as ambiguous and not made.
- **Transcript-only** (Claude Code CLI / IDE): a `<uuid>.jsonl` that no
  metadata file claims.
- **Metadata-only**: a metadata file whose transcript is missing (or is remote, for SSH/WSL sessions).
- **Orphan**: a `<uuid>\` session folder with neither transcript nor metadata.
  Claude Code writes a session's folder under the project folder of its
  *current* cwd, so after `cd tools` a second `<uuid>\` folder can appear in
  e.g. `E--…-nhahattphcm-tools`. Such a same-UUID folder is attached to the
  single session that owns the UUID (shown as an extra session folder and
  included in its delete plan) instead of becoming an orphan.
- `agent-*.jsonl` files are subagent logs and never count as sessions. Legacy
  project-level ones are attributed to their parent through their declared `sessionId`.

**Projects.** A project is the canonical workspace path (the real `cwd`
from metadata or the transcript, normalized and resolved with `realpath`),
so `e:\x`, `E:\X\` and a junction to it are one project. The encoded folder
name under `~/.claude/projects` is only a storage locator. For folders with
no recorded cwd, the app tries records inside the folder, then cwds recorded
elsewhere, then decodes the folder name against the real filesystem
(read-only); otherwise the project is "Unknown project", never the encoded name.

**Message counts.** "Prompts" are meaningful user prompts; "assistant
messages" are distinct model API responses (one per step, so one prompt
usually yields many because every tool-use step is a separate response);
"tool calls" are `tool_use` blocks; "transcript records" are JSONL lines.

**Title.** The UI title is chosen in this order: metadata `title` → `/rename`
custom title → AI title → summary → first meaningful prompt → last prompt →
`Untitled`. A `title` that is `null`, `""`, missing or literally "Untitled"
is not used. The Details panel always shows the raw value as well.

## Archive vs. permanent delete

**Archive is not delete.**

- **Desktop sessions:** archiving sets `isArchived: true` in that one
  `local_*.json`. Every other field, including unknown ones, is kept. The
  write is atomic: temp file, fsync, rename, then the result is re-read to
  verify it. If Claude Desktop's `archived-sessions.idx` exists, it is updated
  in the same format Desktop writes. The transcript is untouched. Restore
  reverses it.
- **Claude Code transcript-only sessions** have no archive flag on disk,
  so the app does **not** offer "Archive" for them and never invents Claude
  metadata. Instead there is **Hide in manager / Show in manager**: an entry in
  `manager-hidden.json` in this app's data folder. It changes only this app's
  list; Claude's files and archive state are untouched and the session still
  appears in Claude. Hidden sessions appear only under "Hidden in manager".

**Permanent delete** removes the session's files from disk. The modal lists
**exactly** what will happen:

| Item | Action |
|---|---|
| `local_<id>.json` metadata | delete file |
| `archived-sessions.idx` | remove this session's ID (only if listed) |
| `deleted_<id>` tombstones | create, mirroring what Claude Desktop itself writes when it deletes a session (Desktop sessions only) |
| `<uuid>.jsonl` transcript(s) | delete file |
| legacy `agent-*.jsonl` belonging to the session | delete file |
| `<uuid>\` session data folder | delete folder |
| `file-history\<uuid>\`, `session-env\<uuid>\` | delete folder (only when exactly one session owns that UUID) |
| the manager's own records (hidden-list entry, cached summary) | removed after the Claude files are gone |

The modal shows, per session: display title, CLI session ID, Desktop ID,
project and project path, every exact target with file/folder counts and
bytes, the tombstone/index changes (only when required), the manager records,
and a **WILL NOT DELETE** list (the source workspace, the Claude project
folder itself and its `memory\`). It also shows the plan ID and SHA-256
content hash, and **COPY DELETE PLAN** copies the whole plan as text for
independent review.

Never deleted: the source workspace (it can never be a target, and no target
may contain it), project folders, the `memory\` folder, the
`projects` / `claude-code-sessions` roots, any transcript shared by two
metadata files, or anything else not listed in the preview.

> ⚠️ **Permanent delete is irreversible.** Files are not moved to the Recycle
> Bin. Make a backup first if you might want the session back.

### Recovering from your own backup

If you backed up `%USERPROFILE%\.claude` and/or the `claude-code-sessions`
folder, close Claude, copy the files back to the **same paths** shown in the
delete result (`<uuid>.jsonl`, the `<uuid>\` folder and `local_<id>.json`),
and remove the matching `deleted_<id>` tombstones next to the metadata.
Without a backup the data cannot be recovered.

## Safety model

- **Claude must be closed.** Archive, restore and delete are blocked while
  Claude Desktop is running (detected by its executable path under
  `WindowsApps\Claude_*` or `AnthropicClaude`). They are also blocked if the
  process check fails. A session attached to a running Claude Code process
  (from `~/.claude/sessions/<pid>.json`; the PID must be alive, be a
  Claude/node process and have the recorded start time, so a reused PID does
  not count) is shown as **RUNNING** (busy), **IDLE** or **IN USE** and cannot
  be deleted or have its metadata changed. A transcript written in the last
  30 seconds is also treated as possibly in use. Use **Re-check** after
  closing Claude. Scanning, browsing, export and hide-in-manager always work.
- **Safe Mode / real-delete arming (in the app).** Every launch starts in
  **SAFE MODE (DRY RUN)**: archive, restore and delete only validate and log;
  no Claude file can be changed. To delete for real:
  1. Quit Claude Desktop (system tray → Quit).
  2. Settings → **Deletion Safety** → **Enable real deletion**, type exactly
     `ENABLE DELETE` (case-sensitive), click **Arm real deletion**.
  3. A red **REAL DELETE ARMED · mm:ss remaining** banner appears. Delete the
     session (typed `DELETE` / `DELETE <n>` as usual).

  The armed state lives **only in the main process's memory** (never in
  settings, localStorage, registry, files or env files). It returns to Safe
  Mode on its own **right after one real delete**, after **10 minutes**, or
  when the app closes; **Return to Safe Mode** does it immediately. Arming only
  flips dry-run on/off: every other guard below still runs, and a plan
  previewed in one mode cannot be executed in the other.

  In Safe Mode, "Delete permanently" is labelled **Run dry-run validation** and
  runs the **full** pipeline below (rescan, identity, content hash, path
  validation), logs exactly what would be deleted, reports whether a real
  delete would currently be blocked, and modifies nothing.
- **Environment variable (development/testing only).** The packaged app
  **ignores** `CLAUDE_SESSION_MANAGER_DRY_RUN` (a stale variable can never start
  it armed). In development, `CLAUDE_SESSION_MANAGER_DRY_RUN=false` starts the
  app armed only together with the explicit opt-in
  `CLAUDE_SESSION_MANAGER_DEV_ALLOW_ENV_ARM=1`, with the same 10-minute and
  single-delete limits:

  ```powershell
  $env:CLAUDE_SESSION_MANAGER_DRY_RUN = "false"; $env:CLAUDE_SESSION_MANAGER_DEV_ALLOW_ENV_ARM = "1"; yarn dev
  ```
- **Delete checks** (in the main process, every time):
  1. The renderer sends only internal session IDs (20 hex), the plan ID (32 hex) and the typed confirmation — never a path.
  2. The plan ID must exist, be unused (single use) and unexpired (15 minutes), and match the same session IDs.
  3. The confirmation must be exactly `DELETE` / `DELETE PERMANENTLY`, or `DELETE <n>` for bulk.
  4. A fresh rescan rebuilds the plan: the CLI/Desktop session IDs must be unchanged, and the SHA-256 content hash (targets, sizes, file/folder counts) must equal the reviewed one; otherwise the plan is **stale** and nothing runs (new or vanished targets are named in the error).
  5. Every path is validated before anything is touched, and again right before its own removal:
     - absolute, no `..` segments, no device paths
     - inside the correct approved root (projects root, a discovered `claude-code-sessions` root, `file-history`, `session-env`)
     - exact depth and file-name shape per kind (e.g. `<root>\<project>\<uuid>.jsonl`)
     - not itself a symlink or junction, and `realpath` equal to the lexical path (no link escape)
     - not equal to, and not an ancestor of, any project workspace, approved root, the Claude home or the user's home folder
  6. `fs.rm` is only called on those validated exact paths. There are no wildcards and no globbing.

- **Test isolation.** `CLAUDE_SESSION_MANAGER_USER_DATA=<folder>` runs the app with
  a separate data folder (and single-instance lock), e.g. to verify a build
  while another instance is open.

## Architecture

```
src/
  shared/            types, IPC contract, title/confirmation/format helpers
    locale.ts        supported UI languages + OS language detection
    locales/         translations: <language>/<namespace>.json
    messages.ts      main-process message keys (translated in the UI)
  main/              Electron main process (all filesystem access)
    index.ts         window, security hardening, service wiring
    windowGuard.ts   never leave the window hidden (fallback show, load/crash dialog)
    ipc/             typed IPC handlers (validate IDs, never accept paths)
    security/        pathValidator.ts – allowed roots + per-kind path rules
    services/
      claudeDiscovery.ts   find Claude roots from env vars
      metadataParser.ts    local_*.json, archive index, tombstones
      transcriptParser.ts  streaming, incremental JSONL parser
      sessionScanner.ts    walk ~/.claude/projects, file-history, session-env
      sessionBuilder.ts    join metadata ↔ transcripts ↔ folders into sessions
      sessionRepository.ts scan orchestration + registry (id → exact files)
      archiveService.ts    atomic isArchived edits / app-local archive
      deleteService.ts     delete plans, verification, execution
      processService.ts    Claude Desktop / Claude Code process detection
      exportService.ts     JSONL / JSON / Markdown export (copies only)
      safetyMode.ts        Safe Mode / REAL DELETE ARMED (memory only)
      updateService.ts     GitHub Releases updates (installed / portable / dev)
      cacheService.ts      parsed-transcript index in userData
      watchService.ts      throttled fs.watch / interval refresh
  preload/           contextBridge API (named session-ID operations only)
  renderer/          React UI (sidebar, list, details, delete modal, pages)
    src/i18n/        i18next setup, locale-aware formatting (Intl)
    src/styles/      design tokens (colors, type, spacing, motion)
tests/               Vitest safety tests (temp fixture trees only)
fixtures/            sample metadata + transcripts (incl. Vietnamese text)
scripts/             icon generator, release helpers, i18n-check.mjs
```

Security model:

- Renderer: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, a strict CSP, no navigation, no new windows, all permissions
  denied except clipboard write (for "copy path").
- The preload exposes named operations only (`archiveSession(id)`,
  `createDeletePlan(id)`, …). There is no generic `deleteFile(path)`,
  `writeFile` or `exec`.
- The main process keeps a registry `sessionId → exact files` built by the
  scanner. The renderer sends only internal session IDs (validated as
  20-hex strings). Every path used for any action comes from that
  registry and is re-validated before use.
- IPC calls from any frame other than the app's own page are rejected.
- The allowed roots come only from auto-discovery. Settings cannot add delete roots.

**Performance.** Transcripts are parsed line by line from byte chunks. Lines
are split on the raw `\n` byte and decoded whole, so UTF-8 (including
Vietnamese) is never split mid-character. Summaries are cached in
`%APPDATA%\Claude Local Session Manager\scan-cache\transcript-index.json`
(never inside `.claude`), keyed by path + size + mtime. When a transcript
only grew, just the new bytes are parsed. On a machine with ~1 GB of
transcripts, a cold scan takes about 1.6 s and a cached rescan about 50 ms.

## Troubleshooting

- **`yarn dev` / electron exits with `Cannot read properties of undefined (reading 'setName')`**:
  the environment has `ELECTRON_RUN_AS_NODE=1`, which VS Code sets for
  processes spawned by extensions. Run from a normal terminal, or clear it
  first: `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell) /
  `unset ELECTRON_RUN_AS_NODE` (bash).
- **"Claude Desktop is running" even after closing the window**: Claude
  Desktop keeps running in the system tray. Quit it from the tray icon, then
  click **Re-check**.
- **The window does not appear / "Could not load the app window"**: the app
  always shows its window (at the latest after 5 seconds) and explains a
  failed load with **Try again / Quit**. This usually means an incomplete
  Portable extraction (for example after starting the Portable exe twice
  quickly): quit, start it once, or download it again. Starting the app
  again also brings back a window that was hidden.
- **A session shows "In use"**: it is open in VS Code / a terminal running
  Claude Code. Close that session (or the IDE window) first.
- Logs: `%APPDATA%\Claude Local Session Manager\logs\main.log` (Settings → Show log).

## Known limitations

- Claude's on-disk formats are undocumented and may change. The parsers are
  tolerant (missing fields, invalid JSON, unknown fields are preserved),
  and the raw metadata is shown for debugging, but new layouts may need updates.
- Claude Desktop metadata handling follows Claude Desktop 2.16120's code
  (field names, `archived-sessions.idx`, `deleted_*` tombstones). It was
  verified with fixtures; the test machine had no Desktop "Code" sessions.
- Claude Code transcript-only sessions have no on-disk archive flag; "Hide in manager" lives only in this app.
- Remote (SSH/WSL) Desktop sessions: only the local metadata can be managed.
- Executables are not code-signed yet: SmartScreen may warn on first run, and
  electron-updater can verify downloads only by the SHA-512 in `latest.yml`
  (not by publisher) until a certificate is configured.
- The Setup installer is per-user one-click: no install-folder choice and no
  Desktop-shortcut checkbox (use `--no-desktop-shortcut` or delete the shortcut).
