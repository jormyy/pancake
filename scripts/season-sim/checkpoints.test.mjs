import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('snapshot writes use the launcher root set after static module imports', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'season-sim-snapshot-')))
  try {
    const root = path.join(directory, 'lane')
    const oldRoot = path.join(directory, 'old')
    const nextRoot = path.join(directory, 'next')
    await mkdir(path.join(root, 'repo'), { recursive: true })
    await mkdir(path.join(oldRoot, 'waiver-week'), { recursive: true })
    await writeFile(path.join(oldRoot, 'waiver-week/sentinel'), 'retained')
    const program = `
      const { saveSnapshot } = await import(${JSON.stringify(new URL('./checkpoints.mjs', import.meta.url).href)})
      process.env.SEASON_SIM_SNAPSHOT_ROOT = ${JSON.stringify(nextRoot)}
      try { await saveSnapshot('waiver-week', {}) }
      catch (error) { console.log(JSON.stringify({ code: error.code, path: error.path })) }
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: path.join(root, 'repo'), encoding: 'utf8',
      env: { ...process.env, SEASON_SIM_ROOT: root, SEASON_SIM_SNAPSHOT_ROOT: oldRoot },
    })
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(child.stdout)
    assert.equal(result.code, 'ENOENT', 'The first read must reach the scratch clock, rather than collide with retained snapshots')
    assert.equal(result.path, path.join(root, 'state/clock.json'))
    assert.ok((await stat(path.join(nextRoot, 'waiver-week'))).isDirectory())
    assert.equal(await readFile(path.join(oldRoot, 'waiver-week/sentinel'), 'utf8'), 'retained')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
