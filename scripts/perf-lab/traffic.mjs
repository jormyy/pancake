import assert from 'node:assert/strict'

function resourceType(row) {
  const pathname = new URL(row.url).pathname
  if (/^\/(?:backend\/)?(?:rest|auth|functions|storage)\/v1\//.test(pathname)) return 'API'
  const type = row.responseHeaders?.['content-type'] ?? ''
  if (/service-worker|(?:^|\/)sw\.js$/.test(pathname)) return 'service worker'
  if (/manifest/.test(pathname) || type.includes('manifest')) return 'manifest'
  if (/javascript/.test(type) || /\.m?js$/.test(pathname)) return 'JavaScript'
  if (/css/.test(type) || /\.css$/.test(pathname)) return 'CSS'
  if (/^image\//.test(type) || /\.(?:png|jpe?g|svg|webp|ico)$/.test(pathname)) return 'image'
  if (/font/.test(type) || /\.(?:woff2?|ttf|otf)$/.test(pathname)) return 'font'
  if (/html/.test(type)) return 'document'
  if (/json/.test(type) || /\.json$/.test(pathname)) return 'JSON'
  return 'other'
}

function endpoint(row) {
  return `${row.method} ${new URL(row.url).pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')}`
}

export function trafficBreakdown(rows) {
  const group = key => {
    const totals = new Map()
    for (const row of rows) {
      assert.ok(Number.isFinite(row.bytesIn) && Number.isFinite(row.bytesOut), 'Traffic bytes must be measured')
      const id = key(row)
      const total = totals.get(id) ?? { id, requests: 0, bytesDown: 0, bytesUp: 0, durationMs: 0, errors: 0 }
      total.requests++
      total.bytesDown += row.bytesOut
      total.bytesUp += row.bytesIn
      total.durationMs += row.durationMs
      total.errors += Number(row.status >= 400)
      totals.set(id, total)
    }
    return [...totals.values()].sort((a, b) => b.bytesDown - a.bytesDown || a.id.localeCompare(b.id))
  }
  return { resourceTypes: group(resourceType), endpoints: group(endpoint) }
}

export function rankTraffic(captures) {
  const group = type => {
    const groups = new Map()
    for (const capture of captures) for (const row of capture.breakdown?.[type] ?? []) {
      const total = groups.get(row.id) ?? { id: row.id, requests: 0, bytesDown: 0, bytesUp: 0, durationMs: 0 }
      for (const key of ['requests', 'bytesDown', 'bytesUp', 'durationMs']) total[key] += row[key]
      groups.set(row.id, total)
    }
    return [...groups.values()].map(row => ({ ...row, bytesPerRequest: row.bytesDown / row.requests }))
      .sort((a, b) => b.bytesDown - a.bytesDown || a.id.localeCompare(b.id))
  }
  return { resourceTypes: group('resourceTypes'), endpoints: group('endpoints') }
}
