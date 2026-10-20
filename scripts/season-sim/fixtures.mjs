import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { sha256 } from './common.mjs'

export async function fixtureStore(directory) {
  const records = (await readFile(path.join(directory, 'manifest.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const manifest = new Map(records.map(row => [row.key, row]))
  return {
    manifest,
    async bytes(key) {
      const row = manifest.get(key)
      assert.equal(row?.status, 200, `Unavailable historical source: ${key}`)
      assert.equal(path.basename(row.file), row.file, 'Fixture filenames must not escape their directory')
      const bytes = gunzipSync(await readFile(path.join(directory, row.file)))
      assert.equal(sha256(bytes), row.sha256, `Historical source hash mismatch: ${key}`)
      return bytes
    },
    async json(key) { return JSON.parse((await this.bytes(key)).toString('utf8')) },
  }
}
