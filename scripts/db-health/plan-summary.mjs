import { createReadStream, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createGunzip, gunzipSync } from 'node:zlib'

function* iterLoggedPlans(source) {
  for (const match of source.matchAll(/\bplan:\r?\n[\t ]*(?=\{)/g)) {
    const start = match.index + match[0].length
    let depth = 0, quoted = false, escaped = false
    let complete=false
    for (let index = start; index < source.length; index++) {
      const character = source[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
      } else if (character === '"') quoted = true
      else if (character === '{') depth++
      else if (character === '}' && --depth === 0) {
        let parsed
        try { parsed=JSON.parse(source.slice(start, index + 1).replace(/("Query Identifier"\s*:\s*)(-?\d+)(?=\s*[,}])/g, '$1"$2"')) }
        catch { throw new Error('Malformed database plan record') }
        yield parsed
        complete=true
        break
      }
    }
    if(!complete)throw new Error('Incomplete database plan record')
  }
}

export function loggedPlans(source) { return [...iterLoggedPlans(source)] }

export function* jsonLoggedPlans(source) {
  for(const line of source.split(/\r?\n/)) {
    if(!line.trim())continue
    const row=JSON.parse(line)
    if(typeof row.message==='string')yield* iterLoggedPlans(row.message)
  }
}

function planSummary() {
  const queries = new Map(), scans = new Map(), indexes = new Map()
  let spilledPlans = 0
  let capturedPlans=0
  function visit(node) {
    if (node['Index Name']) indexes.set(node['Index Name'], (indexes.get(node['Index Name']) ?? 0) + 1)
    if (node['Relation Name']) {
      const key = `${node['Node Type']}:${node['Relation Name']}`
      const row = scans.get(key) ?? { type: node['Node Type'], relation: node['Relation Name'], calls: 0, maximumRows: 0, maximumExaminedRows: 0 }
      row.calls++
      const loops = node['Actual Loops'] ?? 0
      row.maximumRows = Math.max(row.maximumRows, (node['Actual Rows'] ?? 0) * loops)
      row.maximumExaminedRows = Math.max(row.maximumExaminedRows,
        ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * loops)
      scans.set(key, row)
    }
    for (const child of node.Plans ?? []) visit(child)
  }
  function add(plan) {
    capturedPlans++
    const query = plan['Query Text']
    const row = queries.get(query) ?? { query, calls: 0, milliseconds: 0, buffers: 0, maximumMilliseconds: 0, maximumBuffers: 0, sample: plan, slowestSample: plan }
    row.calls++
    const milliseconds = plan.Plan['Actual Total Time'] ?? 0
    const buffers = (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0)
    if (buffers > row.maximumBuffers) { row.maximumBuffers = buffers; row.sample = plan }
    if (milliseconds > row.maximumMilliseconds) { row.maximumMilliseconds = milliseconds; row.slowestSample = plan }
    const spills = node => (node['Temp Read Blocks'] ?? 0) > 0 || (node['Temp Written Blocks'] ?? 0) > 0
      || node['Sort Space Type'] === 'Disk' || (node['Hash Batches'] ?? 1) > 1 || (node.Plans ?? []).some(spills)
    if (spills(plan.Plan)) spilledPlans++
    row.milliseconds += plan.Plan['Actual Total Time'] ?? 0
    row.buffers += (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0)
    queries.set(query, row)
    visit(plan.Plan)
  }
  const result = () => ({ capturedPlans, distinctQueries: queries.size, spilledPlans, indexes: [...indexes].map(([name, calls]) => ({ name, calls })),
    queries: [...queries.values()].sort((a, b) => b.milliseconds - a.milliseconds),
    scans: [...scans.values()].sort((a, b) => b.maximumExaminedRows - a.maximumExaminedRows) })
  return { add, result }
}

export function summarizePlans(plans) {
  const summary = planSummary()
  for (const plan of plans) summary.add(plan)
  return summary.result()
}

export async function summarizePlanLog(file, database) {
  if (!database) throw new Error('A source database is required')
  const summary = planSummary()
  let ignoredRecords = 0, unattributedRecords = 0, anonymousPlans = 0
  const source = createReadStream(file)
  const stream = file.endsWith('.gz') ? source.pipe(createGunzip()) : source
  source.on('error', error => stream.destroy(error))
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      const record = JSON.parse(line)
      const actualDatabase = record.dbname ?? record.database_name
      if (actualDatabase !== database) {
        if (actualDatabase) ignoredRecords++
        else unattributedRecords++
        continue
      }
      for (const plan of jsonLoggedPlans(line)) {
        if (!plan['Query Text']?.trim()) {
          anonymousPlans++
          plan['Query Text'] = JSON.stringify({ anonymous: true, context: record.context ?? null, output: plan.Plan.Output ?? null })
        }
        summary.add(plan)
      }
    }
  } finally {
    lines.close()
    stream.destroy()
    source.destroy()
  }
  return { database, reviewed: false, ignoredRecords, unattributedRecords, anonymousPlans, ...summary.result() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === '--stream') {
    process.stdout.write(`${JSON.stringify(await summarizePlanLog(process.argv[3], process.argv[4]), null, 2)}\n`)
  } else {
    const jsonFormat=process.argv[2]==='--jsonlog'
    const file=process.argv[jsonFormat?3:2]
    const input=readFileSync(file)
    const source=(file.endsWith('.gz')?gunzipSync(input):input).toString('utf8')
    process.stdout.write(`${JSON.stringify(summarizePlans(jsonFormat?jsonLoggedPlans(source):iterLoggedPlans(source)), null, 2)}\n`)
  }
}
