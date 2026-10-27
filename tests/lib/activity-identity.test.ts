import { describe, expect, it } from 'vitest'
import { activityPlayerMentions } from '../../lib/activity-identity'

describe('activity player identity', () => {
  it('keeps each player ID even when names match', () => {
    expect(activityPlayerMentions({ playerMentions: [{ id: 'first', name: 'Same Name' }, { id: 'second', name: 'Same Name' }, { id: 'first', name: 'Same Name' }] })).toEqual([{ id: 'first', name: 'Same Name' }, { id: 'second', name: 'Same Name' }])
  })
  it('reads saved metadata and the single-player feed shape', () => {
    expect(activityPlayerMentions({ metadata: { player_mentions: [{ id: 'saved', name: 'Saved Name' }] } })).toEqual([{ id: 'saved', name: 'Saved Name' }])
    expect(activityPlayerMentions({ playerId: 'direct', playerName: 'Direct Name' })).toEqual([{ id: 'direct', name: 'Direct Name' }])
  })
  it('ignores malformed identities without guessing from display text', () => {
    expect(activityPlayerMentions({ playerMentions: [{ id: '', name: 'Name' }, { name: 'Name' }, null], title: 'Name moved' })).toEqual([])
  })
})
