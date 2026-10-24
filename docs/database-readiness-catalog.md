# Database readiness catalog

The catalog gate verifies an attested migration phase without applying migrations. `tests/e2e/db-security-catalog-attestations.json` owns baseline, candidate, source pins, and object contracts.

## Scope

The attested baseline is `20261005000003`; the candidate is `20261011000062`.
These versions do not automatically track the branch head.
Later migrations require reviewed phase contracts before release.

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

Migrations `20261020000001` through `20261020000006` retain existing projection read signatures and result columns.
Authenticated clients can read `sleeper_projection_rows`; only the backend can call `complete_sleeper_projection_sync`.
Private cleanup helpers retain restricted access.
The canonical function catalog records current definitions, owners, and grants.
It is separate from the attested release-phase catalog above.

[Source monitoring](source-monitoring.md) owns snapshot replacement, source precedence, scheduling, and cleanup behavior.
[Verification](verification.md#sleeper-projections-and-weekly-cleanup) lists behavioral, permission, index, and concurrency checks.
These checks do not extend the attested release range.
