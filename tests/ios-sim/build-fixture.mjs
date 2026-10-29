import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function buildFixture(directory, name, url = 'http://127.0.0.1:57121') {
  const checkout = path.join(directory, name)
  const scripts = path.join(checkout, 'scripts/ios-sim')
  await mkdir(scripts, { recursive: true })
  await mkdir(path.join(checkout, 'public'))
  await mkdir(path.join(checkout, 'core'))
  await writeFile(path.join(checkout, 'screen.tsx'), name)
  await writeFile(path.join(checkout, 'core/index.ts'), `core-${name}`)
  await writeFile(path.join(checkout, 'package-lock.json'), '{}')
  for (const file of ['app.json', 'package.json', 'vercel.json']) await writeFile(path.join(checkout, file), '{}')
  await writeFile(path.join(checkout, 'public/manifest.json'), '{}')
  await cp('public/sw.js', path.join(checkout, 'public/sw.js'))
  await cp('scripts/ios-sim/build.mjs', path.join(scripts, 'build.mjs'))
  await cp('scripts/ios-sim/recorder.mjs', path.join(scripts, 'recorder.mjs'))
  await cp('scripts/retain-release-assets.mjs', path.join(checkout, 'scripts/retain-release-assets.mjs'))
  await cp('scripts/stamp-release-provenance.mjs', path.join(checkout, 'scripts/stamp-release-provenance.mjs'))
  await cp('scripts/compact-document-assets.mjs', path.join(checkout, 'scripts/compact-document-assets.mjs'))
  await mkdir(path.join(checkout, 'tests/e2e'), { recursive: true })
  for (const file of ['release-provenance.mjs', 'release-artifact.mjs', 'pwa-update-release.mjs']) await cp(`tests/e2e/${file}`, path.join(checkout, 'tests/e2e', file))
  const common = (await readFile('scripts/ios-sim/common.mjs', 'utf8'))
    .replace(/export const home = .*/, `export const home = ${JSON.stringify(path.join(directory, 'shared'))}`)
    .replace("export const apiUrl = 'http://127.0.0.1:57121'", `export const apiUrl = ${JSON.stringify(url)}`)
    .replace('export function run(', 'function realRun(')
  await writeFile(path.join(scripts, 'common.mjs'), `${common}\nexport async function run(command, argv = [], options = {}) {
    if (command === 'git') return argv[0] === 'ls-files' ? ['screen.tsx', 'core/index.ts', 'app.json', 'package.json', 'vercel.json', 'package-lock.json', 'public/manifest.json', 'public/sw.js'].join('\\0') : '1234567890abcdef1234567890abcdef12345678'
    if (command === 'npm') return ''
    if (command !== 'node') return realRun(command, argv, options)
    const marker = await readFile(path.join(options.cwd, 'screen.tsx'), 'utf8')
    await writeFile(path.join(home, 'export-started'), marker)
    await pause(500)
    const after = await readFile(path.join(options.cwd, 'screen.tsx'), 'utf8')
    const core = await readFile(path.join(options.cwd, 'core/index.ts'), 'utf8')
    const root = argv.at(-1)
    await mkdir(path.join(root, '_expo/static/js/web'), { recursive: true })
    await writeFile(path.join(root, '_expo/static/js/web/app.js'), [marker, after, core, options.env.EXPO_PUBLIC_SUPABASE_URL, options.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY].join('\\n'))
    for (const file of ['index.html', 'sign-in.html']) await writeFile(path.join(root, file), '<html><head><meta name="pancake-release" content="pancake-build"><script src="/_expo/static/js/web/app.js"></script></head><body>Fixture</body></html>')
  }\n`)
  return { checkout, build: await import(pathToFileURL(path.join(scripts, 'build.mjs')).href) }
}
