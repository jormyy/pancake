# Database readiness catalog

The catalog gate checks an explicit migration phase without applying migrations.
`tests/e2e/db-security-catalog-attestations.json` owns the approved baseline, candidate, source pins, and object contracts.
Those versions describe the attested release range. They do not automatically track HEAD.

The gate checks ordered history, approved aliases, SQL fingerprints, and the linked project.
It also checks function signatures, bodies, owners, search paths, grants, triggers, policies, and indexes.
The roster guard chain includes the private started-game predicate.
Metadata checks complement behavioral tests; they do not replace them.

## Commands

```sh
npm run security:db-catalog -- --linked --phase=pre-migration
npm run security:db-catalog -- --linked --phase=post-migration
npm run security:db-catalog -- --local --phase=post-migration
```

Linked checks require `SUPABASE_PROJECT_REF` and the CLI project link to match the attested project.
Local checks require psql and canonical migration names.
The normal check also probes weak-password signup.
Append `--catalog-only` for read-only metadata inspection; this does not certify full readiness.

Candidate/current-backend checks use the pre-migration phase.
Later pairings and frontend rollback use the post-migration phase because additive migrations remain applied.
Reusable workflows receive the phase explicitly.

## Maintenance

Changed protected objects require reviewed phase contracts and pinned migration sources.
Capture evidence from the baseline and an ordered local upgrade.
Compare the upgraded catalog with a fresh install at the same candidate version.
Do not regenerate pins from an unexplained live difference.
The [production history record](production-migration-history.md) owns historical alias attestations.
A catalog pass does not waive compatibility, artifact, source-health, or release-soak gates.

## Sleeper projection contract

The additive Sleeper migration retains every existing projection RPC signature and result column.
Authenticated clients can read the new store. Only the backend can complete a projection pull.
The completion RPC writes a whole pull in one transaction.
Private cleanup helpers retain backend-only access.
The canonical function catalog includes their owners and grants.
The schedule keeps the existing cron job name and changes its command's due-work logic.
See the focused projection and retention checks in [verification](verification.md).
