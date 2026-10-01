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
- Archive / Restore, with atomic metadata writes.
- **Permanent delete**:
  - an exact preview of every path that will be removed
  - typed confirmation
  - path validation before each removal
  - a full per-file result report (partial failures are reported as such)
- Bulk select: archive, restore, export and delete (bulk delete requires typing `DELETE <n>`).
- Export: raw `.jsonl` copy, session info `.json`, readable Markdown conversation. Exports are copies; originals are never modified.
- Storage dashboard: totals, disk usage breakdown, top projects, largest sessions.
- Safety guards:
  - modifying actions are blocked while Claude Desktop runs
  - sessions open in a running Claude Code process are blocked
  - DRY RUN mode
- A parsed-transcript cache, so restarts and rescans are fast even with 100 MB+ transcripts.
- Optional auto refresh (file watching or an interval), plus manual **Refresh** (F5).

## Requirements

- Windows 10/11 x64 (the main target; macOS/Linux discovery paths exist but are untested)
- Node.js 20+ (developed with Node 24)
- Yarn 1.x (classic) — the project uses `yarn.lock`; there is no npm lockfile

## Getting started

```bash
yarn install
yarn dev        # development app (DRY RUN by default)
yarn test       # automated tests (fixtures in temp folders only)
yarn typecheck  # TypeScript, main + renderer
yarn build      # production bundles into out/
yarn dist       # Windows x64 installer + portable exe into dist/
```

`yarn dist` produces:

- `dist/Claude Local Session Manager-Setup-<version>-x64.exe`: NSIS installer (per-user, lets you pick the install directory)
- `dist/Claude Local Session Manager-Portable-<version>-x64.exe`: single portable exe
- `dist/win-unpacked/`: the unpacked app

The executables are not code-signed, so Windows SmartScreen may warn on first launch ("More info" → "Run anyway").

`yarn icon` regenerates `build/icon.ico` / `build/icon.png` (a neutral glyph, not a Claude logo).

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
- `agent-*.jsonl` files are subagent logs and never count as sessions. Legacy
  project-level ones are attributed to their parent through their declared `sessionId`.

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
- **Claude Code CLI sessions** have no archive flag on disk. For them,
  Archive is stored only in this app (`app-archive.json` in the app's data
  folder). No Claude file is modified, and the session still appears in
  `claude --resume`.

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

Never deleted: project folders, the `memory\` folder, the
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
  process check fails. A session open in a running Claude Code process
  (from `~/.claude/sessions/<pid>.json`, PID verified to be alive) cannot be
  deleted or have its metadata changed. Use **Re-check** after closing Claude.
  Scanning, browsing and export always work.
- **DRY RUN.** With `CLAUDE_SESSION_MANAGER_DRY_RUN=true`, archive, restore
  and delete only log what they would do. DRY RUN is **on by default in
  development** (`yarn dev`) and off in the packaged app. Override either way:

  ```powershell
  $env:CLAUDE_SESSION_MANAGER_DRY_RUN = "false"; yarn dev   # real actions in dev
  $env:CLAUDE_SESSION_MANAGER_DRY_RUN = "true"; & ".\dist\win-unpacked\Claude Local Session Manager.exe"
  ```

  The UI shows a DRY RUN banner and badge when active.
- **Delete checks** (in the main process, every time):
  1. A one-time plan token, valid for 15 minutes, must match the selected session IDs.
  2. The confirmation must be exactly `DELETE` / `DELETE PERMANENTLY`, or `DELETE <n>` for bulk.
  3. A fresh rescan must produce byte-for-byte the plan the user reviewed (same paths, sizes, file counts); otherwise the delete aborts with "files changed".
  4. Every path is validated before anything is touched, and again right before its own removal:
     - absolute, no `..` segments, no device paths
     - inside the correct allowed root (projects root, a discovered `claude-code-sessions` root, `file-history`, `session-env`)
     - exact depth and file-name shape per kind (e.g. `<root>\<project>\<uuid>.jsonl`)
     - not itself a symlink or junction, and `realpath` equal to the lexical path (no link escape)
  5. `fs.rm` is only called on those validated exact paths. There are no wildcards and no globbing.

## Architecture

```
src/
  shared/            types, IPC contract, title/confirmation/format helpers
  main/              Electron main process (all filesystem access)
    index.ts         window, security hardening, service wiring
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
      cacheService.ts      parsed-transcript index in userData
      watchService.ts      throttled fs.watch / interval refresh
  preload/           contextBridge API (named session-ID operations only)
  renderer/          React UI (sidebar, list, details, delete modal, pages)
tests/               Vitest safety tests (temp fixture trees only)
fixtures/            sample metadata + transcripts (incl. Vietnamese text)
scripts/             icon generator
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
- Claude Code CLI sessions have no on-disk archive flag; their archive state lives only in this app.
- Remote (SSH/WSL) Desktop sessions: only the local metadata can be managed.
- Executables are unsigned.
