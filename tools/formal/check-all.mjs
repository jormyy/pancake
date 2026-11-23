#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const checks = readdirSync(here, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(here, entry.name, 'check.mjs')))
  .map((entry) => entry.name)
  .sort()

const failed = checks.filter((name) => {
  console.log(`== ${name}`)
  return spawnSync(process.execPath, [path.join(here, name, 'check.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' }).status !== 0
})
console.log(failed.length ? `FAIL ${failed.join(', ')}` : `ok ${checks.length} formal check(s)`)
process.exit(failed.length ? 1 : 0)
