import { open } from 'node:fs/promises'
import path from 'node:path'
import { miniRoot } from './common.mjs'

function ledger(file, accept) {
  let offset = 0
  return async () => {
    let handle
    try { handle = await open(file, 'r') } catch (error) { if (error.code === 'ENOENT') return; throw error }
    try {
      const size = (await handle.stat()).size
      if (size < offset) throw new Error('Provider evidence cannot shrink during a runtime')
      const bytes = Buffer.alloc(size - offset)
      let read = 0
      while (read < bytes.length) {
        const result = await handle.read(bytes, read, bytes.length - read, offset + read)
        if (!result.bytesRead) break
        read += result.bytesRead
      }
      const end = bytes.subarray(0, read).lastIndexOf(10)
      if (end < 0) return
      offset += end + 1
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) accept(JSON.parse(line))
    } finally { await handle.close() }
  }
}

export function providerEvidence(root = miniRoot) {
  const requests = new Map(), responses = new Map()
  const readRequests = ledger(path.join(root, 'state/provider-requests.jsonl'), row => {
    const rows = requests.get(row.invocation) ?? []
    rows.push(row)
    requests.set(row.invocation, rows)
  })
  const readResponses = ledger(path.join(root, 'state/provider-responses.jsonl'), row => responses.set(row.requestId, row))
  return async invocation => {
    await readRequests()
    await readResponses()
    return (requests.get(invocation) ?? []).map(row => ({ ...row, originReceipt: responses.get(row.requestId) }))
  }
}
