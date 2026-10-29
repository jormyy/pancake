import { addPlayerResultContract } from './player-results.mjs'

function currentAction(action) {
  if (action.sequence) return { ...action, sequence: action.sequence.map(currentAction) }
  return action.tapPrefix === 'Analyze trade from ' ? { ...action, tapPrefix: 'Revalue trade from ' } : action
}

export function currentScenario(source) {
  const scenario = structuredClone(source)
  if (scenario.prepare) scenario.prepare = scenario.prepare.map(currentAction)
  scenario.steps = scenario.steps.map(step => ({ ...step, action: currentAction(step.action) }))
  if (scenario.name.startsWith('trades-analyzer-offline-')) {
    scenario.prepare = scenario.prepare.map(action => action.tap === 'Back to trades' ? { tapPrefix: 'Offers' } : action)
    scenario.steps = scenario.steps.map(step => step.name === 'result' ? { ...step, expected: { all: [{ selector: '[aria-label="Dynasty trade analysis"]' }, { text: 'Value ' }] } } : step)
  }
  if (scenario.name === 'draft') {
    scenario.from = '/league?tab=draft'
    scenario.prepare = []
    scenario.steps[0].action = { tap: 'Join Auction Draft' }
  }
  if (scenario.name === 'lineup-options') {
    scenario.from = '/'
    scenario.steps[0] = { action: { tap: 'Open auto-set lineup options' }, expected: { selector: '[role="dialog"] [aria-label="Edit lineup manually"]' } }
  }
  if (scenario.name === 'shell-auth-return-sign-in') {
    scenario.prepare = scenario.prepare.map(action => action.fill === 'Email' ? { ...action, value: '{{userEmail}}' }
      : action.fill === 'Password' ? { ...action, value: '{{userPassword}}' } : action)
  }
  if (/^trade-roster-plan-/.test(scenario.name)) {
    scenario.steps[1].expected = { all: [
      { selector: '[aria-label="Keegan Carter 19: active"][aria-checked="true"]' },
      { selector: '[aria-label="Marcus Williams 22: taxi"][aria-checked="true"]' },
      { selector: '[aria-label="Malik Carter 20: ir"][aria-disabled="true"]' },
      { selector: '[aria-label="Malik Carter 20: taxi"][aria-disabled="true"]' },
    ] }
    scenario.steps[2] = { name: 'drops', action: { reveal: 'Drop Jalen Davis 41 at completion' }, expected: { selector: '[aria-label="Drop Jalen Davis 41 at completion"]' } }
    scenario.steps[4].action = { tap: 'Jalen Davis 41: active' }
    scenario.steps[5] = { name: 'close-drops', action: { tap: 'Back to trades' }, expected: { selector: '[aria-label^="Show details of trade with "]' } }
  }
  if (/^trades-details-/.test(scenario.name)) {
    scenario.steps[0].expected = { all: [{ selector: '[aria-label="Back to trades"]' }, { any: [
      { selector: '[aria-label^="Accept trade with "]' }, { selector: '[aria-label^="Edit trade with "]' },
    ] }] }
  }
  return addPlayerResultContract(scenario)
}
