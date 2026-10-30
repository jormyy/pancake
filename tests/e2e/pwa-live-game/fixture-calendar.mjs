import { sql } from './database.mjs'

export async function restoreFixtureCalendar(calendar, fixture) {
    await sql(`UPDATE season_weeks week SET week_start=source.week_start,week_end=source.week_end
        FROM jsonb_populate_recordset(NULL::public.season_weeks,'${JSON.stringify(calendar)}'::jsonb) source WHERE week.id=source.id;`)
    const week = Number(await sql(`SELECT week_number FROM season_weeks WHERE season_year=${fixture.seasonYear}
        AND '${fixture.today}'::date BETWEEN week_start AND week_end;`))
    await sql(`UPDATE nba_games game SET week_number=week.week_number FROM season_weeks week
        WHERE game.nba_game_id LIKE '002%0900%' AND game.season_year=week.season_year AND game.game_date BETWEEN week.week_start AND week.week_end;
        UPDATE player_game_stats stats SET week_number=game.week_number FROM nba_games game WHERE stats.game_id=game.id AND game.nba_game_id LIKE '002%0900%';
        UPDATE weekly_lineups SET week_number=${week} WHERE league_id='${fixture.leagueId}' AND game_date='${fixture.today}';
        DELETE FROM matchups WHERE league_id='${fixture.leagueId}' AND week_number=${week} AND week_number<>1;
        UPDATE matchups SET week_number=${week} WHERE league_id='${fixture.leagueId}' AND week_number=1;`)
    return { ...fixture, currentWeek: week }
}
