function installObserver() {
  const events = []
  Object.defineProperty(window, '__perfLab', { value: { events }, configurable: true })
  const record = (kind, detail) => events.push({ kind, at: performance.now(), ...detail })
  for (const name of ['getItem', 'setItem', 'removeItem']) {
    const original = Storage.prototype[name]
    Storage.prototype[name] = function (...args) {
      const result = original.apply(this, args)
      const key = String(args[0])
      let view
      if (key.startsWith('pancake:screen-view:v1:')) {
        try { view = JSON.parse(name === 'getItem' ? result : args[1]) } catch {}
      }
      record(`storage.${name}`, { key, hit: name === 'getItem' ? result !== null : undefined, bytes: typeof result === 'string' ? new TextEncoder().encode(result).length : undefined,
        version: view?.version, dirty: view?.dirty, savedAt: view?.savedAt,
        cacheAction: name === 'removeItem' ? 'invalidated' : view?.dirty === true ? 'invalidated' : view && name === 'setItem' ? 'refreshed' : undefined })
      return result
    }
  }
  for (const name of ['match', 'put', 'delete']) {
    const original = Cache.prototype[name]
    Cache.prototype[name] = async function (...args) {
      const result = await original.apply(this, args)
      const request = args[0]
      record(`cache.${name}`, { path: new URL(typeof request === 'string' ? request : request.url, location.origin).pathname, hit: name === 'match' ? Boolean(result) : undefined })
      return result
    }
  }
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'perf-lab-cache') record('worker.cache', event.data.detail)
    else record('worker.message', { type: event.data?.type ?? null })
  })
  window.addEventListener('storage', event => record('storage.external-change', { key: event.key }))
  document.addEventListener('visibilitychange', () => record('visibility', { state: document.visibilityState }))
}

export const pageObserverSource = `(${installObserver.toString()})();`

export const workerObserverSource = `(() => {
  const report = detail => self.clients.matchAll({includeUncontrolled:true}).then(clients => clients.forEach(client => client.postMessage({type:'perf-lab-cache',detail}))).catch(() => {});
  for (const name of ['match','put','delete']) {
    const original = Cache.prototype[name];
    Cache.prototype[name] = async function(...args) {
      const result = await original.apply(this,args);
      const request = args[0];
      report({operation:name,path:new URL(typeof request === 'string' ? request : request.url,self.location.origin).pathname,hit:name === 'match' ? Boolean(result) : undefined});
      return result;
    };
  }
})();`
