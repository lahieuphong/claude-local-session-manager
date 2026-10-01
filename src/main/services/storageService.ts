import type { ProjectUsage, ScanSnapshot, StorageInfo } from '../../shared/types'

export function computeStorageInfo(snapshot: ScanSnapshot, cachePath: string): StorageInfo {
  const s = snapshot.sessions
  const projects = new Map<string, ProjectUsage>()
  for (const x of s) {
    const p = projects.get(x.projectKey) ?? {
      projectKey: x.projectKey,
      projectName: x.projectName,
      projectPath: x.projectPath,
      sessions: 0,
      totalSize: 0
    }
    p.sessions++
    p.totalSize += x.totalSize
    projects.set(x.projectKey, p)
  }
  return {
    totalSessions: s.length,
    active: s.filter((x) => !x.archived && x.status !== 'orphan' && x.status !== 'metadata-only').length,
    archived: s.filter((x) => x.archived).length,
    transcriptOnly: s.filter((x) => x.status === 'transcript-only').length,
    metadataOnly: s.filter((x) => x.status === 'metadata-only').length,
    orphan: s.filter((x) => x.status === 'orphan').length,
    problems: s.filter((x) => x.problems.length > 0).length,
    totalSize: s.reduce((n, x) => n + x.totalSize, 0),
    transcriptBytes: s.reduce((n, x) => n + (x.transcriptSize ?? 0), 0),
    sessionDataBytes: s.reduce((n, x) => n + (x.sessionDataSize ?? 0), 0),
    otherBytes: s.reduce((n, x) => n + (x.otherSize ?? 0) + (x.metadataSize ?? 0), 0),
    topProjects: [...projects.values()].sort((a, b) => b.totalSize - a.totalSize).slice(0, 10),
    largestSessions: [...s]
      .sort((a, b) => b.totalSize - a.totalSize)
      .slice(0, 10)
      .map(({ id, displayTitle, projectName, totalSize, status }) => ({ id, displayTitle, projectName, totalSize, status })),
    roots: snapshot.roots,
    cachePath,
    scannedAt: snapshot.scannedAt
  }
}
