import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const evidence = process.env.NOTIF_EVIDENCE
assert.ok(evidence && path.isAbsolute(evidence) && !evidence.startsWith(process.cwd() + path.sep))
const file = 'components/settings/NotificationSwitchKeyboard.ts'
const source = readFileSync(file, 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
function oracle(name) {
    const command = ['npx', 'vitest', 'run', 'tests/web-push-settings.test.ts']
    const start = performance.now()
    const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 60000 })
    const log = path.join(evidence, name + '.log')
    writeFileSync(log, result.stdout + result.stderr)
    const record = { name, command, exit: result.status ?? -1, seconds: (performance.now() - start) / 1000, log }
    appendFileSync(path.join(evidence, 'commands.jsonl'), JSON.stringify(record) + '\n')
    return record
}
assert.equal(oracle('keyboard-mutation-baseline').exit, 0)
const mutants = [
    { id: 'N53', original: "if (event.key !== ' ') return", mutated: "if (event.key !== 'Space') return", operator: 'replace the browser Space key value with an unsupported value' },
    { id: 'N54', original: 'event.preventDefault()', mutated: '', operator: 'remove Space default-scroll prevention' },
]
const outcomes = { killed: 0, survived: 0, invalid: 0, timeout: 0, equivalent: 0 }
for (const mutant of mutants) {
    let applied = false, outcome = 'invalid', notes = ''
    const oracles = []
    try {
        assert.equal(source.split(mutant.original).length, 2)
        writeFileSync(file, source.replace(mutant.original, mutant.mutated))
        applied = true
        const result = oracle('keyboard-mutation-' + mutant.id)
        oracles.push(result)
        outcome = result.exit === 0 ? 'survived' : result.exit === -1 ? 'timeout' : 'killed'
    } catch (error) { notes = String(error) }
    finally {
        writeFileSync(file, source)
        assert.equal(hash(readFileSync(file)), hash(source))
        notes += ` Restored source SHA256: ${hash(source)}.`
    }
    const record = { id: mutant.id, area: 'notifications', file, line: source.slice(0, source.indexOf(mutant.original)).split('\n').length, symbol: 'notificationSwitchKeyboardProps', operator: mutant.operator, original: mutant.original, mutated: mutant.mutated, applied, outcome, oracles, killed_by: outcome === 'killed' ? oracles.map(result => result.name) : [], notes }
    for (const target of ['results.jsonl', '../results.jsonl', '../../results.jsonl']) appendFileSync(path.join(evidence, target), JSON.stringify(record) + '\n')
    outcomes[outcome]++
    assert.equal(oracle('keyboard-restored-' + mutant.id).exit, 0)
}
console.log(JSON.stringify({ total: mutants.length, ...outcomes }))
assert.equal(outcomes.killed, mutants.length)
