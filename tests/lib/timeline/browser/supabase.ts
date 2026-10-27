const events = [
    { id: '6', kind: 'scores.finalized', summary: 'Matchup scores finalized', reason: null, detail: {} },
    { id: '5', kind: 'lineup.auto_set', summary: 'Lineup auto-set', reason: null, detail: {} },
    { id: '4', kind: 'trade.executed', summary: 'Trade executed', reason: 'Review window completed.', detail: {} },
    { id: '3', kind: 'claim.failed', summary: 'Waiver claim failed', reason: 'Bid tied; the other team has priority.', detail: { bid_amount: 9 } },
    { id: '2', kind: 'claim.awarded', summary: 'Waiver claim awarded', reason: null, detail: { bid_amount: 17 } },
    { id: '1', kind: 'trade.countered', summary: 'Trade countered', reason: 'The other manager sent a counteroffer.', detail: {} },
].map(event => ({ ...event, createdAt: new Date(Date.now() - (7 - Number(event.id)) * 60_000).toISOString(), memberId: 'team', entityId: event.id }))

export const supabase = {
    rpc: async (_name: string, args: { p_before?: { id: string } }) => ({
        data: { events: args.p_before ? events.slice(4) : events.slice(0, 4), hasMore: !args.p_before,
            nextCursor: args.p_before ? null : { createdAt: events[3].createdAt, id: events[3].id } },
        error: null,
    }),
}
