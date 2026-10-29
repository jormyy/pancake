import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

export function renderReview(rows) {
  const image = (row, stage) => {
    const entry = row.images[stage]
    if (!entry) return '<p>Not captured</p>'
    assert.match(entry.file, /^[a-zA-Z0-9_.-]+\.png$/, 'Review images must stay beside the index')
    return `<a href="${escape(entry.file)}"><img loading="lazy" width="195" src="${escape(entry.file)}" alt="${escape(`${row.id} ${stage}`)}"></a>`
  }
  const cards = [...rows].sort((a, b) => a.id.localeCompare(b.id)).map(row => `<details><summary>${escape(row.id)} · ${row.passed ? 'content passed' : 'content failed'} · ${escape(row.source.slice(0, 8))}</summary><div class="frames"><section><h3>First paint</h3>${image(row, 'first')}</section><section><h3>Settled</h3>${image(row, 'settled')}</section>${row.images.failure ? `<section><h3>Failure</h3>${image(row, 'failure')}</section>` : ''}</div></details>`).join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>First-load review</title><style>body{font:16px system-ui;margin:2rem;color:#202622;background:#faf7ef}details{border-top:1px solid #c8c0b3;padding:1rem 0}summary{cursor:pointer;overflow-wrap:anywhere}.frames{display:flex;flex-wrap:wrap;gap:2rem}img{max-width:100%;height:auto;border:1px solid #c8c0b3}h3{font-size:1rem}p{max-width:70ch}</style></head><body><h1>First-load review</h1><p>${rows.length} captured states. Open a state to compare its first and settled frames. Select an image for full resolution.</p><p>Content checks do not prove instant first paint. Sources differ across archived captures. Visual approval remains pending.</p>${cards}</body></html>\n`
}

export async function writeReview(directory, rows) {
  await writeFile(path.join(directory, 'index.html'), renderReview(rows))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  assert.ok(directory, 'Supply the first-load evidence directory')
  await writeReview(directory, JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')))
}
