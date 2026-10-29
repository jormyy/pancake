import { strict as assert } from 'node:assert'
import { corroborateRoster } from './rosterIdentity.ts'

Deno.test('roster bridges require unique names and teams in both independent feeds', () => {
  const nba = [{ provider_id: '10', display_name: 'Dario Šarić', nba_team: 'SAS' }]
  const espn = [{ espn_id: '20', first_name: 'Dario', last_name: 'Saric', nba_team: 'SA' }]
  assert.deepEqual(corroborateRoster(nba, espn), [{ ...nba[0], espn_id: '20' }])
  assert.deepEqual(corroborateRoster(nba, [{ ...espn[0], nba_team: 'BOS' }]), [])
  assert.deepEqual(corroborateRoster([...nba, { ...nba[0], provider_id: '11' }], espn), [])
  assert.deepEqual(corroborateRoster(nba, [...espn, { ...espn[0], espn_id: '21' }]), [])
  assert.deepEqual(corroborateRoster(nba, [{ ...espn[0], last_name: 'Saric Jr.' }]), [])
})
