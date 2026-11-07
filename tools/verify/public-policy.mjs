import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const policyPath = 'supabase/functions/api/public/policy.json'
const migrationPath = 'supabase/migrations/20261214010300_public_league_reads.sql'
const quote = value => `'${value.replaceAll("'", "''")}'`

function contractFor(policy) {
  const resources = Object.fromEntries(Object.entries(policy.resources).map(([name, definition]) => {
    const properties = Object.fromEntries(Object.entries(definition.fields).map(([key, value]) => [key, value.schema]))
    return [name, { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `urn:pancake:public:v2:${name}`,
      type: 'object', additionalProperties: false, required: ['$schema', 'version', 'resource', 'items', 'nextCursor'],
      properties: { $schema: { const: `urn:pancake:public:v2:${name}` }, version: { const: 2 }, resource: { const: name },
        items: { type: 'array', maxItems: policy.maxLimit, items: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) } },
        nextCursor: { type: ['string', 'null'], maxLength: 256 } } }]
  }))
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', version: 2, resources }
}

function sqlFor(policy) {
  const cases = Object.entries(policy.resources).map(([name, definition]) => {
    const fields = Object.entries(definition.fields).flatMap(([key, field]) => [quote(key), field.sql]).join(',\n          ')
    const filters = Object.entries(definition.filters).filter(([, fields]) => fields.length).map(([key, fields]) => {
      if (key === 'query') return `(params->>'query' IS NULL OR ${fields.map(field => `position(lower(params->>'query') IN lower(data->>${quote(field)}))>0`).join(' OR ')})`
      if (key === 'week') return `(params->>'week' IS NULL OR (params->>'week')::integer BETWEEN (data->>${quote(fields[0])})::integer AND (data->>${quote(fields[1])})::integer)`
      return `(params->>${quote(key)} IS NULL OR ${fields.map(field => definition.fields[field].schema.type === 'array' ? `(data->${quote(field)}) ? (params->>${quote(key)})` : `data->>${quote(field)}=params->>${quote(key)}`).join(' OR ')})`
    })
    const visibility = definition.visibility.map(rule => {
      if (rule.op === 'null') return `${rule.column} IS NULL`
      if (rule.op === 'notNull') return `${rule.column} IS NOT NULL`
      if (rule.op === 'eq') return `${rule.column}=${typeof rule.value === 'boolean' ? rule.value : quote(rule.value)}`
      if (rule.op === 'in') return `${rule.column} IN (${rule.value.map(quote).join(',')})`
      if (rule.op === 'completedWhenTrade') return `(tx.transaction_type NOT IN ('trade_in','trade_out','trade_completed') OR EXISTS(SELECT 1 FROM public.trades policy_trade WHERE policy_trade.id=${rule.column} AND policy_trade.league_id=tx.league_id AND policy_trade.status='completed' AND policy_trade.completed_at IS NOT NULL))`
      throw new Error('Unknown visibility operation')
    })
    const first = definition.order[0]
    const rest = definition.order.slice(1).map(key => `data->${quote(key)} ASC`).join(', ')
    const order = `CASE WHEN COALESCE(params->>'direction',${quote(definition.direction ?? 'asc')})='asc' THEN nullif(data->COALESCE(params->>'sort',${quote(first)}),'null'::jsonb) END ASC NULLS LAST,
        CASE WHEN COALESCE(params->>'direction',${quote(definition.direction ?? 'asc')})='desc' THEN nullif(data->COALESCE(params->>'sort',${quote(first)}),'null'::jsonb) END DESC NULLS LAST${rest ? ', '+rest : ''}`
    return `WHEN ${quote(name)} THEN
      WITH visible AS MATERIALIZED (
        SELECT jsonb_build_object(${fields}) AS data
        FROM ${definition.source}
        WHERE (${definition.where})${visibility.map(condition => ' AND '+condition).join('')}
      ), filtered AS (
        SELECT data FROM visible WHERE ${filters.join(' AND ') || 'true'}
      ), page AS (
        SELECT data, row_number() OVER (ORDER BY ${order}) AS ordinal
        FROM filtered ORDER BY ${order} LIMIT page_limit+1 OFFSET page_offset
      )
      SELECT coalesce(jsonb_agg(data ORDER BY ordinal) FILTER (WHERE ordinal<=page_offset+page_limit),'[]'::jsonb),
        count(*)>page_limit INTO result_rows, more FROM page;`
  }).join('\n    ')
  const filterSpec = Object.fromEntries(Object.entries(policy.resources).map(([name, resource]) => [name, Object.keys(resource.filters)]))
  const sortSpec = Object.fromEntries(Object.entries(policy.resources).map(([name, resource]) => [name, Object.entries(resource.fields).filter(([,field]) => !(Array.isArray(field.schema.type)?field.schema.type:[field.schema.type]).some(type=>['object','array'].includes(type))).map(([name]) => name)]))
  return `BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

CREATE TABLE private.public_api_buckets (
  bucket_key text NOT NULL,
  minute timestamptz NOT NULL,
  reads integer NOT NULL CHECK(reads>0),
  PRIMARY KEY(bucket_key,minute)
);
ALTER TABLE private.public_api_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.public_api_buckets FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.public_read_v2(p_league_id uuid,p_resource text,p_params jsonb DEFAULT '{}',p_client_key text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='1s' SET statement_timeout='5s' AS $$
DECLARE
  params jsonb:=coalesce(p_params,'{}');
  page_limit integer;
  page_offset integer;
  selected_season uuid;
  selected_year integer;
  result_rows jsonb;
  more boolean;
  used integer;
  current_minute timestamptz:=date_trunc('minute',clock_timestamp());
  filter_spec jsonb:=${quote(JSON.stringify(filterSpec))}::jsonb;
  sort_spec jsonb:=${quote(JSON.stringify(sortSpec))}::jsonb;
BEGIN
  IF p_client_key IS NULL OR p_client_key !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status',400); END IF;
  INSERT INTO private.public_api_buckets(bucket_key,minute,reads) VALUES('global',current_minute,1)
    ON CONFLICT(bucket_key,minute) DO UPDATE SET reads=private.public_api_buckets.reads+1
    WHERE private.public_api_buckets.reads<600 RETURNING reads INTO used;
  IF used IS NULL THEN RETURN jsonb_build_object('status',429,'retryAfter',60); END IF;
  INSERT INTO private.public_api_buckets(bucket_key,minute,reads) VALUES(p_client_key,current_minute,1)
    ON CONFLICT(bucket_key,minute) DO UPDATE SET reads=private.public_api_buckets.reads+1
    WHERE private.public_api_buckets.reads<60 RETURNING reads INTO used;
  IF used IS NULL THEN RETURN jsonb_build_object('status',429,'retryAfter',60); END IF;
  DELETE FROM private.public_api_buckets WHERE (bucket_key,minute) IN (
    SELECT bucket_key,minute FROM private.public_api_buckets WHERE minute<current_minute-interval '2 minutes' ORDER BY minute LIMIT 128
  );
  IF p_resource IS NULL OR NOT (filter_spec ? p_resource) THEN RETURN jsonb_build_object('status',404); END IF;
  IF jsonb_typeof(params)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(params) k
    WHERE k NOT IN ('limit','offset','sort','direction') AND NOT ((filter_spec->p_resource) ? k)) THEN RETURN jsonb_build_object('status',400); END IF;
  IF params ? 'sort' AND NOT ((sort_spec->p_resource) ? (params->>'sort')) THEN RETURN jsonb_build_object('status',400); END IF;
  IF params ? 'direction' AND params->>'direction' NOT IN ('asc','desc') THEN RETURN jsonb_build_object('status',400); END IF;
  page_limit:=coalesce((params->>'limit')::integer,25);
  page_offset:=coalesce((params->>'offset')::integer,0);
  IF page_limit NOT BETWEEN 1 AND 50 OR page_offset NOT BETWEEN 0 AND 100000 THEN RETURN jsonb_build_object('status',400); END IF;
  IF p_resource<>'leagues' AND NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=p_league_id AND deleted_at IS NULL) THEN RETURN jsonb_build_object('status',404); END IF;
  IF params ? 'team' AND NOT EXISTS(SELECT 1 FROM public.league_members WHERE id=(params->>'team')::uuid AND league_id=p_league_id) THEN RETURN jsonb_build_object('status',404); END IF;
  IF params ? 'player' AND NOT EXISTS(SELECT 1 FROM public.players WHERE id=(params->>'player')::uuid) THEN RETURN jsonb_build_object('status',404); END IF;
  IF params ? 'draft' AND NOT EXISTS(SELECT 1 FROM public.drafts WHERE id=(params->>'draft')::uuid AND league_id=p_league_id AND NOT is_mock) THEN RETURN jsonb_build_object('status',404); END IF;
  IF params ? 'trade' AND NOT EXISTS(SELECT 1 FROM public.trades WHERE id=(params->>'trade')::uuid AND league_id=p_league_id AND status='completed' AND completed_at IS NOT NULL) THEN RETURN jsonb_build_object('status',404); END IF;
  SELECT id,season_year INTO selected_season,selected_year FROM public.league_seasons
    WHERE league_id=p_league_id AND (params->>'season' IS NULL OR season_year=(params->>'season')::integer)
    ORDER BY is_current DESC,season_year DESC,id LIMIT 1;
  selected_year:=coalesce((params->>'season')::integer,selected_year,public.current_season_year_et());
  CASE p_resource
    ${cases}
  END CASE;
  RETURN jsonb_build_object('status',200,'items',result_rows,'hasMore',more);
EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('status',404);
  WHEN numeric_value_out_of_range OR invalid_parameter_value THEN RETURN jsonb_build_object('status',400);
END;
$$;
REVOKE ALL ON FUNCTION public.public_read_v2(uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.public_read_v2(uuid,text,jsonb,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
`
}

