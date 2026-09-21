// Expo shares one numeric ID counter across concurrently serialized client and
// server graphs. Their completion order must not change the browser's IDs.
exports.scopeWebModuleIds = (createFactory) => () => {
  const fallback = createFactory()
  const environments = new Map()
  return (modulePath, context) => {
    if (context?.platform !== 'web') return fallback(modulePath, context)
    const environment = context.environment ?? 'client'
    let createId = environments.get(environment)
    if (!createId) {
      createId = createFactory()
      environments.set(environment, createId)
    }
    return createId(modulePath, context)
  }
}
