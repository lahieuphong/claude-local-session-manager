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
- **Claude and OpenAI Codex**: every start asks which tool's sessions to manage. Codex sessions get the same list, search, projects, details, export, hide, archive and delete; Codex itself does the archiving and deleting (see [OpenAI Codex](#openai-codex)). The accent tells them apart: orange for Claude, blue for Codex.
- **Several Claude accounts**: every sign-in on this PC (`~/.claude` and `~/.claude-accounts/<name>`) is listed in a dropdown at the top right, and the list, projects and storage follow it.
- **Usage** (Settings): how much of each account's plan limits (five hours, a week) is used and the day and time each resets, as Claude Code and Codex last recorded it on this PC. It follows what they record, read again every 10 seconds while on screen; no server is asked.
- **Terminal** (Setup, Portable and development builds): a real terminal at the bottom of the window, as in VS Code: PowerShell, Command Prompt or Git Bash, one tab each, starting in the project folder of the session on screen (see [Terminal](#terminal)).
- Session list with search (title, prompts, project, paths, IDs, accent-insensitive: `nha hat` finds `Nhà hát`), sorting, grouping by date or project, and filters (All / Active / Archived / Transcript only / Metadata only & problems / per project).
- Details panel:
  - what you need to recognise a session: project path, dates, model, message counts, first and last message
  - technical details (collapsed): IDs, every file path with reveal in Explorer, where the disk space goes, and the **raw** metadata title (`null`, `""` and a missing field are shown separately)
  - raw metadata JSON (collapsed)
- **Archive / Restore** (Claude Desktop's own `isArchived` flag, atomic metadata writes) for Desktop sessions;
  **Hide / Show session** for Claude Code transcript-only sessions (this app's list only, never Claude's files).
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
  - no arming step: a delete runs for real after its typed confirmation (the Microsoft Store edition keeps Safe Mode)
- A parsed-transcript cache, so restarts and rescans are fast even with 100 MB+ transcripts.
- Optional auto refresh (file watching or an interval), plus manual **Refresh** (F5).
- UI in **English, Tiếng Việt and 简体中文** (see [UI languages](#ui-languages)).
- Keyboard: <kbd>Ctrl</kbd>+<kbd>K</kbd>, <kbd>Ctrl</kbd>+<kbd>F</kbd> or <kbd>/</kbd> focus search
  (<kbd>Esc</kbd> clears it), <kbd>↑</kbd>/<kbd>↓</kbd>/<kbd>Home</kbd>/<kbd>End</kbd> move through
  the list, <kbd>F5</kbd> rescans, <kbd>Esc</kbd> closes dialogs, <kbd>Ctrl</kbd>+<kbd>`</kbd> shows or hides
  the terminal and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> opens a new one.

## UI languages

The interface is available in **English**, **Tiếng Việt** and **简体中文**
(Simplified Chinese).

- **First launch** follows the Windows display language: `vi-*` → Tiếng Việt;
  `zh-CN`, `zh-SG`, `zh-Hans*` → 简体中文; anything else → English
  (Traditional Chinese falls back to English until it is added).
- **Settings → General → Language** switches immediately, without a restart.
  The choice is saved in `%APPDATA%\Claude Local Session Manager\settings.json`
  and kept across restarts and updates. "Use system language" clears it.
- **Settings → General → Motion**: "Follow system" respects the Windows
  animation setting (`prefers-reduced-motion`); "Reduce motion" turns
  transitions off in the app.
- Never translated: file paths, session/plan IDs, model IDs, branch names,
  raw metadata, the typed confirmation phrases (`DELETE`, `DELETE <n>`,
  `ENABLE DELETE`), and session titles/prompts (user content).
- Logs and the text copied with **Copy delete plan** stay in English, so a
  plan can be reviewed independently of the UI language.
- The UI language never affects deletion safety: the Store edition still starts
  in **Safe Mode** on every launch, and **Real Delete Armed** is never saved.

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

There are three Windows options. Each is a **separate distribution channel**
with its own updates; they share one version number.

| Option | Updates |
|---|---|
| **Microsoft Store** — published there as **LHP Local Session Manager**, once Microsoft certifies it | Delivered by the Microsoft Store |
| **GitHub Setup** — `…-Setup-X.Y.Z-x64.exe` | From GitHub Releases, inside the app (Settings → Updates) |
| **Portable** (advanced) — `…-Portable-X.Y.Z-x64.exe` | Manual: download the new release |

Settings → Updates shows which kind of copy it is (*Setup / Portable /
Microsoft Store / Development build*). The Store version never uses the GitHub
updater. Store packaging and submission are described in
[docs/MICROSOFT_STORE.md](docs/MICROSOFT_STORE.md). The Store product exists
in Partner Center; the listing goes live only after Microsoft certifies a submission.

**The Microsoft Store edition is more limited.** The Microsoft Store edition
does not modify Claude Desktop's AppData files: sessions that have Claude
Desktop metadata can be browsed and exported, but not archived, restored or
deleted. It may still write its own application data, such as settings and
manager state, inside the app's own user-data location. Transcript-only
sessions under `~\.claude` can be hidden or deleted as usual. It also keeps
Safe Mode, a step the other builds do not have (see [Safety model](#safety-model)).
Everything else in this README applies in full to the GitHub Setup and Portable
builds.

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
  after start (never delaying startup), and on **Settings → Updates → Check for
  updates**. States: *Checking for updates… · You're up to date · Update
  available: X.Y.Z · Downloading update… · Update ready to install · Update
  failed*. Downloading and installing only happen when you click
  **Download update** and then **Restart and install** — never silently, and
  not automatically on quit. The installer replaces the app in the same folder;
  settings and data are kept.
- **Portable:** shows *Update available: X.Y.Z* and a link to GitHub Releases.
- **Development (`yarn dev`):** update checks are disabled.

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
yarn dev        # development app (acts on your real Claude files, like the GitHub builds)
yarn test       # automated tests (fixtures in temp folders only)
yarn test:ui    # full UI test on the real app, with synthetic data (see below; takes several minutes)
yarn i18n:check # translation completeness (en / vi / zh-CN)
yarn typecheck  # TypeScript, main + renderer
yarn build      # production bundles into out/
yarn dist       # clean dist/, build, then Setup + Portable into dist/ (never publishes)
                # (= yarn dist:github; the GitHub channel)
yarn store:check      # Microsoft Store: validate identity, name, version mapping and assets
yarn store:privacy    # rebuild the public privacy page (docs/privacy/) from store/privacy.md
yarn dist:store       # Microsoft Store package into dist/store/ (needs the Partner Center identity)
yarn dist:store:test  # local TEST Store package (fake identity, never submit) into dist/store-test/
yarn store:screenshots      # Store listing screenshots from the built Store package (synthetic demo profile) into store/listing-assets/
yarn store:validate-assets  # check the Store listing images (sizes, PNG, all languages)
yarn clean      # remove build output only: dist/, release/, out/
```

`yarn test:ui` starts the real app on a synthetic profile (`.ui-test/`, never
your Claude data; it stops before the first click if the app reads anything
else) and a window opens while it runs. First it injects known defects to prove
its checks still notice them. Then it checks every screen in every language at
four window sizes for what a person would call broken: squeezed or overlapping
items, text cut off, controls covered or out of reach, untranslated text, missing
screen-reader names, faint text. Finally it clicks through the features with a
real mouse and keyboard, including real archive and delete on the synthetic
profile. The report and screenshots are in `.ui-test/report/`. To test a packaged
build: `node scripts/ui-test.mjs --exe "dist/win-unpacked/Claude Local Session Manager.exe"`.

`yarn dist` produces in `dist/`: the Setup exe + `.blockmap`, the Portable
exe, `latest.yml` (updater metadata) and `win-unpacked/` (unpacked app for
debugging). `yarn icon` regenerates `build/icon.ico` / `build/icon.png` (a
neutral glyph, not a Claude logo) from `src/shared/appMark.json`, the same
shapes and colors the app draws in its sidebar, so the window, taskbar,
installer and in-app mark always match (a test fails if they drift).

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
| Other Claude sign-ins (the same folders, per account; `projects` and others may be links to `.claude`) | `%USERPROFILE%\.claude-accounts\<name>\` |
| Claude Desktop "Code" session metadata (MSIX / Microsoft Store) | `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code-sessions\<accountId>\<orgId>\local_<id>.json` |
| Claude Desktop metadata (classic installer) | `%APPDATA%\Claude\claude-code-sessions\<accountId>\<orgId>\local_<id>.json` |
| Desktop archive hint / delete tombstones | `archived-sessions.idx`, `deleted_<id>` next to the `local_*.json` files |

`<sanitized-cwd>` is the project path with every non-alphanumeric character
replaced by `-` (e.g. `e:\Phong_Nho_IT\185` → `e--Phong-Nho-IT-185`). The app
reads the real project path from the transcript's `cwd` field instead of
decoding the folder name.

The Settings page lists every location that was checked and which ones exist.

## Several Claude accounts

Every Claude config folder found (`~/.claude`, `CLAUDE_CONFIG_DIR`, and each
folder in `~/.claude-accounts` that has a `projects` folder) is one account. With
two or more, a dropdown at the top right lists them, named from `oauthAccount` in the
account's `.claude.json` (only the email, display name and plan are kept). With one, that file is not
opened. `.credentials.json` is never opened.

Accounts can share one session store through folder links, and a transcript does
not say who wrote it. A session is listed under the accounts that left a trace of
using it (`session-env/<uuid>`, the registry of running sessions), so it can appear
under two. One with no trace goes under the account whose folder really holds the
store. **This is only where a session is listed.** Safety does not depend on it: a
session running under any account is protected in every view, and deleting a session
removes it from the shared store, with its folders in every account.

## OpenAI Codex

The first screen asks whose sessions to manage: Claude's or Codex's. The switch at
the top of the sidebar goes back to it.

Codex keeps its sessions in its own folder, `%USERPROFILE%\.codex` (or `CODEX_HOME`).
Each `%USERPROFILE%\.codex-<name>` folder that holds a Codex database is listed as
another Codex account. With two or more, the dropdown at the top right names each
like a Claude account: its email, its ChatGPT plan ("Pro") or *API key*, its
sessions and those Codex wrote to in the last two minutes. In each folder the app reads:

| What | Where |
|---|---|
| The sessions (title, folder, model, dates, archive flag) | `state_<n>.sqlite`, table `threads` |
| Who started whom (sub-agents) | `state_<n>.sqlite`, table `thread_spawn_edges` |
| The conversation | `thread_history_<n>.sqlite`, table `thread_items` |
| Session files of older or not yet migrated sessions | `sessions\YYYY\MM\DD\rollout-….jsonl`, `archived_sessions\` |
| Names given to sessions | `session_index.jsonl` |

The databases are opened read-only, with every column looked up first (Codex's
schema changes between versions). Only the sessions the user started are listed:
sub-agents and Codex's automatic reviews are counted with the session that
started them. `auth.json`, the Codex sign-in, is opened only with two or more
Codex folders, and only the email and plan in its ID token are kept (or that it
holds an API key); the tokens and the key never leave the function that reads it.

**Changes are made by Codex itself.** Archive, Restore and Delete run the Codex
CLI found on this PC (`npm i -g @openai/codex`, else the one the Codex extension
for VS Code brings), never a shell: `codex archive <id>`, `codex unarchive <id>`
and `codex delete --force <id>`, with `CODEX_HOME` set to the session's folder.
Codex deletes the session, the sessions it started, their conversation, their
files and the index line; the app then reads Codex's data again and reports each
part it finds still there. Delete goes through the same plan, confirmation,
expiry, fresh re-scan and Safe Mode as for Claude. A session Codex wrote to in the
last two minutes may still be running, so it is not archived or deleted. The
Codex app may stay open: Codex changes its own data.

"OpenAI" and "Codex" are trademarks of OpenAI, and "Claude" of Anthropic. Their
logos (from the publishers' VS Code extensions) are shown only to tell the two
tools apart. This unofficial app is not affiliated with either company.

## Terminal

Setup, Portable and development builds have a terminal at the bottom of the
window, as in VS Code: a real shell on Windows' own pseudo-console (ConPTY,
through [node-pty](https://github.com/microsoft/node-pty)), drawn by
[xterm.js](https://xtermjs.org).

- **Terminal** in the sidebar, or <kbd>Ctrl</kbd>+<kbd>`</kbd>, shows or hides it. Its shells keep
  running while it is hidden, and while you switch between Claude and Codex.
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> opens another one.
- One tab per shell: PowerShell 7, Windows PowerShell, Command Prompt or Git Bash,
  whichever this PC has. **+** opens the shell chosen last; the arrow next to it lists them all.
- A new terminal starts in the project folder of the session on screen, else in your home folder.
- **Continue in terminal**, in the details panel, opens a terminal in the session's project
  folder with `claude --resume <id>` (Codex: `codex resume <id>`) typed in: press Enter to run
  it. A session of another account gets that account's folder (`CLAUDE_CONFIG_DIR` for Claude,
  `CODEX_HOME` for Codex). It is greyed out for a session whose conversation is not on this PC,
  or that is open in a program right now.
- <kbd>Ctrl</kbd>+<kbd>C</kbd> copies a selection (with nothing selected it stops the running
  program), <kbd>Ctrl</kbd>+<kbd>V</kbd> pastes, a right-click copies or pastes, and
  <kbd>Ctrl</kbd>+click opens a web address.
- Drag the panel's top edge, or use the arrow keys on it, to change its height; the arrow at
  the top right maximizes it. `exit` closes a tab; closing a tab ends its shell and whatever runs in it.

What you type goes only to the shell: the app never records or logs it, nor what
the shell prints. A shell runs with your own rights, like any terminal. The page
cannot name a program, a command line or a folder: it asks for a shell by its ID
from the list the main process found, and for a folder by a session's ID
([src/shared/terminal.ts](src/shared/terminal.ts)). Closing the window or
reloading the page ends every shell.

The Microsoft Store edition has no terminal, and its package does not contain
node-pty: Windows isolates that package's AppData, so a command run from it
would not behave as in any other terminal.

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
  metadata. Instead there is **Hide session / Show session**: an entry in
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
- **No arming step (GitHub Setup, Portable, development).** Archive, restore and
  delete act for real straight away: there is no dry run, no timer and nothing
  to switch on. A delete still shows the exact plan, needs the typed `DELETE` /
  `DELETE <n>` and passes every check below.
- **Safe Mode / real-delete arming (Microsoft Store edition only).** Every launch starts in
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
- **Environment variable (Store edition, development/testing only).** A packaged
  Store build **ignores** `CLAUDE_SESSION_MANAGER_DRY_RUN` (a stale variable can
  never start it armed). A development run of the Store edition
  (`CLAUDE_SESSION_MANAGER_DISTRIBUTION=store`) starts armed only when
  `CLAUDE_SESSION_MANAGER_DRY_RUN=false` comes with the explicit opt-in
  `CLAUDE_SESSION_MANAGER_DEV_ALLOW_ENV_ARM=1`, with the same 10-minute and
  single-delete limits. GitHub builds ignore both. A normal `yarn dev` has no
  Safe Mode either, unless you ask for one with
  `CLAUDE_SESSION_MANAGER_DRY_RUN=true`, to try the delete flow on real data:

  ```powershell
  $env:CLAUDE_SESSION_MANAGER_DISTRIBUTION = "store"; $env:CLAUDE_SESSION_MANAGER_DRY_RUN = "false"; $env:CLAUDE_SESSION_MANAGER_DEV_ALLOW_ENV_ARM = "1"; yarn dev
  $env:CLAUDE_SESSION_MANAGER_DRY_RUN = "true"; yarn dev   # dry run in a normal development run
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
- **Store screenshot mode.** `CLAUDE_SESSION_MANAGER_SCREENSHOT_MODE=true`
  (development builds only; a packaged build ignores it) previews the Store
  edition's UI on static demo data. It reads no Claude data, starts none of the
  real services, refuses every action that would change, delete, export or open
  something, and cannot leave Safe Mode. The published Store screenshots are
  not made with it: `yarn store:screenshots` runs the packaged Store build on
  synthetic session files, see
  [`store/listing-assets/README.md`](store/listing-assets/README.md).

## Architecture

```
src/
  shared/            types, IPC contract, title/confirmation/format helpers
    locale.ts        supported UI languages + OS language detection
    locales/         translations: <language>/<namespace>.json
    messages.ts      main-process message keys (translated in the UI)
    distribution.ts  github | store | development channel (from packaged metadata)
  main/              Electron main process (all filesystem access)
    index.ts         window, security hardening, service wiring
    windowGuard.ts   never leave the window hidden (fallback show, load/crash dialog)
    distribution.ts  reads the channel marker + Store product ID at startup
    ipc/             typed IPC handlers (validate IDs, never accept paths)
    security/        pathValidator.ts – allowed roots + per-kind path rules
    screenshot/      Store screenshot mode (dev only): static demo data + read-only IPC
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
      safetyMode.ts        Safe Mode / REAL DELETE ARMED (Store edition, memory only); no arming step in other builds
      updateService.ts     GitHub Releases updates (installed / portable / dev); Store-managed mode
      packagingPolicy.ts   what a build may write (Store edition: no changes to Claude Desktop's AppData files)
      cacheService.ts      parsed-transcript index in userData
      watchService.ts      throttled fs.watch / interval refresh
      terminal/            the terminal: shells found on this PC, node-pty sessions, flow control
  preload/           contextBridge API (named session-ID operations; the terminal's own bridge)
  renderer/          React UI (sidebar, list, details, delete modal, pages)
    src/i18n/        i18next setup, locale-aware formatting (Intl)
    src/terminal/    xterm.js views (loaded with the first terminal)
    src/styles/      design tokens (colors, type, spacing, motion)
tests/               Vitest safety tests (temp fixture trees only)
fixtures/            sample metadata + transcripts (incl. Vietnamese text)
scripts/             icon + Store asset generator, release helpers, i18n-check.mjs,
                     dist-store.mjs / store-config.mjs / store-inspect.mjs (Microsoft Store),
                     store-screenshots.mjs / store-demo-data.mjs / store-listing-assets.mjs (Store listing images)
store/               Store identity, listing drafts + images, privacy policy, certification notes
docs/                MICROSOFT_STORE.md; privacy/ + index.html = the public pages (GitHub Pages)
```

Security model:

- Renderer: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, a strict CSP, no navigation, no new windows, all permissions
  denied except clipboard write (for "copy path").
- The preload exposes named operations only (`archiveSession(id)`,
  `createDeletePlan(id)`, …). There is no generic `deleteFile(path)`,
  `writeFile` or `exec`.
- The terminal is a bridge of its own (`window.terminal`), absent from the
  Store edition: a shell is chosen by its ID from those the main process found,
  a folder by a session ID, and what is typed goes to the terminal it was typed
  in. Its main-process side checks every argument and never logs what is typed
  or printed (see [Terminal](#terminal)).
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

## Privacy

No telemetry, analytics or crash reporting. Session data is read and changed
only on your computer; nothing is uploaded. GitHub builds contact GitHub
Releases for updates; the Microsoft Store build never contacts GitHub. Details:
[store/privacy.md](store/privacy.md), published at
<https://lahieuphong.github.io/claude-local-session-manager/privacy/> once
GitHub Pages is enabled for `main` / `docs`.

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
- Logs: `%APPDATA%\Claude Local Session Manager\logs\main.log` (Settings → Advanced → Show log).

## Known limitations

- Claude's on-disk formats are undocumented and may change. The parsers are
  tolerant (missing fields, invalid JSON, unknown fields are preserved),
  and the raw metadata is shown for debugging, but new layouts may need updates.
- Claude Desktop metadata handling follows Claude Desktop 2.16120's code
  (field names, `archived-sessions.idx`, `deleted_*` tombstones). It was
  verified with fixtures; the test machine had no Desktop "Code" sessions.
- Claude Code transcript-only sessions have no on-disk archive flag; hiding a session lives only in this app.
- Remote (SSH/WSL) Desktop sessions: only the local metadata can be managed.
- Executables are not code-signed yet: SmartScreen may warn on first run, and
  electron-updater can verify downloads only by the SHA-512 in `latest.yml`
  (not by publisher) until a certificate is configured.
- The Setup installer is per-user one-click: no install-folder choice and no
  Desktop-shortcut checkbox (use `--no-desktop-shortcut` or delete the shortcut).