export async function generate(check = false) {
  const policy = JSON.parse(await readFile(path.join(root, policyPath), 'utf8'))
  const contract = JSON.stringify(contractFor(policy), null, 2)+'\n'
  const outputs = { [migrationPath]: sqlFor(policy), 'supabase/functions/api/public/schema-v2.json': contract, 'packages/pancake-cli/schemas/v2.json': contract, 'packages/pancake-cli/schemas/options-v2.json': JSON.stringify(Object.fromEntries(Object.entries(policy.resources).map(([name, item]) => [name, { filters: Object.keys(item.filters), filterFields: item.filters, order: item.order, direction: item.direction ?? 'asc', sorts: Object.entries(item.fields).filter(([, field]) => !(Array.isArray(field.schema.type)?field.schema.type:[field.schema.type]).some(type=>['object','array'].includes(type))).map(([key]) => key) }])), null, 2)+'\n' }
  for (const [file, text] of Object.entries(outputs)) {
    if (check) { if (await readFile(path.join(root,file),'utf8') !== text) throw new Error(`Stale public artifact: ${file}`) }
    else { await mkdir(path.dirname(path.join(root,file)),{recursive:true}); await writeFile(path.join(root,file),text) }
  }
  return Object.keys(outputs)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await generate(process.argv.includes('--check'))
  console.log('Public policy, SQL projections, and contracts agree.')
}
