import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

const runtime = globalThis['Deno']
assert.ok(runtime, 'Run with the mini Deno runtime')
runtime.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
runtime.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { tipoffAssignments } = await import(new URL('../../supabase/functions/lineup-optimizer/preTipoff.ts', import.meta.url).href)
const fixture = JSON.parse(await readFile('tests/fixtures/autoset-michael.json', 'utf8'))
const reports = fixture.days.map(day => {
    const teams = new Set(day.games.flatMap(game => [game.homeTeam, game.awayTeam]))
    const context = { date: day.date, seasonYear: fixture.member.season_year, weekNumber: day.weekNumber,
        templates: fixture.templates, stored: day.stored,
        players: fixture.roster.filter(player => !player.isOnIr && !player.isOnTaxi).map(player => ({
            ...player, locked: false, hasGame: teams.has(player.nbaTeam),
        })),
    }
    const assignments = tipoffAssignments(context, day.projections)
    const names = new Map(fixture.roster.map(player => [player.playerId, player.displayName]))
    return { date: day.date, stored: day.stored.length, filled: assignments.length,
        slots: fixture.templates.flatMap(template => {
            const entries = assignments.filter(entry => entry.slot_type === template.slotType)
            return Array.from({ length: template.count }, (_, index) => ({
                slot: template.slotType, player: names.get(entries[index]?.player_id) ?? 'Empty',
            }))
        }), assignments,
    }
})
await writeFile(process.argv[2] ?? '../autoset-replay.json', `${JSON.stringify(reports, null, 2)}\n`)
console.log(JSON.stringify(reports.map(({ date, stored, filled, slots }) => ({ date, stored, filled, slots }))))
