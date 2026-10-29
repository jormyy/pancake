import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function validateStatsCertificationFixture(fixture) {
    assert.equal(fixture.game.nba_game_id, '0022600142')
    assert.equal(fixture.game.home_team, 'DAL')
    assert.equal(fixture.game.away_team, 'OKC')
    assert.equal(fixture.game.status, 'Scheduled')
    assert.ok(fixture.players.some(player => player.first_name === 'Thomas' && player.last_name === 'Sorber'))
    assert.equal(new Set(fixture.players.map(player => player.id)).size, fixture.players.length)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const database = new URL(process.env.SUPABASE_DB_URL)
    assert.equal(database.hostname, '127.0.0.1')
    assert.equal(database.port, '61022')
    const backup = readFileSync(process.env.STATS_BACKUP_PATH, 'utf8')
    const imports = ['players', 'nba_games'].map(table => {
        const marker = `INSERT INTO "public"."${table}" `
        const start = backup.indexOf(marker)
        assert.ok(start >= 0, `Backup lacks ${table}`)
        const end = backup.indexOf(';\n', start)
        assert.ok(end > start)
        return `CREATE TEMP TABLE backup_${table} (LIKE public.${table} INCLUDING DEFAULTS);\n` +
            backup.slice(start, end + 1).replace(marker, `INSERT INTO backup_${table} `)
    }).join('\n')
    const sql = `BEGIN;
    ${imports}
    SELECT jsonb_build_object(
        'provenance', 'Game and player identities from 2026-10-28 backup; live and final stats are reconstructed controls.',
        'game', (SELECT to_jsonb(g) FROM backup_nba_games g WHERE nba_game_id='0022600142'),
        'players', (SELECT jsonb_agg(jsonb_build_object('id', id, 'nba_id', nba_id, 'first_name', first_name,
            'last_name', last_name, 'nba_team', nba_team) ORDER BY nba_team, id)
            FROM backup_players WHERE nba_team IN ('OKC', 'DAL') AND nba_id IS NOT NULL)
    );
    ROLLBACK;`
    const result = execFileSync('psql', [database.href, '-XqAt', '-v', 'ON_ERROR_STOP=1'], {
        input: sql, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    }).trim()
    const fixture = JSON.parse(result)
    validateStatsCertificationFixture(fixture)
    writeFileSync('tests/fixtures/stats-certification/okc-dal.json', JSON.stringify(fixture, null, 2) + '\n')
    console.log(`Reconstructed OKC@DAL identities: ${fixture.players.length} players; backup predates tipoff.`)
}
