// Synthetic stress profile for the full UI test (scripts/ui-test.mjs).
//
// Real session files in a throw-away user folder, in Claude Code's and Claude
// Desktop's on-disk format, chosen to make the interface work hard: many projects
// (the sidebar must scroll), long unbroken titles, Vietnamese and Chinese names,
// sessions with and without Desktop metadata, archived sessions, broken metadata,
// a running session. Nothing here comes from a real user:
//   sessions  c0ffee00-0000-4000-8000-0000000000NN
//   projects  C:\UiTest\… (never created)
// It refuses to write into a real profile.
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MIN = 60_000
const KB = 1024

/** Marker file: a folder with it was written by this script and may be replaced or removed by it. */
export const UI_TEST_MARKER = '.ui-test-profile'
export const uiUuid = (n) => `c0ffee00-0000-4000-8000-${String(n).padStart(12, '0')}`
/** Every session of the profile matches this; anything else means the app is reading real data. */
export const UI_UUID_RE = /^c0ffee00-0000-4000-8000-\d{12}$/

export const LONG_TITLE_EN = 'Refactor the authentication flow across every service and keep the existing sessions valid while the new token store is rolled out to production'
export const LONG_TITLE_VI = 'Tối ưu hóa toàn bộ quy trình dựng mô hình ba chiều cho nhà hát thành phố và kiểm tra lại hiệu năng trên những máy cấu hình thấp trước khi bàn giao'
export const LONG_TITLE_ZH = '重构本地会话管理器的身份验证流程并确保现有会话在新的令牌存储上线期间继续有效同时检查所有界面文字是否显示完整没有被裁剪或重叠'
export const UNBROKEN_TITLE = `src/renderer/src/components/${'VeryLongComponentNameWithoutAnySpaces'.repeat(4)}.tsx`

/** 30 workspaces: more than any sidebar height can show, so the project list has to scroll. */
const PROJECT_PATHS = [
  'C:\\UiTest\\185',
  'C:\\UiTest\\OCR',
  'C:\\UiTest\\Photobooth',
  'C:\\UiTest\\TuTienHTML',
  'C:\\UiTest\\3d-cinema',
  'C:\\UiTest\\CMS',
  'C:\\UiTest\\TP-Remote',
  'C:\\UiTest\\AppMobileDuLich',
  'C:\\UiTest\\BTMT-V2',
  'C:\\UiTest\\claude-local-session-manager-with-a-very-long-folder-name-for-truncation',
  'C:\\UiTest\\dalangv2',
  'C:\\UiTest\\hongvan-3d-nhahat',
  'C:\\UiTest\\hongvan-homepage',
  'C:\\UiTest\\hongvan-zyvantex',
  'C:\\UiTest\\discord-bot',
  'C:\\UiTest\\extracted',
  'C:\\UiTest\\tp-remote-win-qa',
  'C:\\UiTest\\tp3d-vn-v2',
  'C:\\UiTest\\TuTienHTML_r3',
  'C:\\UiTest\\Dự án nhà hát thành phố Hồ Chí Minh bản thử nghiệm ba chiều',
  'C:\\UiTest\\本地会话管理器的中文长名称测试目录',
  'D:\\Folder With Spaces\\Another Folder With Spaces\\Yet Another One',
  'C:\\UiTest\\alpha',
  'C:\\UiTest\\beta',
  'C:\\UiTest\\gamma',
  'C:\\UiTest\\delta',
  'C:\\UiTest\\epsilon',
  'C:\\UiTest\\zeta',
  'C:\\UiTest\\eta',
  'C:\\UiTest\\theta'
]

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const NEUTRAL_TITLES = ['Fix build pipeline', 'Review API performance', 'Update dashboard layout', 'Database migration review', 'Add dark mode color tokens', 'Write integration tests', 'Document REST endpoints', 'Audit color contrast']
const FILLER = 'Applied the change, ran the checks again and they pass. '
const filler = (bytes) => FILLER.repeat(Math.ceil(bytes / FILLER.length)).slice(0, Math.max(0, Math.round(bytes)))
/** Claude Code stores a workspace under projects/<cwd with every non-alphanumeric character as "-">. */
const projectDirName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

