import assert from 'node:assert/strict'

const start = process.argv[2] ?? '2026-10-29'
assert.match(start, /^\d{4}-\d{2}-\d{2}$/)
process.env.SEASON_SIM_YEAR ??= String(Number(start.slice(0, 4)) + (Number(start.slice(5, 7)) >= 7 ? 1 : 0))
const { config, season } = await import('../../scripts/season-sim/common.mjs')
assert.equal(config.project, 'pt4bafableig')
assert.equal(config.prefix, '630')
assert.ok(start > season.start && start < season.end)
process.env.SEASON_SIM_CRON_CATALOG = `${config.root}/cron-jobs.json`
const { prepareDatabaseWindow } = await import('../../scripts/season-sim/database-window.mjs')
console.log(JSON.stringify(await prepareDatabaseWindow(start)))
