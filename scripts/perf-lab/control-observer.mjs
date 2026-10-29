export function observeRenderChanges() {
  window.__perfLabRenderEvents = []
  const scope = node => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    const owner = element?.closest('[data-testid],[id],[role]')
    return owner?.getAttribute('data-testid') ?? owner?.id ?? owner?.getAttribute('role') ?? element?.tagName ?? 'document'
  }
  new MutationObserver(records => {
    const at = Date.now()
    for (const record of records) {
      if (record.target instanceof Element && !record.target.closest('#root')) continue
      window.__perfLabRenderEvents.push({ at, scope: scope(record.target), type: record.type,
        added: record.addedNodes.length, removed: record.removedNodes.length })
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
}

export function renderSummary(events, start, end) {
  if (!Array.isArray(events)) return { renderMutations: null, renderScopes: null }
  const rows = events.filter(row => row.at >= start && row.at <= end)
  return { renderMutations: rows.length, renderScopes: [...new Set(rows.map(row => row.scope))].sort() }
}
