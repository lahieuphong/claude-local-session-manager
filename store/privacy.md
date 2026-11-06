# Privacy policy — LHP Local Session Manager

_Last updated: 7 November 2026_

LHP Local Session Manager is an **unofficial, independent** desktop utility for
Windows. It lets you browse, search, export and clean up the session history
that Claude Code and Claude Desktop keep on your own computer. It is not made
by, affiliated with, endorsed by or sponsored by Anthropic. "Claude" is a
trademark of Anthropic.

This policy describes the Microsoft Store edition. The same open-source project
is also published as Setup and Portable builds on GitHub. Where those builds
behave differently, this page says so.

## In short

- Everything is processed on your computer. There is no account and no server.
- The app does not collect or send your session content, prompts, file paths or
  usage data.
- There is no telemetry, analytics, advertising or crash reporting.

## What the app accesses on your computer

- **Claude Code session files** in your user profile:
  `%USERPROFILE%\.claude\projects` (transcripts and session folders),
  `file-history`, `session-env` and `sessions` (which sessions are open right
  now). These files can contain your prompts, the assistant's replies, code,
  file paths, project names and git branch names.
- **Claude Desktop session metadata**: the `claude-code-sessions` folder under
  `%APPDATA%\Claude`, or under the Claude package folder in
  `%LOCALAPPDATA%\Packages`. These files contain session titles, session IDs,
  the project folder path, the model name, dates and the archive flag.
- **Running processes** named `claude`, `node` or `bun`: name, executable path,
  command line and start time. This is a local, read-only Windows query.
- **The paths of your project folders**, as recorded in the session files. The
  app does not read the files inside your projects.

## Why the app accesses it

- To list, search and group your sessions, and to show their details and size
  on disk.
- To detect sessions that are in use, so that they are never changed while a
  program has them open.
- To build an exact list of files for you to review before anything is deleted,
  and to make sure project folders are never part of it.
- To export a session when you ask for it.

## What the app stores

The app keeps its own data in its app data folder,
`%APPDATA%\LHP Local Session Manager`. In the Microsoft Store edition, Windows
keeps this folder in the app's private package storage and removes it when you
uninstall the app.

- **Settings**: language, motion, refresh mode and display options.
- **The "hidden in manager" list**: the file paths of the sessions you chose to
  hide in this app.
- **A scan cache**: summaries of your session files so that rescans are fast.
  A summary holds the session title, the first and last prompt, counts, sizes,
  the model name and dates.
- **Log files**: what the app did and any errors. Logs can contain file paths.

The deletion safety mode is never stored: every launch starts in Safe Mode.

The app writes nothing else, except the exports you ask for and the deletions
you confirm.

## What the app transmits

- **Nothing.** The Microsoft Store edition has no update checker and sends no
  data to the developer or to anyone else.
- Updates are delivered by Microsoft Store, under Microsoft's own terms and
  privacy statement.
- *Open Microsoft Store* and *View in Microsoft Store* open the Store app, and
  only when you click them.
- GitHub Setup and Portable builds only: these builds check GitHub Releases for
  a new version at startup and when you click *Check for updates*. The request
  contains what any HTTPS download request contains (such as your IP address
  and standard headers) and no session data.

## Security and local processing

- All reading, searching and analysis happens on your computer.
- The app loads no remote content. Its user interface runs sandboxed and cannot
  access files directly: it can only ask the app for named operations on
  sessions the app itself found.
- The app starts in Safe Mode, where nothing can be deleted. Permanent deletion
  must be armed for the current run by typing `ENABLE DELETE`. It turns itself
  off after one delete or 10 minutes.
- GitHub Setup and Portable builds only: these builds have no Safe Mode.
  Permanent deletion works straight away, after the confirmation described below.
- Every delete shows the exact files that will and will not be removed, and
  needs a typed confirmation. Every path is validated again right before it is
  removed. Project folders are never deleted.
- Sessions that are open in a running program cannot be changed.

## Your controls

- **Hide in manager** removes a session from this app's list only. It changes
  none of the session's files.
- **Export** gives you a copy of a session.
- **Delete permanently** removes a session's local files after you review and
  confirm the plan.
- **Clear scan cache** in Settings removes the cached summaries.
- **Uninstalling** the Microsoft Store edition removes the app and its own
  data. It never removes your session files.

## Export and deletion

- **Export** writes a copy (JSONL, JSON or Markdown) to a folder you choose.
  The original files are only read. An export contains the session's content,
  so keep it as carefully as the original. The Microsoft Store edition does not
  export into `AppData`.
- **Permanent delete** removes the exact local files listed in the plan. Deleted
  files are not sent anywhere, and the app cannot recover them.
- **Microsoft Store edition**: sessions that have Claude Desktop metadata can
  be viewed and exported, but not archived, restored or deleted. The Microsoft
  Store edition does not modify Claude Desktop's AppData files. It may still
  write its own application data, such as settings and manager state, inside
  the app's own user-data location. Sessions that only have a transcript under
  `%USERPROFILE%\.claude` can be hidden or deleted.
- GitHub Setup and Portable builds only: these builds can also archive,
  restore and delete sessions that have Claude Desktop metadata. Doing so
  changes Claude Desktop's local metadata files on your computer.

## Children

The app is a developer utility. It collects no personal information from
anyone, including children.

## Changes to this policy

Changes are published on this page, with a new date at the top.

## Contact and support

Questions, problems and requests:
<https://github.com/lahieuphong/claude-local-session-manager/issues>
