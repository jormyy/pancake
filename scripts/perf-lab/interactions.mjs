import { actionKind } from './actions.mjs'

export function controlContract(action) {
  const kind = actionKind(action)
  const label = String(action[kind] ?? kind)
  const category = /search/i.test(label) ? 'search' : /auto.?set|lineup|bench/i.test(label) ? 'lineup'
    : /claim|faab|bid/i.test(label) ? 'claim' : /trade|analy/i.test(label) ? 'trade'
    : /draft|pick|nomina|timer/i.test(label) ? 'draft' : /sort|filter|availability|points|rebounds/i.test(label) ? 'filter'
    : kind === 'pullRefresh' || /refresh/i.test(label) ? 'refresh' : /league|sign|settings/i.test(label) ? 'account' : kind
  const navigation = kind === 'open'
  return { kind, label, category, budget: { minRequests: kind === 'pullRefresh' ? 1 : 0, requests: navigation ? 50 : category === 'search' ? 4 : 12,
    bytesDown: navigation ? 6291456 : category === 'trade' ? 524288 : 262144,
    resultsMs: navigation ? 5000 : category === 'trade' ? 5000 : 2500, dbMs: 2500, dbCalls: 20000, dbBuffers: 1000000 }, cadenceMs: category === 'search' ? action.cadenceMs ?? 180 : null }
}

export function leafControls(action, prefix = '0') {
  return action.sequence ? action.sequence.flatMap((child, index) => leafControls(child, `${prefix}.${index}`)) : [{ path: prefix, action, ...controlContract(action) }]
}

export function controlInventory(scenarios) {
  return scenarios.flatMap(scenario => {
    let route = scenario.from
    const controls = (scenario.prepare ?? []).flatMap((action, index) => leafControls(action).map(control => ({ ...control,
      id: `${scenario.name}/prepare/${index}/${control.path}`, scenario: scenario.name, step: 'prepare', route })))
    for (const [index, step] of scenario.steps.entries()) {
      const actions = leafControls(step.action)
      route = step.expected?.route ?? actions.filter(action => action.kind === 'open').at(-1)?.action.open ?? route
      controls.push(...actions.map(control => ({ ...control, id: `${scenario.name}/${index}/${control.path}`, scenario: scenario.name, step: index, route })))
    }
    return controls
  })
}

export function interactionMeasurement(control, access, endAt, search = []) {
  const rows = access.filter(row => row.window === control.window || row.window.startsWith(`${control.window}/`))
  const requests = rows.length, bytesDown = rows.reduce((sum, row) => sum + row.bytesOut, 0)
  const bytesUp = rows.reduce((sum, row) => sum + row.bytesIn, 0)
  const durationMs = endAt - control.startedAt
  const keystrokes = (control.keystrokes ?? []).map(key => {
    const requests = rows.filter(row => row.window === key.window)
    const landed = search.find(row => row.query === key.value && row.at >= key.at && row.ready)
    return { ...key, requests: requests.length, bytesDown: requests.reduce((sum, row) => sum + row.bytesOut, 0),
      bytesUp: requests.reduce((sum, row) => sum + row.bytesIn, 0), resultsMs: landed ? landed.at - key.at : null }
  })
  const last = keystrokes.at(-1)
  const resultsMs = last ? last.resultsMs : durationMs
  const databaseMeasured = ['dbMs', 'dbCalls', 'dbRows', 'dbBuffers'].every(key => Number.isFinite(control[key]))
  return { ...control, requests, bytesDown, bytesUp, durationMs, resultsMs, keystrokes,
    databaseMeasured, budgetPassed: databaseMeasured && Number.isFinite(control.renderMutations)
      && control.dbMs <= control.budget.dbMs && control.dbCalls <= control.budget.dbCalls && control.dbBuffers <= control.budget.dbBuffers
      && requests >= (control.budget.minRequests ?? 0) && requests <= control.budget.requests && bytesDown <= control.budget.bytesDown && resultsMs !== null && resultsMs <= control.budget.resultsMs }
}

export function visibleControls() {
  return [...document.querySelectorAll('button,a,input,select,textarea,[role="button"],[role="switch"],[role="tab"]')]
    .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
    .map(element => ({ role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
      label: element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? element.textContent?.trim().slice(0, 160) ?? '',
      id: element.id, disabled: Reflect.get(element, 'disabled') === true || element.getAttribute('aria-disabled') === 'true' }))
}

export function observeSearch() {
  window.__perfLabSearch = []
  let previous = ''
  const sample = () => {
    const input = document.querySelector('input[aria-label="Search players"]')
    const query = input instanceof HTMLInputElement ? input.value : ''
    const labels = [...document.querySelectorAll('[data-testid="player-row-content"]')].filter(node => node.getClientRects().length).map(node => node.textContent.trim())
    const empty = /No players (?:found|match)/i.test(document.body.innerText)
    const ready = query.length > 0 && (empty || labels.length > 0 && labels.every(label => label.toLowerCase().includes(query.toLowerCase())))
    const signature = JSON.stringify([query, labels, ready])
    if (signature !== previous) window.__perfLabSearch.push({ at: Date.now(), query, results: labels.length, ready })
    previous = signature
  }
  new MutationObserver(sample).observe(document.getElementById('root'), { childList: true, subtree: true, attributes: true, characterData: true })
  document.addEventListener('input', () => requestAnimationFrame(sample), true)
  sample()
}
