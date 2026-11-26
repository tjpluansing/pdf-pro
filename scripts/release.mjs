#!/usr/bin/env node
// Release helper. See docs/RELEASING.md.
//
//   node scripts/release.mjs bump 0.2.0      set the version everywhere and date the changelog
//   node scripts/release.mjs check v0.2.0    fail unless every version file says 0.2.0
//   node scripts/release.mjs notes 0.2.0     print that version's changelog section
//   node scripts/release.mjs manifest <version> <dir> <download-url>
//                                            write <dir>/latest.json for the in-app updater
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not .pathname, so Windows gets D:\\… rather than /D:/…
const root = fileURLToPath(new URL('..', import.meta.url))
const at = (p) => join(root, p)
const read = (p) => readFileSync(at(p), 'utf8')
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/

function fail(message) {
  console.error(message)
  process.exit(1)
}

/** Every place the app's version is written down. */
const FILES = {
  'package.json': {
    get: (s) => JSON.parse(s).version,
    set: (s, v) => s.replace(/^( {2}"version": )"[^"]*"/m, `$1"${v}"`),
  },
  'package-lock.json': {
    get: (s) => JSON.parse(s).version,
    // The top-level version and the root package's entry under "packages".
    set: (s, v) => s.replace(/^( {2}"version": )"[^"]*"/m, `$1"${v}"`).replace(/("packages": \{\s*"": \{\s*"name": "pdf-pro",\s*"version": )"[^"]*"/, `$1"${v}"`),
  },
  'src-tauri/tauri.conf.json': {
    get: (s) => JSON.parse(s).version,
    set: (s, v) => s.replace(/^( {2}"version": )"[^"]*"/m, `$1"${v}"`),
  },
  'src-tauri/Cargo.toml': {
    get: (s) => s.match(/^\[package\][^[]*?^version = "([^"]*)"/ms)?.[1],
    set: (s, v) => s.replace(/^(\[package\][^[]*?^version = )"[^"]*"/ms, `$1"${v}"`),
  },
  'src-tauri/Cargo.lock': {
    get: (s) => s.match(/^name = "pdf-pro"\nversion = "([^"]*)"/m)?.[1],
    set: (s, v) => s.replace(/^(name = "pdf-pro"\nversion = )"[^"]*"/m, `$1"${v}"`),
  },
}

function versions() {
  return Object.fromEntries(Object.entries(FILES).map(([f, { get }]) => [f, get(read(f))]))
}

/** The changelog section for a version, without its heading. */
function notes(version) {
  const text = read('CHANGELOG.md')
  const start = text.match(new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?.*$`, 'm'))
  if (!start) return null
  const rest = text.slice(start.index + start[0].length)
  const end = rest.search(/^## /m)
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

const [cmd, ...args] = process.argv.slice(2)

if (cmd === 'bump') {
  const version = args[0]
  if (!SEMVER.test(version ?? '')) fail('Usage: node scripts/release.mjs bump 1.2.3')
  for (const [f, { get, set }] of Object.entries(FILES)) {
    const next = set(read(f), version)
    if (get(next) !== version) fail(`Could not set the version in ${f}`)
    writeFileSync(at(f), next)
  }
  let log = read('CHANGELOG.md')
  if (notes(version) === null) {
    const date = new Date().toISOString().slice(0, 10)
    if (!/^## Unreleased$/m.test(log)) fail('CHANGELOG.md has no "## Unreleased" section')
    log = log.replace(/^## Unreleased$/m, `## Unreleased\n\n## ${version} - ${date}`)
    writeFileSync(at('CHANGELOG.md'), log)
  }
  if (!notes(version)) console.warn(`Warning: CHANGELOG.md has nothing under ${version} yet; add the changes before tagging.`)
  console.log(`Version set to ${version}. Next:\n  git commit -am "Release ${version}" && git tag v${version} && git push origin HEAD v${version}`)
} else if (cmd === 'check') {
  const version = (args[0] ?? '').replace(/^refs\/tags\//, '').replace(/^v/, '')
  if (!SEMVER.test(version)) fail(`"${args[0]}" is not a release tag like v1.2.3`)
  const found = versions()
  const wrong = Object.entries(found).filter(([, v]) => v !== version)
  if (wrong.length) fail(`Tag says ${version}, but:\n${wrong.map(([f, v]) => `  ${f} says ${v}`).join('\n')}\nRun: node scripts/release.mjs bump ${version}`)
  if (!notes(version)) fail(`CHANGELOG.md has no notes under "## ${version}"`)
  console.log(`All version files say ${version}`)
} else if (cmd === 'notes') {
  const n = notes(args[0] ?? '')
  if (n === null) fail(`CHANGELOG.md has no section for ${args[0]}`)
  console.log(n)
} else if (cmd === 'manifest') {
  // The updater reads this file to learn the newest version, and per platform,
  // where to download it and the signature to check it against.
  const [version, dir, url] = args
  if (!SEMVER.test(version ?? '') || !dir || !url) fail('Usage: node scripts/release.mjs manifest <version> <dir> <download-url>')
  const files = readdirSync(dir)
  // The updater looks for "<os>-<arch>-<installer>" first, so people who
  // installed from the .msi stay on .msi; anything else falls back to the
  // plain "<os>-<arch>" entry.
  const PLATFORMS = [
    ['windows-x86_64', /_windows-x64-setup\.exe$/],
    ['windows-x86_64-nsis', /_windows-x64-setup\.exe$/],
    ['windows-x86_64-msi', /_windows-x64\.msi$/],
    ['darwin-aarch64', /_macos-apple-silicon\.app\.tar\.gz$/],
    ['darwin-x86_64', /_macos-intel\.app\.tar\.gz$/],
  ]
  const platforms = {}
  for (const [platform, pattern] of PLATFORMS) {
    const file = files.find((f) => pattern.test(f))
    if (!file) fail(`No ${platform} update file in ${dir}`)
    if (!existsSync(join(dir, `${file}.sig`))) fail(`${file} has no .sig; was TAURI_SIGNING_PRIVATE_KEY set for the build?`)
    platforms[platform] = {
      signature: readFileSync(join(dir, `${file}.sig`), 'utf8').trim(),
      url: `${url.replace(/\/$/, '')}/${encodeURIComponent(file)}`,
    }
  }
  const manifest = { version, notes: notes(version) ?? '', pub_date: new Date().toISOString(), platforms }
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${join(dir, 'latest.json')} for ${Object.keys(platforms).join(', ')}`)
} else {
  fail('Usage: node scripts/release.mjs bump|check|notes|manifest …')
}
