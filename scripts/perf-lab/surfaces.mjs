import assert from 'node:assert/strict'

const content = {
  'other-matchup': variables => ({ text: variables.teamName }),
  'auth-sign-in': () => ({ selector: '[placeholder="you@example.com"]' }),
  'auth-sign-up': () => ({ text: 'Create Account' }),
  'team-timeline': variables => ({ text: `${variables.teamName} activity` }),
  'playoff-bracket': () => ({ text: 'No playoff bracket yet' }),
  'change-password': () => ({ selector: '[aria-label="Update password"]' }),
  'notification-settings': () => ({ text: 'Notifications' }),
  'claim-player': () => ({ selector: '[aria-label="FAAB bid amount"]' }),
  'commissioner-settings': (_, role) => role === 'commissioner' ? { selector: '[aria-label="Save league settings"]' } : { text: 'Commissioner access required' },
  'create-league': () => ({ selector: '[aria-label="League name"]' }),
  'auction-room': () => ({ text: 'Draft Complete' }),
  'join-league': () => ({ selector: '[aria-label="Invite code"]' }),
  'lineup-editor': () => ({ selector: '[aria-label="Auto lineup"]' }),
  'propose-trade': () => ({ selector: '[aria-label^="Trade with "]' }),
  'rookie-draft-room': () => ({ selector: '[aria-label="Search prospects"]' }),
  'team-roster': () => ({ selector: '[aria-label^="Propose trade with "]' }),
  'draft-launcher': () => ({ selector: '[aria-label="Search prospects"]' }),
  'dynasty-hub': () => ({ all: [{ selector: '#players-section-rankings[aria-selected="true"]' }, sections['players.rankings']] }),
  'matchup-home': variables => ({ text: variables.teamName }),
  'league-dashboard': () => ({ selector: '[aria-label="League sections"]' }),
  players: () => ({ all: [{ selector: '[aria-label="Search players"]' }, sections['players.players']] }),
  profile: variables => ({ text: variables.displayName }),
  roster: () => ({ selector: '[aria-label^="Open "]' }),
  trades: () => ({ selector: '[aria-label^="Show details of trade with "]' }),
  'not-found': () => ({ text: "This page doesn't exist" }),
  'player-detail': variables => ({ text: variables.freeAgent.display_name }),
}

const sections = {
  'league-dashboard.results': { selector: '#league-panel-results [aria-label^="Rank "][aria-label$="Open roster"]' },
  'league-dashboard.history': { selector: '#league-panel-history [data-testid="player-row-content"]' },
  'league-dashboard.picks': { selector: '#league-panel-picks [role="listitem"][aria-label]' },
  'league-dashboard.schedule': { selector: '#league-panel-schedule [aria-label="Your season schedule"] [role="listitem"]' },
  'league-dashboard.draft': { any: [{ text: 'No live draft.' }, { text: 'Live Draft' }, { text: 'Auction setup' }, { text: 'Rookie draft setup' }] },
  'league-dashboard.settings': { selector: '[aria-label="Open playoff bracket"]' },
  'players.players': { selector: '#players-section-panel [data-testid="player-row-content"]' },
  'players.waivers': { all: [{ text: 'Pending claims (' }, { text: 'Recent results' }, { text: 'Pickups ' }] },
  'players.rankings': { selector: '#players-section-panel [aria-label^="Open "] [data-testid="player-row-content"]' },
  'players.news': { any: [{ selector: '#players-section-panel [role="link"][aria-label]' }, { text: 'No dynasty news yet.' }] },
  'trades.offers': { selector: '[aria-label^="Show details of trade with "]' },
  'trades.block': { all: [{ text: 'League listings' }, { text: 'Your listings' }, { any: [{ selector: '[aria-label^="List "][aria-label$="on trade block"]' }, { text: 'No listings yet.' }] }] },
  'trades.history': { any: [{ selector: '[aria-label^="Show details of trade with "]' }, { text: 'No completed trades yet.' }] },
  'trades.analyzer': { all: [{ text: 'Choose a team.' }, { selector: '[aria-label^="Analyze with "]' }] },
}

function sectionText(contract, within) {
  if (contract.text) return { ...contract, within }
  if (contract.all) return { ...contract, all: contract.all.map(item => sectionText(item, within)) }
  if (contract.any) return { ...contract, any: contract.any.map(item => sectionText(item, within)) }
  return contract
}

export function expectedSurface(surface, variables, role) {
  const [base, section] = surface.id.split('.')
  if (base === 'league-dashboard' && section === 'bracket') return { text: 'No playoff bracket yet' }
  if (section) {
    const prefix = { 'league-dashboard': 'league-tab', players: 'players-section', trades: 'trade-section' }[base]
    assert.ok(prefix, `Unknown section surface ${surface.id}`)
    assert.ok(sections[surface.id], `Missing section content contract for ${surface.id}`)
    const within = base === 'players' ? '#players-section-panel' : base === 'league-dashboard' ? `#league-panel-${section}` : null
    return { all: [{ selector: `#${prefix}-${section}[aria-selected="true"]` }, within ? sectionText(sections[surface.id], within) : sections[surface.id]] }
  }
  assert.ok(content[base], `Missing content contract for ${surface.id}`)
  return content[base](variables, role)
}
