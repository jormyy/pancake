import definitions from './policy.json' with { type: 'json' }
import contract from './schema-v2.json' with { type: 'json' }

export type Resource = keyof typeof definitions.resources
export type Shape = { type?: string | string[]; const?: unknown; enum?: unknown[]; properties?: Record<string, Shape>; items?: Shape; maxLength?: number; maxItems?: number; 'x-overflow'?: string }
type Rule = { field: string; op: string; value?: unknown }
export type Definition = { fields: Record<string, { schema: Shape }>; filters: Record<string, string[]>; order: string[]; direction?: string; visibility: Rule[] }
export const publicContract = contract
export const policy = definitions
export const resourceNames = Object.keys(definitions.resources) as Resource[]
export const definition = (resource: Resource) => definitions.resources[resource] as Definition

export function publicValue(value: unknown, schema: Shape): unknown {
  if (schema.const !== undefined) {
    if (value !== schema.const) throw new Error('Invalid public constant')
    return value
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (value === null || value === undefined) {
    if (types.includes('null')) return null
    throw new Error('Missing public field')
  }
  if (types.includes('object')) {
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid public object')
    const row = value as Record<string, unknown>
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, shape]) => [key, publicValue(row[key], shape)]))
  }
  if (types.includes('array')) {
    if (!Array.isArray(value)) throw new Error('Invalid public list')
    if (value.length > (schema.maxItems ?? 50) && schema['x-overflow'] !== 'truncate') throw new Error('Invalid public list')
    return value.slice(0,schema.maxItems ?? 50).map(item => publicValue(item, schema.items!))
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error('Invalid public enum')
  if (typeof value === 'string' && types.includes('string')) {
    const characters=Array.from(value)
    if (characters.length <= (schema.maxLength ?? 1024)) return value
    if (schema['x-overflow']==='truncate') return characters.slice(0,schema.maxLength ?? 1024).join('')
  }
  if (typeof value === 'boolean' && types.includes('boolean')) return value
  if (typeof value === 'number' && Number.isFinite(value) && (types.includes('number') || (types.includes('integer') && Number.isSafeInteger(value)))) return value
  throw new Error('Invalid public value')
}

function visibleRecord(resource: Resource, row: Record<string, unknown>): boolean {
  return definition(resource).visibility.every(rule => {
    if (rule.op === 'null') return row[rule.field] === null
    if (rule.op === 'notNull') return row[rule.field] !== null && row[rule.field] !== undefined
    if (rule.op === 'eq') return row[rule.field] === rule.value
    if (rule.op === 'in') return (rule.value as unknown[]).includes(row[rule.field])
    if (rule.op === 'completedWhenTrade') return !['trade_in', 'trade_out', 'trade_completed'].includes(String(row.type)) || (row.relatedTradeStatus === 'completed' && row.relatedTradeCompletedAt != null)
    return false
  })
}

export function modelObservation(resource: Resource, rows: Record<string, unknown>[], params: Record<string, unknown>) {
  const spec = definition(resource)
  const shape = publicContract.resources[resource].properties.items.items
  const candidates = rows.filter(row => row.leagueId === params.league && visibleRecord(resource, row))
  if (params.trade !== undefined && !candidates.some(row => row.id === params.trade || row.tradeId === params.trade)) return {status:404}
  const visible = candidates
    .map(row => publicValue(row, shape) as Record<string, unknown>)
    .filter(row => Object.entries(spec.filters).every(([key, fields]) => {
      if (params[key] === undefined || !fields.length) return true
      if (key === 'query') return fields.some(field => String(row[field] ?? '').toLowerCase().includes(String(params[key]).toLowerCase()))
      if (key === 'week') return Number(params[key]) >= Number(row[fields[0]]) && Number(params[key]) <= Number(row[fields[1]])
      return fields.some(field => Array.isArray(row[field]) ? row[field].includes(params[key]) : String(row[field]) === String(params[key]))
    }))
  const key = String(params.sort ?? spec.order[0])
  const direction = (params.direction ?? spec.direction ?? 'asc') === 'asc' ? 1 : -1
  const compare = (a: unknown, b: unknown) => a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1
  visible.sort((a,b) => direction * compare(a[key],b[key]) || spec.order.slice(1).map(field => compare(a[field],b[field])).find(value => value !== 0) || 0)
  const offset = Number(params.offset ?? 0), limit = Number(params.limit ?? 25)
  return { status: 200, items: visible.slice(offset, offset+limit), hasMore: visible.length > offset+limit }
}
