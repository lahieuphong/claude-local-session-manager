// Read-only inspection of a built AppX package and its manifest (used by
// dist-store.mjs and tests). No dependencies: lists the zip central directory
// and checks the manifest text with explicit expectations.
import { readFileSync } from 'node:fs'
import { STORE_APPLICATION_ID, STORE_LANGUAGE_MAP, packageFamilyName } from './store-config.mjs'

/** File names inside a zip/appx (central directory only; nothing is extracted). */
export function listZipEntries(buffer) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip/appx file (no end of central directory)')
  let count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  // ZIP64 (large packages): read the real values from the ZIP64 end record.
  if (count === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20
    if (buffer.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip64 locator missing')
    const rec = Number(buffer.readBigUInt64LE(loc + 8))
    count = Number(buffer.readBigUInt64LE(rec + 32))
    offset = Number(buffer.readBigUInt64LE(rec + 48))
  }
  const names = []
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory entry')
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLen))
    offset += 46 + nameLen + extraLen + commentLen
  }
  return names
}

export function inspectAppx(file) {
  const entries = listZipEntries(readFileSync(file)).map((n) => decodeURIComponent(n).replace(/\//g, '\\'))
  return { entries }
}

const attr = (xml, element, name) => new RegExp(`<${element}\\b[^>]*\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(xml)?.[1]
const text = (xml, element) => new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml)?.[1]

/** Explicit checks of the fields that matter for the Store; returns a printable review. */
export function reviewManifest(xml, { identity, storeVersion, assets = [], entries = null }) {
  const capabilities = [...xml.matchAll(/<(?:\w+:)?Capability\s+Name="([^"]+)"/g)].map((m) => m[1])
  const languages = [...xml.matchAll(/<Resource\s+Language="([^"]+)"/g)].map((m) => m[1])
  const fields = {
    'Identity Name': attr(xml, 'Identity', 'Name'),
    Publisher: attr(xml, 'Identity', 'Publisher'),
    Version: attr(xml, 'Identity', 'Version'),
    ProcessorArchitecture: attr(xml, 'Identity', 'ProcessorArchitecture'),
    DisplayName: text(xml, 'DisplayName'),
    PublisherDisplayName: text(xml, 'PublisherDisplayName'),
    TargetDeviceFamily: `${attr(xml, 'TargetDeviceFamily', 'Name')} ${attr(xml, 'TargetDeviceFamily', 'MinVersion')}–${attr(xml, 'TargetDeviceFamily', 'MaxVersionTested')}`,
    'Application Id': attr(xml, 'Application', 'Id'),
    EntryPoint: attr(xml, 'Application', 'EntryPoint'),
    Executable: attr(xml, 'Application', 'Executable'),
    Capabilities: capabilities.join(', '),
    Languages: languages.join(', '),
    FileSystemWriteVirtualization: text(xml, 'desktop6:FileSystemWriteVirtualization') ?? '(not set)'
  }
  const name = fields['Identity Name']
  const publisher = fields.Publisher
  fields['PackageFamilyName (derived)'] = name && publisher ? packageFamilyName(name, publisher) : undefined
  const checks = [
    ['Identity Name matches the configured identity', fields['Identity Name'] === identity.identityName],
    ['Publisher matches the configured identity', fields.Publisher === identity.publisher],
    ['PublisherDisplayName matches', fields.PublisherDisplayName === identity.publisherDisplayName],
    ['DisplayName matches', fields.DisplayName === identity.displayName],
    [`Version is ${storeVersion} (4th part 0)`, fields.Version === storeVersion && /\.0$/.test(fields.Version ?? '')],
    ['ProcessorArchitecture is x64', fields.ProcessorArchitecture === 'x64'],
    ['TargetDeviceFamily is Windows.Desktop', attr(xml, 'TargetDeviceFamily', 'Name') === 'Windows.Desktop'],
    ['Full-trust desktop entry point', fields.EntryPoint === 'Windows.FullTrustApplication'],
    [`Application Id is ${STORE_APPLICATION_ID}`, fields['Application Id'] === STORE_APPLICATION_ID],
    ['runFullTrust capability present', capabilities.includes('runFullTrust')],
    [
      'No capabilities besides runFullTrust + unvirtualizedResources',
      capabilities.every((c) => c === 'runFullTrust' || c === 'unvirtualizedResources')
    ],
    ['AppData write virtualization disabled', fields.FileSystemWriteVirtualization === 'disabled'],
    [`Languages ${Object.values(STORE_LANGUAGE_MAP).join(', ')}`, JSON.stringify(languages) === JSON.stringify(Object.values(STORE_LANGUAGE_MAP))],
    ['No auto-start, protocol or file-type extensions', !/<Extensions>/.test(xml)]
  ]
  if (entries) {
    const has = (p) => entries.some((e) => e.toLowerCase() === p.toLowerCase())
    checks.push(['Package contains AppxManifest.xml', has('AppxManifest.xml')])
    checks.push([`Package contains ${fields.Executable}`, !!fields.Executable && has(fields.Executable)])
    for (const a of assets) checks.push([`Asset ${a}`, has(`assets\\${a}`)])
    checks.push(['No GitHub updater config (app-update.yml) in the package', !entries.some((e) => /app-update\.yml$/i.test(e))])
  }
  const lines = ['MANIFEST REVIEW', ...Object.entries(fields).map(([k, v]) => `  ${k.padEnd(30)} ${v ?? '(missing)'}`), '', 'CHECKS']
  for (const [label, ok] of checks) lines.push(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  return { ok: checks.every(([, ok]) => ok), fields, text: lines.join('\n') }
}
