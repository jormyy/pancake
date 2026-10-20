# Live and weekly scoring mutations

Run on the assigned Mac mini copy only. Inputs are SYNTHETIC.

Start `pt4balive` from the repository migrations with API 57321 and database 57322.
Use the task environment and the repository database harness.
Serve Edge functions with `supabase-go functions serve --env-file ../edge.env`.
The local file contains only `PANCAKE_EDGE_INTERNAL_TOKEN=local-database-ci-token`.

```sh
python3 scripts/mutation/live/build_catalog.py
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/run.py --phase baseline --evidence ../evidence
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/run.py --phase tier1 --evidence ../evidence
```

The runner refuses other API and database targets before applying mutations.
It changes deployed SQL definitions or the actual runtime TypeScript files.
Each SQL change overlays the database without changing migration files.
Each oracle runs in a new process, so TypeScript mutations need no server restart.
The runner restores each definition or file and checks its SHA-256 hash.
The runner stops if restoration fails.
It enforces a 120-second timeout for each oracle.

`catalog.json` records source locations, operators, changes, and oracle commands.
`results.jsonl` records every attempt, command, exit code, duration, and log path.
`baseline-commands.json` records the exact commands that pass before mutation.
Run baseline again after strengthening checks.
Use `--ids L09,W01` to repeat selected mutations.
Use `--extra '<command>'` to add an oracle, after its baseline passes.

Keep initial results separately before repeating mutations.
Keep the latest result per identifier in the final `results.jsonl`.
Keep raw evidence outside the repository.

The final catalog uses strengthened checks.
The evidence retains the initial oracle results and their weaker coverage.
The idle scoring regression needs the additive migration in this change.
