import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const registrations = JSON.parse(readFileSync('scripts/mutation/post/registrations.json', 'utf8'))
const current = JSON.parse(readFileSync(process.argv[2] ?? 'package.json', 'utf8'))
const { scripts, ...otherFields } = current
if (process.argv[3]) {
  const { scripts: before, ...otherBefore } = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  assert.deepEqual(otherFields, otherBefore, 'Only scripts may change')
  const added = Object.keys(scripts).filter(name => !(name in before))
  assert.deepEqual(added.sort(), Object.values(registrations).flatMap(entries => Object.keys(entries)).sort())
  assert.equal(scripts['test:db'], before['test:db'] + Object.keys(registrations['test:db chain']).map(name => ` && npm run ${name}`).join(''))
  for (const [name, command] of Object.entries(before)) {
    if (name !== 'test:db') assert.equal(scripts[name], command, `Existing script ${name} must remain unchanged`)
  }
}
const chain = scripts['test:db'].split(/\s*&&\s*/).map(command => {
  const match = /^npm run (test:db:[\w-]+)$/.exec(command)
  assert.ok(match, `Unexpected chain command: ${command}`)
  return match[1]
})
const expected = Object.keys(registrations['test:db chain'])
for (const [group, entries] of Object.entries(registrations)) {
  for (const [name, command] of Object.entries(entries)) {
    assert.equal(scripts[name], command, `${name} command differs from its registration`)
    assert.equal(chain.filter(entry => entry === name).length, group === 'test:db chain' ? 1 : 0, name)
    const files = command.match(/\b(?:supabase\/tests|tests)\/[\w./-]+\.(?:sql|ts|mjs)\b/g)
    assert.ok(files?.length, `${name} must reference a test file`)
    for (const file of files) assert.ok(existsSync(file), `${name} references missing file ${file}`)
  }
}
for (const name of Object.keys(scripts).filter(name => name.startsWith('evidence:db:'))) {
  assert.ok(!chain.includes(name), `${name} must stay outside the chain`)
}
assert.deepEqual(chain.slice(-expected.length), expected, 'New recipes must end the chain in live, waiv, post order')
assert.ok(!Object.keys(scripts).some(name => name.includes('picks-unused-rounds')))
console.log(`${expected.length} chain registrations occur once; ${Object.keys(registrations['evidence only']).length} evidence registrations stay outside; all referenced files exist.`)
