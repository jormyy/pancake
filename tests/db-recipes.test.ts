import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
const chain = scripts['test:db'].split(' && ')

it.each([
    'pick-window', 'pick-window-cleanup', 'pick-draft-year',
    'player-data-identity', 'player-data-merges', 'player-data-career', 'player-data-prior', 'player-data-regular-season',
])('runs the %s SQL recipe exactly once in the database checks', recipe => {
    const name = `test:db:${recipe}`
    expect(scripts[name]).toBe(`psql "${'${SUPABASE_DB_URL:?SUPABASE_DB_URL is required}'}" --set ON_ERROR_STOP=1 -f tests/db/${recipe}.sql`)
    expect(chain.filter(command => command === `npm run ${name}`)).toHaveLength(1)
})

it('enables and runs the pick window harness exactly once in the database checks', () => {
    expect(scripts['test:db:pick-window-harness']).toBe('PANCAKE_PICK_WINDOW_DB_TESTS=1 npx vitest run tests/e2e/pick-window-harness.test.ts')
    expect(chain.filter(command => command === 'npm run test:db:pick-window-harness')).toHaveLength(1)
})
