import assert from 'node:assert/strict'
import test from 'node:test'
import { homedir } from 'node:os'
import path from 'node:path'
import { assertTarget, config, configuration, dates, etDate, historicalSummary, scheduleEntries } from './common.mjs'
import { databaseEnvironment } from './local-stack.mjs'

test('an explicit lab assignment binds the simulator root, project, and port block', () => {
  const env = { PERF_LAB_LANE: 'fable-r271', PERF_LAB_PROJECT: 'pt4bafabler271', PERF_LAB_PORT_PREFIX: '612',
    SEASON_SIM_ROOT: path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-r271'),
    SEASON_SIM_PROJECT: 'pt4bafabler271', SEASON_SIM_PORT_PREFIX: '612' }
  assert.equal(configuration(env).ports.db, 61222)
  for (const changed of [{ SEASON_SIM_ROOT: env.SEASON_SIM_ROOT + '-other' },
    { SEASON_SIM_PROJECT: 'pt4baother' }, { SEASON_SIM_PORT_PREFIX: '613' },
    { SEASON_SIM_CONTAINER: 'supabase_db_pt4baother' }]) assert.throws(() => configuration({ ...env, ...changed }))
})

test('the database audit binds its exact root, project, and port block', () => {
  const env = { SEASON_SIM_ROOT: path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-timeline/db'),
    SEASON_SIM_PROJECT: 'pt4bafabledb', SEASON_SIM_PORT_PREFIX: '574' }
  assert.equal(configuration(env).ports.db, 57422)
  for (const changed of [{ SEASON_SIM_ROOT: env.SEASON_SIM_ROOT + '-other' },
    { SEASON_SIM_PROJECT: 'pt4bafableux' }, { SEASON_SIM_PORT_PREFIX: '589' },
    { SEASON_SIM_CONTAINER: 'supabase_db_pt4bafableux' }]) {
    assert.throws(() => configuration({ ...env, ...changed }))
  }
})

