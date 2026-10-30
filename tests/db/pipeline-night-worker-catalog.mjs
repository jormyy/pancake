import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync,readdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {homedir} from 'node:os'
import assert from 'node:assert/strict'
import {validateSecurityCatalog} from '../e2e/db-security-catalog-contract.mjs'

assert.match(readFileSync('supabase/config.toml','utf8'),/^project_id = "pt4bafablesr"$/m)
const query=file=>JSON.parse(execFileSync('psql',['postgresql://supabase_admin:postgres@127.0.0.1:64222/postgres','-XqAtv','ON_ERROR_STOP=1','-f',file],{encoding:'utf8',maxBuffer:32*1024*1024}))
const repositoryFiles=readdirSync('supabase/migrations').filter(name=>name.endsWith('.sql')).sort().map(filename=>({filename,sha256:createHash('sha256').update(readFileSync(`supabase/migrations/${filename}`)).digest('hex')}))
const result=validateSecurityCatalog({phase:'post-migration',target:'local',repositoryFiles,
  history:query('tests/e2e/release-schema-history.sql'),catalog:query('tests/e2e/db-security-catalog.sql')})
writeFileSync(path.join(homedir(),'pancake-t_4ba51e0d/lanes/fable-ui27/evidence/worker-catalog.json'),JSON.stringify(result,null,2)+'\n')
process.stdout.write(JSON.stringify(result)+'\n')
