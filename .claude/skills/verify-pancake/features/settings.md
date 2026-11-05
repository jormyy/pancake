# Notifications and settings

Managers edit their profile, choose appearance, manage league membership, and control notifications.

## Sub-features

- `settings-profile` edits display and team names.
- `settings-theme` changes appearance.
- `settings-notifications` saves notification categories and delivery preferences.
- `settings-leagues` creates, joins, and switches leagues.
- `settings-password` changes the disposable account’s password.

## How to get to it (user POV)

- Select Profile from main navigation or the profile menu.
- Profile → Notification settings, Create a league, Join a league, or Change password.
- Use the league switcher to select another joined league.

## Driving it with agent-browser

Preconditions:

- Require a seeded manager. The app has notification preferences and push destinations; it has no in-app inbox.

- **Profile.** Select Profile, then Edit. Fill `[aria-label="Display name"]` and `[aria-label="Team name"]`; save and reload. Require both names and matching stored rows.
- **Theme.** Change the `Theme` control through Light, Dark, and Match device. Reload each choice and inspect the visible colors.
- **Notifications.** Select `Notification settings`. Snapshot the actual switches, toggle one category, leave, and reopen. Require persisted choice and its stored preference.
- **Leagues.** Choose Create a league, complete the displayed fields, and submit. Require the new league and membership. Join it as another disposable manager through its invite code, then switch back to the baseline league.
- **Password.** Use Change password on a disposable account. Sign out and sign in with the new value. Never change a real account.
- **Widths.** At 375×812, reach the last setting and the save/submit controls without clipping.

## Gotchas

- Chromium does not prove iOS home-screen push permission or notification delivery.
- Password and membership changes affect later journeys. Use separate disposable accounts or recreate the run.
