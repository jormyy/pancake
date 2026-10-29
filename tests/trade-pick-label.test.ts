import { describe, expect, it } from 'vitest'
import { tradePickLabel, tradePickContext } from '@/lib/trade-pick-label'

const memberNames = { matthew: 'Matthew', justin: 'Justin', mike: "Mike's Minions" }
const members = Object.keys(memberNames) as (keyof typeof memberNames)[]
const cases = members.flatMap(original => members.flatMap(owner => members.filter(recipient => recipient !== owner).flatMap(recipient =>
    [...members, 'observer'].map(viewer => ({ original, owner, recipient, viewer,
        expected: `2028 Round 1 (orig. ${memberNames[original]}) — from ${viewer === owner ? 'You' : memberNames[owner]} → to ${viewer === recipient ? 'You' : memberNames[recipient]}`,
    })),
)))

describe('trade pick labels', () => {
    it.each(cases)('$viewer views original $original, owner $owner, recipient $recipient', ({ original, owner, recipient, viewer, expected }) => {
        expect(tradePickLabel({ kind: 'pick', pickId: 'pick', seasonYear: 2028, round: 1,
            originalTeamName: memberNames[original], fromMemberId: owner, toMemberId: recipient,
        }, { viewerMemberId: viewer, memberNames })).toBe(expected)
    })

    it('omits the route when a receive or give section already supplies it', () => {
        expect(tradePickLabel({ kind: 'pick', pickId: 'pick', seasonYear: 2030, round: 1,
            originalTeamName: 'Trade Team 1', fromMemberId: 'matthew', toMemberId: 'justin',
        }, { viewerMemberId: 'matthew', memberNames }, false)).toBe('2030 Round 1 (orig. Trade Team 1)')
    })

    it('does not infer identity from equal team names', () => {
        expect(tradePickLabel({ kind: 'pick', pickId: 'pick', seasonYear: 2028, round: 1, originalTeamName: 'Matthew', fromMemberId: 'mike', toMemberId: 'justin' },
            { viewerMemberId: 'matthew', memberNames: { matthew: 'Matthew', mike: 'Matthew', justin: 'Justin' } }))
            .toBe('2028 Round 1 (orig. Matthew) — from Matthew → to Justin')
    })

    it('never guesses You for missing member IDs', () => {
        expect(tradePickLabel({ kind: 'pick', pickId: 'pick', seasonYear: 2028, round: 1, originalTeamName: 'Matthew' },
            { viewerMemberId: '', memberNames: { '': 'You' } }))
            .toBe('2028 Round 1 (orig. Matthew) — from Unknown team → to Unknown team')
    })

    it('resolves legacy two-team trades and additional participants by ID', () => {
        expect(tradePickContext({ proposerMemberId: 'matthew', proposerTeamName: 'Matthew', recipientMemberId: 'justin', recipientTeamName: 'Justin',
            participants: [{ memberId: 'mike', teamName: "Mike's Minions", sortOrder: 2, isInitiator: false, acceptedAt: null }],
        }, 'justin')).toEqual({ viewerMemberId: 'justin', memberNames })
    })
})
