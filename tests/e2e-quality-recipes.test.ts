import { execFileSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

it('quality inventory type-checks every checked Deno recipe without running it', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pancake-evidence-gate-')))
  try {
    await mkdir(path.join(root, 'scripts'))
    await mkdir(path.join(root, 'supabase/functions/api'), { recursive: true })
    await mkdir(path.join(root, 'bin'))
    await cp('scripts/check-edge-functions.mjs', path.join(root, 'scripts/check-edge-functions.mjs'))
    await writeFile(path.join(root, 'supabase/config.toml'), '[functions.api]\n')
    await writeFile(path.join(root, 'supabase/functions/api/index.ts'), 'export {}')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {
      first: 'deno run --no-lock --check --allow-env supabase/tests/first.ts',
      second: 'deno run --check --allow-net=127.0.0.1 supabase/tests/second.ts',
      duplicate: 'deno run --check supabase/tests/first.ts',
      other: 'node scripts/other.mjs',
    } }))
    const log = path.join(root, 'invocations.json')
    const deno = path.join(root, 'bin/deno')
    await writeFile(deno, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))\n`)
    await chmod(deno, 0o700)
    execFileSync(process.execPath, [path.join(root, 'scripts/check-edge-functions.mjs'), '--inventory-only'], {
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}` },
    })
    expect(JSON.parse(await readFile(log, 'utf8'))).toEqual([
      'check', '--no-lock', 'supabase/tests/first.ts', 'supabase/tests/second.ts',
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})
