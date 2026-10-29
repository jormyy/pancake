import assert from 'node:assert/strict'

const defaults = { query: '', position: 'ALL', teams: [], playing: 'all', availability: 'free_agents', rookiesOnly: false, health: 'all', sortBy: 'fpts', sortDir: 'desc', seasonYear: null }
const values = {
  Availability: { 'All players': ['availability', 'all'], 'Free agents': ['availability', 'free_agents'], 'On waivers': ['availability', 'waivers'], Rostered: ['availability', 'rostered'], 'My team': ['availability', 'mine'] },
  Health: { All: ['health', 'all'], Healthy: ['health', 'healthy'], 'Game-time': ['health', 'gtd'], Out: ['health', 'out'], IR: ['health', 'ir'] },
  'Game today': { All: ['playing', 'all'], 'Playing today': ['playing', 'today'], 'Not playing': ['playing', 'not_today'] },
  Experience: { All: ['rookiesOnly', false], 'Rookies only': ['rookiesOnly', true] },
  Sort: { 'Fantasy Pts': ['sortBy', 'fpts'], 'Dynasty rank': ['sortBy', 'dynasty'], Minutes: ['sortBy', 'min'], Points: ['sortBy', 'pts'], Rebounds: ['sortBy', 'reb'], Assists: ['sortBy', 'ast'], Steals: ['sortBy', 'stl'], Blocks: ['sortBy', 'blk'], '3-Pointers': ['sortBy', 'tpm'], Turnovers: ['sortBy', 'to'], 'Games Played': ['sortBy', 'gp'] },
}

function playerFilterParams(action) {
  const params = { ...defaults, teams: [] }
  if (action.tap === 'Clear all filters') return params
  let change
  if (action.dialog === 'Position') change = ['position', action.tap === 'All' ? 'ALL' : action.tap]
  else if (action.dialog === 'Team') change = ['teams', [action.tap]]
  else if (action.dialog === 'Season') change = ['seasonYear', action.tap === 'Auto' ? null : Number(action.tap.slice(0, 4)) + 1]
  else change = values[action.dialog]?.[action.tap]
  assert.ok(change, `No result contract for ${action.dialog}: ${action.tap}`)
  return { ...params, [change[0]]: change[1] }
}

export function playerViewReady(contract) {
  const equal = (actual, expected) => expected === null ? actual == null : JSON.stringify(actual) === JSON.stringify(expected)
  const names = [...document.querySelectorAll('#players-section-panel [data-testid="player-row-content"]')]
    .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
    .map((node, index) => ({ name: node.closest('[aria-label^="Open "]')?.getAttribute('aria-label')?.slice(5), top: node.getBoundingClientRect?.().top ?? index }))
    .filter(row => row.name).sort((a, b) => a.top - b.top).map(row => row.name)
  const candidates = []
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index)
    if (!key?.startsWith('pancake:screen-view:v1:')) continue
    try {
      const entry = JSON.parse(window.localStorage.getItem(key))
      const scope = entry.lookupScope ?? entry.scope
      if (scope.screen !== 'players' || scope.memberId !== contract.memberId || scope.leagueId !== contract.leagueId) continue
      if (!Object.entries(contract.params ?? {}).every(([name, value]) => equal(scope.params?.[name], value))) continue
      if ((scope.params?.offset ?? 0) < (contract.minOffset ?? 0) || !Array.isArray(entry.value?.players)) continue
      candidates.push(entry)
    } catch {}
  }
  if (!candidates.length) return false
  candidates.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
  if (!contract.minOffset) {
    const expected = candidates[0].value.players.map(player => player.display_name)
    if (!expected.length) return names.length === 0 && /No (?:players|free agents)/.test(Reflect.get(document.querySelector('#players-section-panel') ?? {}, 'innerText') ?? '')
    let previous = -1
    return names.length > 0 && names.every(name => {
      const index = expected.indexOf(name, previous + 1)
      previous = index
      return index >= 0
    })
  }
  const available = new Set(candidates.flatMap(entry => entry.value.players.map(player => player.display_name)))
  return names.some(name => available.has(name))
}

export function addPlayerResultContract(scenario) {
  const scope = { memberId: '{{memberId}}', leagueId: '{{leagueId}}' }
  if (scenario.name === 'perf-player-infinite-scroll') scenario.steps[0].expected = { playerView: { ...scope, params: defaults, minOffset: 20 } }
  if (!scenario.name.startsWith('perf-filter-')) return scenario
  scenario.prepare.splice(1, 0, { tapPrefix: 'Sort:', dialog: 'Filters' }, { tap: 'Fantasy Pts', dialog: 'Sort' })
  const results = (name, params) => ({ name, action: { tapPrefix: 'Show ', dialog: 'Filters' }, expected: { playerView: { ...scope, params } } })
  if (scenario.name === 'perf-filter-sort-direction') {
    scenario.steps = scenario.steps.flatMap((step, index) => [{ ...step,
      action: index ? { sequence: [{ tap: 'Show filters' }, step.action] } : step.action,
    }, results(`${step.name}-results`, { ...defaults, sortDir: index ? 'desc' : 'asc' })])
    return scenario
  }
  scenario.steps.push(results('results', playerFilterParams(scenario.steps[0].action)))
  return scenario
}
