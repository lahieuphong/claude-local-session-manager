# Store screenshots

Partner Center needs at least one screenshot per listing language (more are
recommended; check the current size rules there — landscape 1920×1080 or
1366×768 PNG work well).

**Never use real session data.** Real titles, prompts and paths are private.
Take screenshots with demo data in an isolated profile, e.g. a fake Claude home
created in a temporary folder and the app started with:

```powershell
$env:USERPROFILE = "$env:TEMP\clsm-demo\home"
$env:APPDATA = "$env:TEMP\clsm-demo\home\AppData\Roaming"
$env:LOCALAPPDATA = "$env:TEMP\clsm-demo\home\AppData\Local"
$env:CLAUDE_SESSION_MANAGER_USER_DATA = "$env:TEMP\clsm-demo\userdata"
yarn dev
```

Suggested set (repeat for English, Tiếng Việt and 简体中文 via Settings → Language):

1. Session list with the inspector (SAFE MODE visible in the status strip).
2. Search results.
3. Delete dialog in Safe Mode showing Will delete / Will not delete.
4. Storage overview.
5. Settings (language, deletion safety, updates managed by Microsoft Store).

Store the final images in this folder as `<locale>-<n>-<name>.png` if you want
to keep them in the repository.
