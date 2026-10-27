# Player sources

The player sync uses ESPN roster data.
It reads `dateOfBirth` as a calendar date and stores `birthdate`.
Player views calculate age on the current Los Angeles calendar date.
Missing birthdates produce a null age.
Invalid and future birthdates never replace a saved birthdate.

The injury sync reads ESPN `details.type`, `side`, `detail`, and `returnDate`.
It stores a short injury reason and the provider's expected return value.
Missing details use `unknown`.
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
