import assert from 'node:assert/strict'
import { argument, identifier, quote } from './trades-actions-sql.mjs'

const Deno = globalThis.Deno

export class SqlSession {
  constructor() {
    this.process = new Deno.Command('psql', { args: ['postgresql://supabase_admin:postgres@127.0.0.1:64322/postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
    this.writer = this.process.stdin.getWriter()
    this.lines = this.process.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream({
      start() { this.pending = '' },
      transform(chunk, controller) { this.pending += chunk; const lines = this.pending.split('\n'); this.pending = lines.pop(); for (const line of lines) controller.enqueue(line) },
    })).getReader()
    this.errors = ''
    this.errorPump = (async () => { for await (const text of this.process.stderr.pipeThrough(new TextDecoderStream())) this.errors += text })()
    this.serial = 0
    this.requests = 0
    this.calls = []
    this.profile = false
    this.queue = Promise.resolve()
  }
  sql(source) {
    const result = this.queue.then(() => this.runSql(source))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
  async runSql(source) {
    const end = `trades_actions_end_${++this.serial}`
    await this.writer.write(new TextEncoder().encode(`${source}\n\\echo ${end}\n`))
    const values = []
    for (;;) {
      const row = await this.lines.read()
      if (row.done) throw new Error(`Private SQL session ended: ${this.errors.slice(-5000)}`)
      if (row.value === end) break
      if (row.value.trim()) values.push(row.value)
    }
    return values
  }
  async value(source) {
    const values = await this.sql(source)
    assert.equal(values.length, 1, `Expected one SQL value: ${source.slice(0, 100)}`)
    return JSON.parse(values[0])
  }
  async execute(source, label, headers) {
    const resets = ['pancake.trade_write', 'pancake.request_active', 'pancake.request_function', 'pancake.request_input_hash', 'pancake.trade_player_revision', 'pancake.applied_trade_id', 'app.trade_lifecycle_server_write', 'request.jwt.claim.sub']
    const prefix = headers ? `SET LOCAL request.headers=${quote(JSON.stringify(headers))}; SET LOCAL trades_actions_lab.xid=${quote(1000 + ++this.requests)}; ${resets.map(key => `SET LOCAL ${key}='';`).join(' ')}` : ''
    const value = await this.value(`${prefix} SELECT trades_actions_lab.execute(${quote(source)},${this.profile});`)
    this.calls.push({ label, source, ...value })
    return value
  }
  async close() {
    try {
      await this.writer.write(new TextEncoder().encode('ROLLBACK;\n\\q\n'))
      await this.writer.close()
    } catch (error) { if (!(error instanceof TypeError)) throw error }
    await this.process.status
    await this.errorPump
  }
}

function scalarArgument(key, value) {
  if (Array.isArray(value) && /(_ids|member_ids)$/.test(key)) return `ARRAY[${value.map(quote).join(',')}]::uuid[]`
  return argument(value)
}

export async function startTransport(state) {
  const server = Deno.serve({ hostname: '127.0.0.1', port: 64390, onListen() {} }, async request => {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/auth/v1/user') return Response.json({ id: state.user, aud: 'authenticated', role: 'authenticated' })
      assert.ok(url.pathname.startsWith('/rest/v1/'), 'Only the local SQL transport is supported')
      const resource = url.pathname.slice('/rest/v1/'.length)
      let source
      if (resource.startsWith('rpc/')) {
        const name = resource.slice(4)
        const args = await request.json()
        const parameters = Object.entries(args).map(([key, value]) => `${identifier(key)}=>${scalarArgument(key, value)}`).join(',')
        const call = `public.${identifier(name)}(${parameters})`
        const set = ['process_due_accepted_trades_atomic', 'expire_pending_trades_atomic', 'claim_notification_outbox_atomic', 'claim_notification_receipts_atomic', 'get_pick_prediction_leagues', 'get_trade_estimate_reanalysis_batch'].includes(name)
        source = set ? `SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') FROM ${call} r` : `SELECT to_jsonb(${call})`
      } else {
        const table = identifier(resource)
        const conditions = []
        const filters = [...url.searchParams].filter(([key]) => !['select', 'order', 'limit', 'offset'].includes(key))
        for (const [key, filter] of filters) {
          const column = key.includes('.') ? key.split('.').map(identifier).join('.') : `t.${identifier(key)}`
          const index = filter.indexOf('.')
          const operation = filter.slice(0, index), value = filter.slice(index + 1)
          if (operation === 'eq') conditions.push(`${column}=${quote(value)}`)
          else if (operation === 'in') conditions.push(`${column} IN (${value.slice(1, -1).split(',').map(quote).join(',')})`)
          else if (operation === 'is') conditions.push(`${column} IS ${value === 'null' ? 'NULL' : value === 'true' ? 'TRUE' : 'FALSE'}`)
          else throw new Error(`Unsupported local filter: ${operation}`)
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
        const select = url.searchParams.get('select') ?? '*'
        let rows
        if (request.method === 'POST') {
          const body = await request.json()
          rows = `INSERT INTO public.${table}(${Object.keys(body).map(identifier).join(',')}) VALUES(${Object.values(body).map(argument).join(',')}) RETURNING ${select}`
        } else if (request.method === 'PATCH') {
          const body = await request.json()
          rows = `UPDATE public.${table} t SET ${Object.entries(body).map(([key, value]) => `${identifier(key)}=${argument(value)}`).join(',')} ${where} RETURNING ${select}`
        } else {
          let fields
          let joins = ''
          if (select === 'league_id,league_season_id,leagues!inner(status)') {
            fields = "t.league_id,t.league_season_id,jsonb_build_object('status',leagues.status) leagues"
            joins = 'JOIN public.leagues leagues ON leagues.id=t.league_id'
          } else fields = select === '*' ? 't.*' : select.split(',').map(value => `t.${identifier(value)}`).join(',')
          const order = url.searchParams.get('order')?.split(',').map(value => { const [field, direction] = value.split('.'); return `t.${identifier(field)} ${direction === 'desc' ? 'DESC' : 'ASC'}` }).join(',')
          const limit = Number(url.searchParams.get('limit') ?? '0')
          rows = `SELECT ${fields} FROM public.${table} t ${joins} ${where} ${order ? `ORDER BY ${order}` : ''} ${limit ? `LIMIT ${limit}` : ''}`
        }
        source = request.method === 'GET' ? `SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') FROM (${rows}) r` : `WITH r AS (${rows}) SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') FROM r`
      }
      const headers = Object.fromEntries(['x-request-id', 'x-request-actor', 'x-pancake-work-key'].flatMap(key => request.headers.has(key) ? [[key, request.headers.get(key)]] : []))
      const result = await state.session.execute(source, resource, headers)
      if (result.error) return Response.json(result.error, { status: result.error.code === '42501' ? 403 : 400 })
      let data = result.data
      if (!resource.startsWith('rpc/') && request.headers.get('accept')?.includes('vnd.pgrst.object+json')) {
        if (!Array.isArray(data) || data.length !== 1) return Response.json({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${data?.length ?? 0} rows`, hint: null }, { status: 406 })
        data = data[0]
      }
      return request.method === 'PATCH' && !request.headers.get('prefer')?.includes('return=representation') ? new Response(null, { status: 204 }) : Response.json(data)
    } catch (error) {
      console.error(error)
      return Response.json({ code: 'LAB', message: error.message }, { status: 500 })
    }
  })
  return server
}
