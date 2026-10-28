# Rookie drafts

## Linear order

Rookie drafts use linear order by default.
Each original team keeps the same slot in every round.
A traded pick goes to its current owner without moving its original slot.
Commissioners can select `snake` with the `rookie_draft_order` league setting.
Snake order reverses every second round.
Each draft saves its order choice and seed when it starts.
Worse records pick first.
Equal records use higher points per game first, then the stored seed.
Points per game uses the played-game count, not the raw points total.
Rookie mock drafts follow the same saved order rule.
Saved draft orders remain stable when the server repeats generation.
Existing drafts keep their saved snake order.
