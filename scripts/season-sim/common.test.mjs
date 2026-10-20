import assert from 'node:assert/strict'
import test from 'node:test'
import { assertTarget, config, configuration, dates, etDate, historicalSummary, scheduleEntries } from './common.mjs'

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
