import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function buildFixture(directory, name) {
  const checkout = path.join(directory, name)
  const scripts = path.join(checkout, 'scripts/ios-sim')
  await mkdir(scripts, { recursive: true })
  await mkdir(path.join(checkout, 'public'))
  await mkdir(path.join(checkout, 'core'))
  await writeFile(path.join(checkout, 'screen.tsx'), name)
  await writeFile(path.join(checkout, 'core/index.ts'), `core-${name}`)
  await writeFile(path.join(checkout, 'package-lock.json'), '{}')
  await writeFile(path.join(checkout, 'public/manifest.json'), '{}')
  await cp('scripts/ios-sim/build.mjs', path.join(scripts, 'build.mjs'))
  const common = (await readFile('scripts/ios-sim/common.mjs', 'utf8'))
    .replace(/export const home = .*/, `export const home = ${JSON.stringify(path.join(directory, 'shared'))}`)
    .replace('export function run(', 'function realRun(')
  await writeFile(path.join(scripts, 'common.mjs'), `${common}\nexport async function run(command, argv = [], options = {}) {
    if (command === 'git') return argv[0] === 'ls-files' ? ['screen.tsx', 'core/index.ts', 'package-lock.json', 'public/manifest.json'].join('\\0') : 'fixture-head'
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
  }\n`)
  return { checkout, build: await import(pathToFileURL(path.join(scripts, 'build.mjs')).href) }
}
