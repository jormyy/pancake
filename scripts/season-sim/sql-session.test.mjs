import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createSqlSession } from './sql-session.mjs'

test('a failed SQL process cannot contaminate the replacement session output', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'season-sql-'))
  const file = path.join(directory, 'psql.mjs')
  const flag = path.join(directory, 'failed')
  await writeFile(file, `import{existsSync,writeFileSync}from'node:fs';import{createInterface}from'node:readline';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
  if(!line.startsWith(String.fromCharCode(92)+'echo '))return;
  if(!existsSync(process.argv[2])){writeFileSync(process.argv[2],'1');process.stdout.write('orphaned output\\n');process.exit(1)}
  process.stdout.write('[2]\\n'+line.slice(6)+'\\n');
});`)
  const session = createSqlSession(process.execPath, process.env, [file, flag])
  try {
    await assert.rejects(session.query('SELECT 1'), /Local SQL client exits 1/)
    assert.equal(await session.query('SELECT 2'), '[2]')
  } finally {
    await session.close()
    await rm(directory, { recursive: true, force: true })
  }
})
