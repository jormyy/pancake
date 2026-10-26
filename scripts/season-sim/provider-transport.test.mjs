import assert from 'node:assert/strict'
import test from 'node:test'
import { originUrl } from './common.mjs'
import { assertFetchTarget } from './fetch-guard.mjs'
import { fantasyPaths, gapSource, providerTransport, unavailableResponse, validGapRoute } from './provider-transport.mjs'

test('only pinned native provider requests map to the controlled origin', () => {
  const sleeper = 'https://api.sleeper.app/projections/nba/2024/1?season_type=regular'
  assert.equal(providerTransport(sleeper).href, `${originUrl('replay')}/sleeper/projections/nba/2024/1?season_type=regular`)
  assert.equal(assertFetchTarget(providerTransport(sleeper)).origin, originUrl('replay'))
  for (const file of fantasyPaths) {
    const mapped = providerTransport(`https://www.fantasypros.com/nba/projections/${file}`)
    assert.equal(mapped.href, `${originUrl('replay')}/fantasypros/nba/projections/${file}`)
    assert.equal(assertFetchTarget(mapped).origin, originUrl('replay'))
  }
})

test('nearby external URLs remain outside the loopback boundary', () => {
  const targets = [
    'http://api.sleeper.app/projections/nba/2024/1?season_type=regular',
    'https://api.sleeper.app.evil.example/projections/nba/2024/1?season_type=regular',
    'https://api.sleeper.app/players/nba',
    'https://api.sleeper.app/projections/nba/2024/1?season_type=post',
    'https://api.sleeper.app/projections/nba/2024/1?season_type=regular&extra=1',
    'https://api.sleeper.app/projections/nba/2024/1?season_type=regular#fragment',
    'https://user:secret@api.sleeper.app/projections/nba/2024/1?season_type=regular',
    'https://www.fantasypros.com/nba/projections/daily-overall.php?extra=1',
    'https://www.fantasypros.com/nba/projections/unknown.php',
    'https://fantasypros.com/nba/projections/daily-overall.php',
    'https://hashtagbasketball.com/fantasy-basketball-dynasty-rankings',
    'https://ceeytbfmwsnzalxlkalc.supabase.co/functions/v1/sync-scores',
  ]
  for (const target of targets) {
    assert.equal(providerTransport(target).href, new URL(target).href)
    assert.throws(() => assertFetchTarget(providerTransport(target)), target)
  }
})

test('unavailable responses carry a fixed policy and attributable source', () => {
  assert.deepEqual(unavailableResponse('sleeper-projections', Date.parse('2024-10-23T12:00:00Z')), {
    code: 'HISTORICAL_UNAVAILABLE', source: 'sleeper-projections', at: '2024-10-23T12:00:00.000Z', policy: 'retained-corpus-v1',
  })
  assert.equal(gapSource('/fantasy-basketball-dynasty-rankings'), 'hashtag-rankings')
  assert.equal(gapSource('/sleeper/players/nba'), 'sleeper-identities')
  assert.equal(gapSource('/sleeper/projections/nba/2024/1'), 'sleeper-projections')
  for (const file of fantasyPaths) assert.equal(gapSource(`/fantasypros/nba/projections/${file}`), 'fantasypros-projections')
  for (const path of ['/sleeper/arbitrary', '/fantasy-basketball-dynasty-rankings/extra', '/fantasypros/nba/projections/unknown.php']) assert.equal(gapSource(path), null)
})

test('career gaps accept only exact source paths and native queries', () => {
  const routes = [
    ['espn-career-stats', '/career/athletes/123/stats?seasontype=2'],
    ['espn-career-biography', '/career/athletes/123'],
    ['espn-career-search', '/career-search?query=Example+Player&type=player&limit=50'],
    ['nba-career-profile', '/nba/player/123'],
  ]
  for (const [source, path] of routes) {
    const url = new URL(`${originUrl('replay')}${path}`)
    assert.equal(gapSource(url.pathname), source)
    assert.equal(validGapRoute(source, url), true)
    assert.equal(validGapRoute(source, new URL(`${url.href}${url.search ? '&' : '?'}extra=1`)), false)
    assert.equal(validGapRoute(source, new URL(`${url.href}#fragment`)), false)
  }
  for (const path of ['/career/unknown', '/career/athletes/name', '/career/athletes/123/unknown', '/nba/player/name']) assert.equal(gapSource(path), null)
  for (const path of [
    '/career/athletes/123/stats', '/career/athletes/123/stats?seasontype=1',
    '/career-search?query=&type=player&limit=50', '/career-search?query=Name&type=team&limit=50',
    '/career-search?query=Name&type=player&limit=100', '/career-search?query=Name&type=player&limit=50&query=Other',
  ]) {
    const url = new URL(`${originUrl('replay')}${path}`)
    assert.equal(validGapRoute(gapSource(url.pathname), url), false, path)
  }
})
