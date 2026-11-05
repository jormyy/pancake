# Sign-in and account access

Managers sign in, create accounts, and restore a saved session.

## Sub-features

- `auth-login` signs in with a seeded account.
- `auth-invalid` explains missing or incorrect credentials.
- `auth-register` creates an account through Sign up.
- `auth-restore` restores a session after reload.
- `auth-logout` returns to public controls.

## How to get to it (user POV)

- Open the app without a session.
- Follow `New to Pancake? Create an account` from Sign in.
- Profile → Sign out.

## Driving it with agent-browser

Preconditions:

- Require a healthy local auth service and generated seed credentials.

- **Missing input.** Open the printed URL’s `/sign-in` route. Run `BROWSER find role button click --name 'Sign In' --exact`. Require `Please fill in all fields.`
- **Wrong password.** Fill `input[placeholder="you@example.com"]` with the generated test email and `input[placeholder="Your password"]` with a wrong password. Submit and require an error with usable fields.
- **Valid sign-in.** Run `BROWSER login`, then `BROWSER snapshot -i`. Require Home, the seeded team, and its matchup.
- **Restoration.** Run `BROWSER reload`. Require the same team without reentering credentials.
- **Sign-up.** Sign out through Profile. Select the create-account link. Snapshot the labeled fields, complete them with a new disposable address, and submit. Require account creation and the app’s empty-league state.
- **Sign-out.** Profile → Sign out. Require Sign in and no private roster after reload.

## Gotchas

- A successful auth API response does not prove that the exported app accepts the session.
- Do not save screenshots containing populated password fields.
- Registration creates a different account. Sign back into the seed account before league journeys.
