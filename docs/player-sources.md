# Player sources

The player sync uses ESPN roster data.
It reads `dateOfBirth` as a calendar date and stores `birthdate`.
Player views calculate age on the current Los Angeles calendar date.
Age appears before experience in shared player rows.
Views include birthdates where available.
The shared age hook batches missing birthdate reads by player or NBA ID.
Account changes clear that fallback cache and reject late results.
Missing birthdates produce a null age.
Invalid and future birthdates never replace a saved birthdate.

The injury sync reads ESPN `details.type`, `side`, `detail`, and `returnDate`.
It stores a short injury reason and the provider's expected return value.
Missing details use `unknown`.
The return value remains a provider estimate, not a guaranteed return date.
A successful report refreshes details even when the injury status stays the same.
An unavailable or malformed report leaves saved injuries unchanged.

## Experience audit

The audit reads ten players from three ESPN rosters on 2026-10-27.
The source season is 2026–27, with ending year 2027.
ESPN's experience includes the current season for returning players.
The app stores completed seasons, with zero for rookies.
The old direct mapping is one too high for returning players.
The fixed mapping subtracts one from positive ESPN experience and preserves zero.
Debut-year fallback uses season ending year minus debut year minus one.
The dormant Sleeper source keeps its own completed-season value.

| Player | ESPN experience | Completed seasons |
| --- | ---: | ---: |
| Nickeil Alexander-Walker | 8 | 7 |
| Dyson Daniels | 5 | 4 |
| RayJ Dennis | 3 | 2 |
| Luguentz Dort | 8 | 7 |
| Devin Carter | 3 | 2 |
| Chris Cenac Jr. | 0 | 0 |
| Mike Conley | 20 | 19 |
| Cameron Carr | 0 | 0 |
| Luka Doncic | 9 | 8 |
| Quentin Grimes | 6 | 5 |

Sources: [ESPN roster 1](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/1/roster), [ESPN roster 2](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/2/roster), [ESPN roster 3](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/13/roster).
The reduced source sample lives beside the sync tests as `experience-fixtures.json`.

## Roster identity checks

An ESPN or Sleeper ID must agree with its stored owner's normalized name.
A conflicting name returns an ambiguous result and changes no player data.
An ambiguous import fails the sync and blocks roster cleanup.
The ESPN listing refuses repeated athlete IDs across roster pages before any import starts.
A verified identity can change teams without changing its player ID.

Fresh ESPN listings repair missing or impossible game-team memberships within the known listing period.
A valid historical game side stays unchanged after a trade.
The repair migration also uses a newer stored listing to correct an older player team.

The identity regression uses a synthetic traded player and source-ID collision.
It checks stored identity and listing evidence without hardcoding a real player’s team.
