export function businessTimers({ timeout, interval, clear, now, context = () => null }) {
  const pending = new Map()
  const install = (callback, ms = 0, args, repeat) => {
    const owner = context()
    if (!owner || ms > 110000 || /\.abort\s*\(/.test(Function.prototype.toString.call(callback))) return repeat ? interval(callback, ms, ...args) : timeout(callback, ms, ...args)
    const entry = { due: Math.ceil(now() + ms), callback, args, repeat, ms, owner }
    const id = interval(() => {
      if (now() < entry.due) return
      if (repeat) entry.due += Math.max(1, ms)
      else { pending.delete(id); clear(id); owner.waiters.delete(id) }
      Reflect.apply(callback, globalThis, args)
    }, 2)
    pending.set(id, entry)
    if (!repeat) owner.waiters.add(id)
    return id
  }
  return {
    timeout: (callback, ms, ...args) => install(callback, ms, args, false),
    interval: (callback, ms, ...args) => install(callback, ms, args, true),
    clear: id => { pending.get(id)?.owner.waiters.delete(id); pending.delete(id); clear(id) },
    next: () => pending.size ? Math.min(...[...pending.values()].map(entry => entry.due)) : null,
  }
}
