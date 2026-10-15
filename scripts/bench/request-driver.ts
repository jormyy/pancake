// eslint-disable-next-line import/no-unresolved
import postgres from 'npm:postgres@3.4.9'

export function connect(url: string, measured = false) {
  const parsed = new URL(url)
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== '56322') {
    throw new Error('Benchmark requires its own local database on port 56322.')
  }
  return postgres(url, {
    max: 1, prepare: true,
    types: { date: { to: 1082, from: [1082], serialize: (value: string) => value, parse: (value: string) => value } },
    connection: { 'pg_stat_statements.track': measured ? 'all' : 'none', application_name: measured ? 'tipoff-edge' : 'tipoff-observer' },
  })
}

type Sql = ReturnType<typeof connect>
const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/i.test(value)) throw new Error(`Invalid identifier: ${value}`)
  return `"${value}"`
}

export async function requestDriver(sql: Sql) {
  const functions = await sql`SELECT proname, proretset, proargnames,
    ARRAY(SELECT format_type(t, NULL) FROM unnest(proargtypes) t) AS argtypes
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace`
  const rpc = new Map(functions.map((row) => [row.proname, row]))
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const name = url.pathname.split('/').at(-1)!
    try {
      if (url.pathname.includes('/rpc/')) {
        const fn = rpc.get(name)
        if (!fn) throw new Error(`Unknown RPC: ${name}`)
        const body = await request.json()
        const values: unknown[] = []
        const args = Object.entries(body).map(([key, value]) => {
          const index = fn.proargnames.indexOf(key)
          if (index < 0) throw new Error(`Unknown argument: ${name}.${key}`)
          const type = fn.argtypes[index]
          values.push(value)
          const param = `$${values.length}`
          return `${identifier(key)} => ${type.endsWith('[]')
            ? `ARRAY(SELECT jsonb_array_elements_text(${param}::jsonb))::${type}`
            : `${param}::${type}`}`
        })
        const call = `public.${identifier(name)}(${args.join(',')})`
        const rows = await sql.unsafe(fn.proretset ? `SELECT * FROM ${call}` : `SELECT ${call} AS value`, values as postgres.ParameterOrJSON<never>[], { prepare: true })
        if (Deno.env.get('BENCH_TRACE')) console.error('RPC', name, body, rows)
        return Response.json(fn.proretset ? rows : rows[0]?.value ?? null)
      }
      const values: unknown[] = []
      const bind = (value: unknown) => { values.push(value); return `$${values.length}` }
      let from = `public.${identifier(name)} t`
      let selection = url.searchParams.get('select') ?? '*'
      if (name === 'lineup_optimizer_settings' && selection.includes('season:')) {
        from += ' JOIN public.league_seasons season ON season.id = t.league_season_id AND season.league_id = t.league_id JOIN public.leagues league ON league.id = t.league_id'
        selection = `t.league_id,t.league_season_id,t.member_id,t.last_optimized_at,
          jsonb_build_object('season_year',season.season_year,'is_current',season.is_current) AS season,
          jsonb_build_object('status',league.status) AS league`
      } else if (selection.includes('players(')) {
        const match = /players\(([^)]+)\)/.exec(selection)!
        from += ' LEFT JOIN public.players p ON p.id = t.player_id'
        const fields = match[1].split(',').map((column) => `'${column}',p.${identifier(column)}`).join(',')
        selection = selection.replace(match[0], `jsonb_build_object(${fields}) AS players`)
        selection = selection.replace(/(^|,\s*)(player_id|slot_type|is_auto_set|week_number)(?=,|$)/g, '$1t.$2')
      }
      const where: string[] = []
      for (const [key, filter] of url.searchParams) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue
        if (key === 'or') throw new Error('Unexpected pagination beyond this ten-team fixture.')
        const parts = key.split('.')
        const column = parts.length === 2 ? `${identifier(parts[0])}.${identifier(parts[1])}` : `t.${identifier(key)}`
        const split = filter.indexOf('.')
        const op = filter.slice(0, split)
        const value = filter.slice(split + 1)
        if (op === 'in') where.push(`${column} IN (${value.slice(1, -1).split(',').map((v) => bind(v.replaceAll('"', ''))).join(',')})`)
        else if (op === 'is') where.push(`${column} IS ${value === 'null' ? 'NULL' : value === 'true' ? 'TRUE' : 'FALSE'}`)
        else {
          const decoded = value === 'true' ? true : value === 'false' ? false : value
          const operator = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]
          if (!operator) throw new Error(`Unsupported filter: ${filter}`)
          where.push(`${column} ${operator} ${bind(decoded)}`)
        }
      }
      const predicate = where.length ? ` WHERE ${where.join(' AND ')}` : ''
      let rows
      if (request.method === 'PATCH') {
        const body = await request.json()
        const updates = Object.entries(body).map(([key, value]) => `${identifier(key)} = ${bind(value)}`)
        rows = await sql.unsafe(`UPDATE public.${identifier(name)} t SET ${updates.join(',')}${predicate} RETURNING *`, values as postgres.ParameterOrJSON<never>[], { prepare: true })
      } else if (request.method === 'POST') {
        const body = await request.json()
        const columns = Object.keys(body)
        const params = Object.values(body).map(bind)
        rows = await sql.unsafe(`INSERT INTO public.${identifier(name)} (${columns.map(identifier).join(',')}) VALUES (${params.join(',')}) RETURNING ${selection}`, values as postgres.ParameterOrJSON<never>[], { prepare: true })
      } else {
        const order = url.searchParams.get('order')?.split(',').map((entry) => {
          const [column, direction, nulls] = entry.split('.')
          return `t.${identifier(column)} ${direction === 'desc' ? 'DESC' : 'ASC'} ${nulls === 'nullsfirst' ? 'NULLS FIRST' : 'NULLS LAST'}`
        })
        rows = await sql.unsafe(`SELECT ${selection} FROM ${from}${predicate}${order ? ` ORDER BY ${order.join(',')}` : ''}
          ${url.searchParams.has('limit') ? ` LIMIT ${bind(Number(url.searchParams.get('limit')))}` : ''}
          ${url.searchParams.has('offset') ? ` OFFSET ${bind(Number(url.searchParams.get('offset')))}` : ''}`, values as postgres.ParameterOrJSON<never>[], { prepare: true })
      }
      if (Deno.env.get('BENCH_TRACE')) console.error('TABLE', name, request.method, url.search, values, rows)
      return Response.json(request.headers.get('accept')?.includes('vnd.pgrst.object') ? rows[0] ?? null : request.method === 'PATCH' ? null : rows)
    } catch (error) {
      const failure = error as Error & { code?: string }
      return Response.json({ message: failure.message, code: failure.code ?? 'BENCH_DRIVER' }, { status: 400 })
    }
  }
}
