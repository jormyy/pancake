# League

League provides standings, schedule, activity, draft tools, picks, settings, and season history.

## Sub-features

- `league-standings` shows team positions and opens team rosters.
- `league-schedule` shows weekly matchups and opens matchup details.
- `league-past-scores` shows every team's stored total through a past matchup's Other matchups strip.
- `league-activity` shows public league events and pagination.
- `league-settings` shows rules, invite code, waiver order, and commissioner controls.
- `league-picks` shows future pick ownership.
- `league-bracket` shows playoff matchups.
- `league-history` shows completed Pancake seasons, final standings, and season statistics.

## How to get to it (user POV)

- Select League from main navigation, then its section tabs.
- Select a team in Standings or a matchup in Schedule.
- Settings → bracket or commissioner settings.
- History → the completed season named in `fixture.json`.

## Driving it with agent-browser

Preconditions:

- Require the active league and current matchup. History requires a completed Pancake season with final standings and statistics.

- **Standings.** Select League and snapshot `League sections`. Select Standings and require all seeded teams. Select the opponent and compare its roster.
- **Schedule.** Select Schedule. Open the current week’s matchup and require both teams, date range, scores, and day controls.
- **Past scores.** Select Schedule, then a completed week. Scroll to Other matchups and swipe through every team. Compare totals with stored matchups. Open another team's card. Return to Schedule and repeat with a different completed week.
- **Activity.** Select Activity. Read the visible events and exercise Load more when present. Compare their order and contents with stored transactions.
- **Settings.** Select Settings. Require rules, invite code, and waiver order. Open commissioner controls as the owner, change one reversible setting, save, reopen, and compare stored league settings.
- **Picks and bracket.** Select Picks and confirm future ownership against stored picks. Open Bracket from Settings and follow a matchup.
- **History.** Select History and require the `pastSeasonYear` from `fixture.json`. Open it and compare final positions and statistics with `fixture.json.history`. Require Team 2 as champion, Team 1 as runner-up, two games, and 420 total points.
- **Widths.** At 375×812 scroll the section row and confirm every section remains reachable.

## Gotchas

- Activity shows transactions. History shows completed Pancake seasons.
- Require `completedPastSeason: true` and the matching final matchup before testing History.
- No playoff fixture means bracket population remains unverified.
- Do not count imported non-Pancake seasons as eligible history.
