import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { config, fixtureDirectory, laneDirectory, miniRoot, season, sha256, writeGzip, writeJson } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { sql, sqlJson } from './local-stack.mjs'
import { remapGame } from './next-season.mjs'
import { shiftDay } from './season-model.mjs'
import { validateDatabaseWindow } from './database-window-contract.mjs'
import { verifyCronCatalog } from './cron.mjs'
import { configurePlanCapture } from './database-capture.mjs'
import { snapshot } from '../db-health/index.mjs'
import { clearDatabaseWindowReports, projectReplayGrowth } from './database-window-growth.mjs'
import { runWithCleanup } from './cleanup.mjs'
import { providerSnapshot } from './database-providers.mjs'
import { labTarget } from '../perf-lab/target.mjs'

export async function prepareDatabaseWindow(start) {
  assert.equal(config.project, process.env.PERF_LAB_PROJECT ? labTarget().project : 'pt4bafabledb')
  assert.match(start, /^\d{4}-\d{2}-\d{2}$/)
  const jobs=process.env.SEASON_SIM_CRON_CATALOG
    ? JSON.parse(await readFile(process.env.SEASON_SIM_CRON_CATALOG,'utf8'))
    : await sqlJson('SELECT coalesce(jsonb_agg(jsonb_build_object(\'jobname\',jobname,\'schedule\',schedule,\'command\',command)),\'[]\'::jsonb) FROM cron.job','Installed database cadence')
  verifyCronCatalog(jobs)
  await writeJson(path.join(miniRoot,'cron-jobs.json'),jobs)
  await writeJson(path.join(miniRoot,'cron-catalog-evidence.json'),{capturedAt:new Date().toISOString(),installedRows:jobs.length,scope:process.env.SEASON_SIM_CRON_CATALOG?'Pinned installed cron catalog from the private stack setup.':'Installed cron catalog before the database workload clock starts.'})
  const end = shiftDay(start, 1)
  assert.ok(start > season.start && end < season.end, 'The database window must stay within one season')
  const calendar = await sqlJson(`SELECT jsonb_agg(jsonb_build_object('id',nba_game_id,'date',game_date,'time',game_time,'weekNumber',week_number,
    'home',home_team,'away',away_team) ORDER BY game_date,nba_game_id) FROM public.nba_games
    WHERE season_year=${season.year} AND nba_game_id LIKE '${season.prefix}%' AND game_time IS NOT NULL`, 'Database window calendar')
  assert.ok(calendar.length > 1000, 'The restored calendar must cover the season')
  const selected = calendar.filter(game => game.date >= start && game.date <= end)
  assert.ok([start,end].every(date => selected.some(game => game.date === date)), 'Both workload days require games')
  assert.equal(Number(await sql(`SELECT count(*) FROM public.player_game_stats WHERE game_date BETWEEN '${start}' AND '${end}'`)),0,
    'Choose two dates after the restored played games')
  const source = path.join(miniRoot, 'fixtures')
  const destination = await laneDirectory(path.join(miniRoot, 'window-fixtures'))
  execFileSync('cp', ['-c', '-R', `${source}/.`, destination])
  const original = JSON.parse(await readFile(path.join(source, 'games.json'), 'utf8'))
  const history = original.games.filter(game => game.id.startsWith(`002${String(season.year-2).slice(-2)}`))
  assert.ok(history.length > 1000, 'The mapping requires a complete historical season')
  const store = await fixtureStore(source)
  const manifestSource = await readFile(path.join(source, 'manifest.jsonl'), 'utf8')
  const added = [], mappedGames = [], mapping = []
  const providerPlayers=await sqlJson("SELECT jsonb_agg(jsonb_build_object('id',id,'sleeper_id',sleeper_id,'espn_id',espn_id,'nba_id',nba_id,'first_name',first_name,'last_name',last_name,'nba_team',nba_team,'position',position,'years_exp',years_exp,'birthdate',birthdate) ORDER BY id) FROM public.players",'Backup provider identities')
  const providerProjections=await sqlJson(`SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.id),'[]') FROM public.sleeper_projection_rows row WHERE row.season_year=${season.year}`,'Backup projection rows')
  const providerRankings=await sqlJson("SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY source,source_rank),'[]') FROM public.dynasty_rankings row",'Backup ranking rows')
  const providerBytes=Buffer.from(JSON.stringify({...providerSnapshot(providerPlayers,season.year,providerProjections),rankings:providerRankings}))
  const providerHash=sha256(providerBytes),providerFile=`database-sleeper-identities-${providerHash}.json.gz`
  await writeGzip(path.join(destination,providerFile),providerBytes)
  added.push({key:'database-sleeper-identities',file:providerFile,sha256:providerHash,status:200,bytes:providerBytes.length,provenance:'SYNTHETIC',template:'restored-backup'})
  for (const target of calendar) {
    const template = history.find(game => game.home === target.home && game.away === target.away)
    assert.ok(template, `A historical same-team template is required for ${target.id}`)
    const mapped = remapGame(await store.json(`boxscore-${template.id}`), await store.json(`playbyplay-${template.id}`), template, target)
    for (const [kind, payload] of [['boxscore',mapped.box],['playbyplay',mapped.pbp]]) {
      const bytes = Buffer.from(JSON.stringify(payload)), hash = sha256(bytes), key = `${kind}-${target.id}`, file = `${key}-${hash}.json.gz`
      await writeGzip(path.join(destination,file),bytes)
      added.push({ key,file,sha256:hash,status:200,bytes:bytes.length,provenance:'SYNTHETIC',template:`${kind}-${template.id}` })
    }
    assert.ok(template.espnId, `A historical ESPN roster identity is required for ${target.id}`)
    mappedGames.push({...target,espnId:template.espnId,provenance:'SYNTHETIC'})
    mapping.push({target:target.id,template:template.id})
  }
  await writeFile(path.join(destination,'manifest.jsonl'),`${manifestSource.trim()}\n${added.map(row=>JSON.stringify(row)).join('\n')}\n`)
  await writeJson(path.join(destination,'games.json'),{games:[...history,...mappedGames]})
  await writeJson(path.join(destination,'schedule.json'),{games:mappedGames.map(game=>({...game,status:'STATUS_SCHEDULED',notes:[]}))})
  await unlink(path.join(destination,'two-season-plan.json')).catch(error=>{if(error.code!=='ENOENT')throw error})
  const result=validateDatabaseWindow({version:1,start,end,days:2,seasonYear:season.year,games:selected.length,
    provenance:'SYNTHETIC',sourceManifestSha256:sha256(manifestSource),
    scheduleProvenance:'Restored backup calendar; historical same-team box scores and live events are mapped to its dates.',mapping},config.project,season.year)
  await writeJson(path.join(miniRoot,'database-window.json'),result)
  return {start,end,games:selected.length,mappedGames:mappedGames.length}
}

