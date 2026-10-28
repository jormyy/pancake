import { readFileSync } from 'node:fs'

const payload = {
  format: 'json',
  content: readFileSync(new URL('../../tests/fixtures/trade-values/onenumberhoops.json', import.meta.url), 'utf8'),
}

export function tradeValueWorkRequest(name, request) {
  return name === 'sync-trade-values'
    ? new Request(request, { method: 'POST', body: JSON.stringify(payload) })
    : request
}
