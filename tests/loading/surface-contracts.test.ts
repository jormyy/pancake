import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

const read = (path: string) => readFile(path, 'utf8')
it.each([
    'app/(tabs)/index.tsx', 'app/(tabs)/roster.tsx', 'app/(tabs)/players.tsx',
    'app/(tabs)/league.tsx', 'app/(tabs)/trades.tsx', 'app/(modals)/lineup.tsx',
    'app/(modals)/propose-trade.tsx', 'components/dynasty/DynastyHub.tsx',
])('retains revealed content while the next view fills: %s', async path => {
    const source = await read(path)
    expect(source).toContain('<DeferredContent ready=')
    expect(source).not.toMatch(/(?:message|title)=["']Loading/)
    expect(source).not.toContain('ActivityIndicator')
})
it.each([
    ['components/league/LeagueStandings.tsx', 'Loading standings...'],
    ['components/league/LeagueActivityFeed.tsx', 'Loading league activity...'],
    ['components/league/LeaguePicksBank.tsx', 'Loading draft assets...'],
])('keeps cold lists busy and reserves their space without an unconfirmed empty state: %s', async (path, oldMessage) => {
    const source = await read(path)
    expect(source).not.toContain(`message: '${oldMessage}'`)
    expect(source).toContain('minHeight: 320')
    expect(source).toContain('!loading ? <EmptyState')
    expect(source).toContain('accessibilityState={{ busy: loading }}')
})
it('keeps player and roster summaries width-stable without unknown counts', async () => {
    const players = await read('app/(tabs)/players.tsx')
    const roster = await read('app/(tabs)/roster.tsx')
    expect(players).not.toContain('— players')
    expect(players).not.toContain('Waivers —')
    expect(players).toContain("resultCountLabel ? summaryLine : ''")
    expect(roster).toContain('data ? `${active.length}/${rosterSize} active')
    expect(players).toContain('minWidth: 240, minHeight: textStyles.body.lineHeight')
    expect(players).toContain('opacity: listIsInitialLoading ? 0 : 1')
    expect(roster).toContain('opacity: !data ? 0 : 1')
    expect(roster).toContain('minWidth: 240, minHeight: 20')
    const picks = await read('components/league/LeaguePicksBank.tsx')
    expect(picks).toContain('badge: loading ? undefined : badge, reserveBadge: true')
    const filters = await read('components/ui/SegmentedControl.tsx')
    expect(filters).toContain('opt.reserveBadge && { width: 32 }')
    expect(filters).toContain('opt.reserveBadge && !opt.badge && { opacity: 0 }')
})
it('reserves the same title and description space for every week-off reason', async () => {
    const empty = await read('components/EmptyState.tsx')
    expect(empty).toContain('style={styles.reservedTitle}')
    expect(empty).toContain('style={styles.reservedDescription}')
    expect(empty).toContain('styles.copyMeasure')
    expect(empty).toContain("copyOverlay: { position: 'absolute', top: 0, left: 0, right: 0 }")
})
it('retains modal content during refresh while leaving retry and error controls visible', async () => {
    const roster = await read('app/(modals)/team-roster.tsx')
    expect(roster).toContain('(loading && !ownsRoster)')
    expect(roster).toContain('onRetry=')
    const claim = await read('app/(modals)/claim-player.tsx')
    expect(claim).toContain('loading && !player ? <LoadingState />')
    expect(claim).toContain('writePersistentCache<ClaimSnapshot>')
    expect(claim).toContain('Retry waiver claim load')
    const rookie = await read('app/(modals)/rookie-draft-room.tsx')
    expect(rookie.indexOf('if (!state)')).toBeLessThan(rookie.indexOf('loading ? <LoadingState />'))
    expect(rookie).toContain('Could not load this draft. Tap to retry.')
    const draft = await read('app/(tabs)/draft.tsx')
    expect(draft).not.toContain('Checking for a live draft')
    expect(draft).toContain('(draftLoading && !draftChecked)')
    expect(draft).toContain('<ErrorBanner message={draftError}')
})
it('does not replace trade values or rosters with progress copy', async () => {
    const summary = await read('components/trades/TradeAnalysisSummary.tsx')
    expect(summary).not.toContain('Calculating league values')
    expect(summary).toContain('aria-busy={loading}')
    expect(summary).toContain('loading && { opacity: 0 }')
    const builder = await read('components/trades/MultiTeamTradeBuilder.tsx')
    expect(builder).toContain('<DeferredContent ready={!rosterLoading}>')
    expect(builder).toContain('Failed to load rosters. Tap to retry.')
    const trades = await read('app/(tabs)/trades.tsx')
    expect(trades).not.toContain('Loading Analyzer')
    const push = await read('components/WebPushSettings.tsx')
    expect(push).not.toContain('ActivityIndicator')
    expect(push).toContain('minHeight: 44, minWidth: 80')
    expect(push).toContain('minHeight: 60')
    expect(push).toContain('aria-busy accessibilityState={{ busy: true }}')
})
it('restores player search cache before effects and preserves its authority gate', async () => {
    const source = await read('hooks/use-player-search.ts')
    expect(source).toContain('returningPage?.players ?? []')
    expect(source).toContain('Boolean(enabled && dataKey !== searchParamsKey && !returningPage)')
    expect(source).toContain('validatedKey !== searchParamsKey')
    expect(source).toContain('renderedKeyRef.current === searchParamsKey')
})

it('keeps the player average season in the reserved summary line', async () => {
    const source = await read('app/(tabs)/players.tsx')
    expect(source).not.toMatch(/averageLabel \? <Text/)
    const summary = source.match(/const summaryLine = ([^\n]+)/)?.[1]
    expect(summary).toContain('averageLabel')
})
