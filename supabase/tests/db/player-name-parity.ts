import { strict as assert } from 'node:assert'
import { normalizeName } from '../../functions/_shared/nameMatch.ts'
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.equal(new URL(db).hostname, '127.0.0.1')
const names = ["Nikola Jokić", "Jabari Smith Jr.", "Gary Payton II", "D’Angelo Russell", "Karl-Anthony Towns", "P.J. Washington", "A  Name Sr.", "A Name Jr. ", "A\tName\u00a0IV", "  A\u2003Name\uFEFF", "Åna Łukasz", "İlker Name", "ΟΣ Name", "Name ΟΣ", "A\u0085Name", "A\u200BName", "A\u2028Name V", "Name Jr.\n", "O'Name IV", "A: Name", "A\u000BName", "A\u000CName", "\u212Aevin Name", "Ægir Name"]
const quoted = JSON.stringify(names).replaceAll("'", "''")
const sql = `SELECT jsonb_agg(jsonb_build_object('name',name,'normalized',private.player_import_name_key(name),'exact',lower(name)) ORDER BY n) FROM jsonb_array_elements_text('${quoted}'::jsonb) WITH ORDINALITY AS a(name,n);`
const command = new Deno.Command('psql', { args:[db,'-XqAt','-v','ON_ERROR_STOP=1','-c',sql],stdout:'piped',stderr:'piped' })
const result = await command.output()
assert.equal(result.code,0,new TextDecoder().decode(result.stderr))
const rows = JSON.parse(new TextDecoder().decode(result.stdout))
const mismatches = rows.filter((r: {name:string;normalized:string;exact:string}) => r.normalized !== normalizeName(r.name) || r.exact !== r.name.toLowerCase()).map((r: {name:string;normalized:string;exact:string})=>({...r,jsNormalized:normalizeName(r.name),jsExact:r.name.toLowerCase()}))
console.log(JSON.stringify({cases:names.length,mismatches}))
assert.deepEqual(mismatches,[])
