import assert from 'node:assert/strict'

export function clockTime(state, realMs) {
  assert.ok(Number.isFinite(state.simMs) && Number.isFinite(state.realMs), 'Clock anchors are required')
  assert.ok(Number.isFinite(state.rate) && state.rate >= 0 && state.rate <= 100, 'Clock rate must be between 0 and 100')
  const instant = state.simMs + (realMs - state.realMs) * state.rate
  if (state.capMs == null) return instant
  assert.ok(Number.isFinite(state.capMs) && state.capMs >= state.simMs, 'Clock ceiling must not precede its anchor')
  return Math.min(instant, state.capMs)
}

export function virtualDate(NativeDate, readState) {
  const now = () => clockTime(readState(), NativeDate.now())
  return new Proxy(NativeDate, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [now()]) },
    apply() { return new NativeDate(now()).toString() },
    get(target, property) { return property === 'now' ? now : Reflect.get(target, property) },
  })
}
