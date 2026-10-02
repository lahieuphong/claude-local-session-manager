#!/usr/bin/env node
// yarn store:check — validates the Store configuration without building:
// Partner Center identity, package version mapping and visual assets.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ROOT,
  STORE_ASSETS,
  STORE_LANGUAGE_MAP,
  identityHelp,
  loadStoreIdentity,
  packageFamilyName,
  toStorePackageVersion,
  validateStoreIdentity
} from './store-config.mjs'

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
let ok = true
console.log(`Version: package.json ${pkg.version} → Store package ${toStorePackageVersion(pkg.version)}`)
console.log(`Languages: ${Object.entries(STORE_LANGUAGE_MAP).map(([ui, win]) => `${ui}→${win}`).join(', ')}`)

for (const [name, [w, h]] of Object.entries(STORE_ASSETS)) {
  const file = path.join(ROOT, 'build', 'appx', name)
  if (!existsSync(file)) {
    console.error(`Asset missing: build/appx/${name} (run \`yarn icon\`)`)
    ok = false
    continue
  }
  const ihdr = readFileSync(file).subarray(16, 24)
  if (ihdr.readUInt32BE(0) !== w || ihdr.readUInt32BE(4) !== h) {
    console.error(`Asset size wrong: build/appx/${name} (run \`yarn icon\`)`)
    ok = false
  }
}
if (ok) console.log(`Assets: ${Object.keys(STORE_ASSETS).length} present with exact sizes`)

const identity = loadStoreIdentity()
const errors = validateStoreIdentity(identity)
if (errors.length) {
  console.error('\n' + identityHelp(errors))
  process.exit(2)
}
console.log('Identity: complete (values come from Partner Center; the Store verifies them on upload)')
console.log(`  Identity Name     : ${identity.identityName}`)
console.log(`  Publisher         : ${identity.publisher}`)
console.log(`  PackageFamilyName : ${packageFamilyName(identity.identityName, identity.publisher)} (derived)`)
console.log('  → must equal Partner Center → Product identity → Package/Identity/PackageFamilyName')
process.exit(ok ? 0 : 1)
