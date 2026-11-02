import { beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
    actor: '11111111-1111-1111-1111-111111111111', league: '22222222-2222-2222-2222-222222222222', matchup: '33333333-3333-3333-3333-333333333333',
    rpc: vi.fn(), from: vi.fn(),
}))
vi.mock('../../supabase/functions/_shared/apiRuntime.ts', () => ({
    json: (value: unknown) => Response.json(value), requireUser: async () => 'user',
    throwDb: (error: { message: string }) => { throw new Error(error.message) },
    assertUuid: (value: string) => { if (!/^[\da-f-]{36}$/.test(value)) throw new Error('Invalid matchupId') },
    NotFoundError: class extends Error {},
}))
vi.mock('../../supabase/functions/_shared/views.ts', () => ({
    screenViews: { home: 'view_home' }, viewClient: () => ({ rpc: fixture.rpc, from: fixture.from }),
    viewRequest: (url: URL) => ({ p_league_id: fixture.league, p_member_id: fixture.actor, p_params: JSON.parse(url.searchParams.get('params') ?? '{}') }),
}))
vi.mock('../../supabase/functions/api/tradeEstimates.ts', () => ({ createTradeEstimate: vi.fn() }))
const routeModule = '../../supabase/functions/api/views/index.ts'
const { handleViewRoute } = await import(routeModule) as { handleViewRoute: (request: Request, path: string) => Promise<Response | null> }

beforeEach(() => {
    vi.clearAllMocks()
    fixture.rpc.mockImplementation(async (name, args) => {
        if (name === 'view_home') return { data: { context: { seasonId: 'season', seasonYear: 2026, weekNumber: 1 }, selectedDate: '2026-10-27', matchup: { id: fixture.matchup, myMemberId: 'home', opponentMemberId: 'away' }, myLineup: { starters: ['home'] }, oppLineup: { starters: ['away'] } } }
        if (name === 'view_standings') return { data: { standings: [] } }
        if (name === 'get_matchup_forecast') return { data: { matchupId: fixture.matchup } }
        return { data: { starters: [args.p_params.targetMemberId], bench: [], weekDays: [], liveStats: {} } }
    })
    const query = { select: vi.fn(), eq: vi.fn(), single: vi.fn(async () => ({ data: { week_number: 1, end_week_number: null, winner_member_id: null } })) }
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query)
    fixture.from.mockReturnValue(query)
})
const request = (matchupId?: string) => new Request(`http://127.0.0.1/views/home?params=${encodeURIComponent(JSON.stringify(matchupId ? { matchupId } : {}))}`)
it('serves the complete parameterised view through one authorized database read', async () => {
    const response = await handleViewRoute(request(fixture.matchup), '/views/home')
    const result = await response!.json()
    expect(result.view.matchup).toMatchObject({ id: fixture.matchup, myMemberId: 'home', opponentMemberId: 'away' })
    expect(fixture.rpc).toHaveBeenCalledExactlyOnceWith('view_home', {
        p_league_id: fixture.league, p_member_id: fixture.actor, p_params: { matchupId: fixture.matchup },
    })
    expect(fixture.from).not.toHaveBeenCalled()
    expect(result.view.myLineup.starters).toEqual(['home'])
    expect(result.view.oppLineup.starters).toEqual(['away'])
})
it('leaves the existing Home read unchanged', async () => {
    await handleViewRoute(request(), '/views/home')
    expect(fixture.rpc).toHaveBeenCalledOnce()
    expect(fixture.rpc.mock.calls[0][0]).toBe('view_home')
})
it('rejects another league or week before requesting a target lineup', async () => {
    fixture.rpc.mockResolvedValue({ data: { matchup: null } })
    await expect(handleViewRoute(request('44444444-4444-4444-4444-444444444444'), '/views/home')).rejects.toThrow('not available')
    expect(fixture.rpc).toHaveBeenCalledOnce()
    expect(fixture.from).not.toHaveBeenCalled()
})
it('propagates view errors without returning a partial view', async () => {
    fixture.rpc.mockResolvedValue({ error: { message: 'Unavailable' } })
    await expect(handleViewRoute(request(fixture.matchup), '/views/home')).rejects.toThrow('Unavailable')
})