async function runDatabaseWindow() {
  assert.equal(fixtureDirectory,path.join(miniRoot,'window-fixtures'))
  assert.equal(process.env.SEASON_SIM_DATABASE_WINDOW,path.join(miniRoot,'database-window.json'))
  const window=validateDatabaseWindow(JSON.parse(await readFile(process.env.SEASON_SIM_DATABASE_WINDOW,'utf8')),config.project,season.year)
  await laneDirectory(path.join(miniRoot,'evidence'))
  await laneDirectory(path.join(miniRoot,'state'))
  await clearDatabaseWindowReports(miniRoot)
  const { replay }=await import('./replay.mjs')
  let before
  const result=await runWithCleanup(async()=>{
    const result=await replay({start:window.start,days:2,'late-season':true,onWorkloadReady:async()=>{
      if(process.env.SEASON_SIM_CAPTURE_PLANS==='1')await configurePlanCapture({project:config.project,execute:sql,enabled:true})
      before=snapshot(process.env.SUPABASE_DB_URL)
      await writeJson(path.join(miniRoot,'growth-before.json'),before)
    }})
    assert.equal(result.complete,true)
    assert.equal(result.days.length,2)
    assert.equal(result.triggerFidelity.verified,true)
    const after=snapshot(process.env.SUPABASE_DB_URL)
    await writeJson(path.join(miniRoot,'growth-after.json'),after)
    if(process.env.SEASON_SIM_CAPTURE_PLANS==='1')await configurePlanCapture({project:config.project,execute:sql,enabled:false})
    const seasonDays=(Date.parse(season.end)-Date.parse(season.start))/86400000+1
    await writeJson(path.join(miniRoot,'evidence/database-growth.json'),projectReplayGrowth(before,after,seasonDays,window.days))
    await writeJson(path.join(miniRoot,'evidence/database-window-result.json'),{...result,databaseWindow:window})
    return result
  },async()=>{
    try {
      if(process.env.SEASON_SIM_CAPTURE_PLANS==='1')await configurePlanCapture({project:config.project,execute:sql,enabled:false})
    } finally {
      const restore=await readFile(new URL('./restore-clock.sql',import.meta.url),'utf8')
      await sql(restore.slice(restore.indexOf('BEGIN;')))
    }
  })
  return {complete:result.complete,days:result.days.length,liveSamples:result.liveSamples}
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try {
    assert.ok(process.argv[2]==='--prepare'||process.argv[2]==='--run')
    console.log(JSON.stringify(process.argv[2]==='--prepare'?await prepareDatabaseWindow(process.argv[3]):await runDatabaseWindow()))
  }catch(error){console.error(error);process.exitCode=1}
}