function assertSafeTarget(home) {
  const target = path.resolve(home)
  const real = path.resolve(process.env.USERPROFILE || os.homedir())
  if (target.toLowerCase() === real.toLowerCase()) throw new Error('Refusing to write UI test data into your real user profile')
  const claudeHome = path.join(target, '.claude')
  if (existsSync(claudeHome) && !existsSync(path.join(claudeHome, UI_TEST_MARKER))) {
    throw new Error(`${claudeHome} already exists and was not created by this script; choose an empty folder`)
  }
}

function write(file, content, mtime) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  utimesSync(file, mtime, mtime)
}

function transcript({ uuid, cwd, title, model, turns, bytes, first, last }) {
  const base = { sessionId: uuid, ...(cwd ? { cwd, gitBranch: 'feature/ui-test', version: '2.1.295', entrypoint: 'cli' } : {}) }
  const lines = []
  for (let turn = 0; turn < turns; turn++) {
    const timestamp = new Date(first + ((last - first) * turn) / Math.max(1, turns - 1)).toISOString()
    // No prompt at all for a session without a title: otherwise the first prompt would become its title.
    if (title) lines.push({ type: 'user', message: { role: 'user', content: `${title} (step ${turn + 1})` }, timestamp, ...base })
    lines.push({ type: 'assistant', message: { id: `msg_ui_${uuid}_${turn}`, model, role: 'assistant', content: [{ type: 'text', text: filler(bytes / turns) }] }, timestamp, ...base })
  }
  if (title) lines.push({ type: 'ai-title', aiTitle: title, sessionId: uuid })
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

/**
 * Write the profile under `home`: `<home>\.claude\…` and the Claude Desktop metadata
 * in `<home>\AppData\Roaming\Claude\claude-code-sessions\…`. `livePid` is the process
 * registered as "running" for one session (its name must look like node or claude).
 * Returns what was written, including the sessions the test looks up by role.
 */
export function writeUiTestProfile(home, { now = Date.now(), livePid } = {}) {
  assertSafeTarget(home)
  const root = path.resolve(home)
  const claudeHome = path.join(root, '.claude')
  const projects = path.join(claudeHome, 'projects')
  const liveDir = path.join(claudeHome, 'sessions')
  const orgDir = path.join(root, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions', 'acct-ui-test', 'org-ui-test')
  mkdirSync(liveDir, { recursive: true })
  mkdirSync(orgDir, { recursive: true })
  writeFileSync(path.join(claudeHome, UI_TEST_MARKER), 'Synthetic data written by scripts/ui-test-profile.mjs. Safe to delete.\n')

  const roles = { metadataFiles: {} }
  let n = 0
  /** Sessions are at least 10 minutes old: the delete guard refuses files written in the last 30 seconds. */
  const addTranscript = ({ project, title, turns = 3, bytes = 40 * KB, ageMin, withData = false }) => {
    n += 1
    const uuid = uiUuid(n)
    const cwd = project === null ? undefined : project
    const last = now - (ageMin ?? 10 + n * 73) * MIN
    const mtime = new Date(last)
    const dir = path.join(projects, cwd ? projectDirName(cwd) : 'C--UiTest-unknown-folder')
    write(path.join(dir, `${uuid}.jsonl`), transcript({ uuid, cwd, title, model: MODELS[n % MODELS.length], turns, bytes, first: last - 40 * MIN, last }), mtime)
    if (withData) {
      write(path.join(dir, uuid, 'tool-results', 'result-001.txt'), filler(12 * KB), mtime)
      write(path.join(dir, uuid, 'subagents', 'agent-a1.jsonl'), '{}\n', mtime)
      write(path.join(claudeHome, 'file-history', uuid, 'file01@v1'), filler(4 * KB), mtime)
      write(path.join(claudeHome, 'session-env', uuid, 'env.json'), JSON.stringify({ note: 'synthetic UI test data' }), mtime)
    }
    return { uuid, last }
  }
  const addMetadata = (uuid, { cwd, title, archived, last }) => {
    const localId = uuid.replace('c0ffee00', 'dec0de00')
    const file = path.join(orgDir, `local_${localId}.json`)
    write(
      file,
      JSON.stringify({ sessionId: `local_${localId}`, processName: 'claude-code', cliSessionId: uuid, cwd, userSelectedFolders: [cwd], resolvedFolderKinds: ['host'], createdAt: last - 40 * MIN, lastActivityAt: last, model: 'claude-opus-5-5', permissionMode: 'default', isArchived: archived, title, userApprovedFileAccessPaths: [] }),
      new Date(last)
    )
    roles.metadataFiles[uuid] = file
  }

  // The hard titles come first, with fixed roles.
  roles.longEn = addTranscript({ project: PROJECT_PATHS[9], title: LONG_TITLE_EN, ageMin: 15, withData: true, bytes: 300 * KB }).uuid
  roles.longVi = addTranscript({ project: PROJECT_PATHS[19], title: LONG_TITLE_VI, ageMin: 25, withData: true }).uuid
  roles.longZh = addTranscript({ project: PROJECT_PATHS[20], title: LONG_TITLE_ZH, ageMin: 35 }).uuid
  roles.unbroken = addTranscript({ project: PROJECT_PATHS[21], title: UNBROKEN_TITLE, ageMin: 45, withData: true }).uuid
  // No title at all, and no working folder (the project cannot be resolved).
  roles.untitled = addTranscript({ project: PROJECT_PATHS[0], title: null, ageMin: 55 }).uuid
  roles.noProject = addTranscript({ project: null, title: 'Session without a known working folder', ageMin: 65 }).uuid

  // Transcript-only sessions in every project.
  PROJECT_PATHS.forEach((project, i) => {
    addTranscript({ project, title: `${NEUTRAL_TITLES[i % NEUTRAL_TITLES.length]} ${i + 1}`, withData: i % 5 === 0, bytes: (20 + i * 9) * KB })
    if (i < 8) addTranscript({ project, title: `${NEUTRAL_TITLES[(i + 3) % NEUTRAL_TITLES.length]} (follow-up ${i + 1})`, bytes: 15 * KB })
  })
  roles.disposable = uiUuid(n) // A plain transcript-only session.

  // Claude Desktop sessions: active and archived.
  roles.desktopActive = []
  roles.desktopArchived = []
  for (let i = 0; i < 6; i++) {
    const project = PROJECT_PATHS[i + 22]
    const title = `Desktop session ${i + 1}`
    const { uuid, last } = addTranscript({ project, title, withData: i === 0 })
    addMetadata(uuid, { cwd: project, title, archived: false, last })
    roles.desktopActive.push(uuid)
  }
  for (let i = 0; i < 4; i++) {
    const project = PROJECT_PATHS[i + 2]
    const title = `Archived desktop session ${i + 1}`
    const { uuid, last } = addTranscript({ project, title })
    addMetadata(uuid, { cwd: project, title, archived: true, last })
    roles.desktopArchived.push(uuid)
  }

  // Metadata without a transcript, and metadata that cannot be parsed: the "problems" view.
  n += 1
  roles.metadataOnly = uiUuid(n)
  addMetadata(roles.metadataOnly, { cwd: PROJECT_PATHS[1], title: 'Metadata without a transcript', archived: false, last: now - 500 * MIN })
  write(path.join(orgDir, 'local_dec0de00-0000-4000-8000-999999999999.json'), '{ this is not valid json', new Date(now - 600 * MIN))

  // A session that is running right now (registered to `livePid`).
  if (livePid) {
    const { uuid } = addTranscript({ project: PROJECT_PATHS[3], title: 'Session that is running right now', ageMin: 12 })
    roles.live = uuid
    roles.liveFile = path.join(liveDir, `${livePid}.json`)
    writeFileSync(roles.liveFile, JSON.stringify({ pid: livePid, sessionId: uuid, cwd: PROJECT_PATHS[3], status: 'idle', name: 'ui-test' }))
  }

  return { claudeHome, sessionFiles: n, projectCount: PROJECT_PATHS.length, roles }
}