test('database connections cannot inherit a different host or service', () => {
  const poisoned = { PGHOSTADDR: '198.51.100.1', PGSERVICE: 'wrong-service', PGSERVICEFILE: '/missing-service', PGSSLMODE: 'require' }
  const previous = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]))
  Object.assign(process.env, poisoned)
  try {
    const env = databaseEnvironment(new URL(`postgresql://postgres:fixture@localhost:${config.ports.db}/postgres`))
    assert.equal(env.PGSSLMODE, 'disable')
    assert.equal(env.PGHOST, '127.0.0.1')
    assert.equal(env.PGHOSTADDR, '127.0.0.1')
    assert.equal(Object.hasOwn(env, 'PGSERVICE'), false)
    assert.equal(Object.hasOwn(env, 'PGSERVICEFILE'), false)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('write targets reject hosted, disguised, wrong-port, and redirected origins', () => {
  for (const target of [
    'https://ceeytbfmwsnzalxlkalc.supabase.co',
    `http://127.0.0.1.example.com:${config.ports.api}`,
    'http://127.0.0.1:54321',
    `http://localhost:${config.ports.db}`,
    `http://localhost:${config.ports.api}/functions/v1/api`,
    `http://localhost:${config.ports.api}?target=production`,
    `http://localhost:${config.ports.api}#production`,
    `http://user@localhost:${config.ports.api}`,
    `https://localhost:${config.ports.api}`,
  ]) assert.throws(() => assertTarget(target, 'api'), target)
  assert.equal(assertTarget(`http://127.0.0.1:${config.ports.api}`, 'api').port, String(config.ports.api))
  assert.equal(assertTarget(`postgresql://postgres:test@localhost:${config.ports.db}/postgres`, 'db').port, String(config.ports.db))
})

test('historical summaries exclude current injuries and news, but retain dated game recaps', () => {
  const result = historicalSummary({
    injuries: [{ team: { abbreviation: 'OKC' }, injuries: [
      { date: '2026-10-19T02:51Z', status: 'Out' },
      { date: '2025-10-21T02:51Z', status: 'Out' },
      { status: 'Out' },
    ] }],
    news: { articles: [{ published: '2026-10-19T02:51Z', headline: 'Current news' }] },
    article: { published: '2025-10-22T03:20:59Z', headline: 'Game recap' },
  }, '2025-10-21T23:30Z')
  assert.equal(result.injuries.length, 1)
  assert.deepEqual(result.news.map(article => article.headline), ['Game recap'])
  assert.equal(result.rejectedInjuries, 2)
  assert.equal(result.rejectedNews, 1)
})

test('regular-season discovery excludes exhibition teams and the Cup championship', () => {
  const event = (id, home, notes = [], type = 2) => ({ id, date: '2025-10-22T02:00Z', season: { type }, status: { type: { name: 'STATUS_FINAL', completed: true } }, competitions: [{ notes, competitors: [{ homeAway: 'home', team: { abbreviation: home } }, { homeAway: 'away', team: { abbreviation: 'GS' } }] }] })
  const result = scheduleEntries({ events: [event('real', 'LAL'), event('allstar', 'STR'), event('cup', 'NY', [{ headline: 'NBA Cup Championship' }]), event('preseason', 'LAL', [], 1)] }, '2025-10-21')
  assert.deepEqual(result.map(game => game.espnId), ['real'])
  assert.equal(result[0].away, 'GSW')
  assert.equal(result[0].date, '2025-10-21')
})

test('season date iteration spans daylight saving changes without losing dates', () => {
  assert.equal(dates('2025-10-21', '2026-04-12').length, 174)
  assert.equal(etDate('2025-11-03T04:30:00Z'), '2025-11-02')
})

test('task projects accept configured blocks and refuse remote sockets or foreign containers', () => {
  for (const [name, prefix] of [['sim', '572'], ['live', '573'], ['post', '574']]) {
    const result = configuration({ SEASON_SIM_PROJECT: `pt4ba${name}`, SEASON_SIM_PORT_PREFIX: prefix, DOCKER_HOST: 'unix:///task/docker.sock' })
    assert.equal(result.ports.api, Number(`${prefix}21`))
    assert.equal(result.container, `supabase_db_pt4ba${name}`)
    assert.equal(result.socket, '/task/docker.sock')
  }
  assert.throws(() => configuration({ DOCKER_HOST: 'tcp://remote:2375' }))
  assert.throws(() => configuration({ SEASON_SIM_CONTAINER: 'supabase_db_other' }))
  assert.throws(() => configuration({ SEASON_SIM_PROJECT: 'ceeytbfmwsnzalxlkalc' }))
  assert.throws(() => configuration({ SEASON_SIM_PORT_PREFIX: '543' }))
})

test('the supplemental stack accepts only its exact assigned root, project and block',()=>{
  const root=config.root.replace(/\/lanes\/[^/]+$/,'/lanes/sim-supp')
  assert.equal(configuration({SEASON_SIM_ROOT:root,SEASON_SIM_PROJECT:'pt4basimx',SEASON_SIM_PORT_PREFIX:'581'}).ports.api,58121)
  for(const env of [
    {SEASON_SIM_ROOT:root,SEASON_SIM_PROJECT:'pt4basim',SEASON_SIM_PORT_PREFIX:'581'},
    {SEASON_SIM_ROOT:root.replace('/lanes/sim-supp','/lanes/sim'),SEASON_SIM_PROJECT:'pt4basimx',SEASON_SIM_PORT_PREFIX:'581'},
    {SEASON_SIM_ROOT:root,SEASON_SIM_PROJECT:'pt4basimx',SEASON_SIM_PORT_PREFIX:'582'},
  ])assert.throws(()=>configuration(env))
})

test('the replacement replay accepts only its exact separate root, project and block',()=>{
  const root=config.root.replace(/\/lanes\/[^/]+$/,'/lanes/sim-t6')
  const env={SEASON_SIM_ROOT:root,SEASON_SIM_PROJECT:'pt4basim6',SEASON_SIM_PORT_PREFIX:'582'}
  const result=configuration(env)
  assert.equal(result.ports.api,58221)
  assert.equal(result.ports.db,58222)
  assert.equal(result.container,'supabase_db_pt4basim6')
  for(const invalid of [
    {...env,SEASON_SIM_ROOT:root.replace('/lanes/sim-t6','/lanes/sim')},
    {...env,SEASON_SIM_PROJECT:'pt4basim'},
    {...env,SEASON_SIM_PORT_PREFIX:'572'},
    {...env,SEASON_SIM_PROJECT:'pt4basim',SEASON_SIM_PORT_PREFIX:'572'},
    {...env,SEASON_SIM_CONTAINER:'supabase_db_pt4basim'},
  ])assert.throws(()=>configuration(invalid))
})

test('fresh replay snapshots stay in their configured root, outside shared inputs',()=>{
  for(const name of ['sim','sim-t6']){
    const root=config.root.replace(/\/lanes\/[^/]+$/,`/lanes/${name}`)
    const env={SEASON_SIM_ROOT:root,SEASON_SIM_PROJECT:name==='sim'?'pt4basim':'pt4basim6',SEASON_SIM_PORT_PREFIX:name==='sim'?'572':'582'}
    assert.equal(configuration(env).snapshots,`${root}/snapshots`)
  }
})

test('the private repair replay accepts only its assigned root, project and block', () => {
  const root = config.root.replace(/\/lanes\/[^/]+$/, '/lanes/fable-timeline/replay/run')
  const env = { SEASON_SIM_ROOT: root, SEASON_SIM_PROJECT: 'pt4bafablefix', SEASON_SIM_PORT_PREFIX: '587' }
  assert.equal(configuration(env).ports.api, 58721)
  for (const changed of [
    { SEASON_SIM_ROOT: root + '-other' },
    { SEASON_SIM_PROJECT: 'pt4basim' },
    { SEASON_SIM_PORT_PREFIX: '572' },
    { SEASON_SIM_CONTAINER: 'supabase_db_other' },
  ]) assert.throws(() => configuration({ ...env, ...changed }))
})
