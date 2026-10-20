export function virtualTimers(native, readRate) {
  const scaled = ms => Math.max(1, Math.ceil(ms / Math.max(1, readRate())))
  return {
    timeout: (callback, ms, ...args) => Reflect.apply(native.timeout, globalThis, [callback, ms > 110000 || /\.abort\s*\(/.test(Function.prototype.toString.call(callback)) ? ms : scaled(ms ?? 0), ...args]),
    interval: (callback, ms, ...args) => Reflect.apply(native.interval, globalThis, [callback, scaled(ms ?? 0), ...args]),
    abortTimeout: ms => native.abortTimeout(ms),
  }
}
