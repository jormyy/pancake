import { expect, it } from 'vitest'
import { repositoryPublicationTables } from '../helpers/realtime-publication'
import { assertRealtimePublication } from '../../scripts/season-sim/realtime-probe.mjs'

it('accepts the canonical client publication and rejects missing or extra tables', () => {
  const published = repositoryPublicationTables()
  expect(published).toHaveLength(16)
  expect(() => assertRealtimePublication(published)).not.toThrow()
  expect(() => assertRealtimePublication(published.slice(1))).toThrow('committed client publication')
  expect(() => assertRealtimePublication([...published, 'unused_table'].sort())).toThrow('committed client publication')
})
