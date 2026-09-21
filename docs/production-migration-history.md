# Production migration history attestation

The release preflight accepts 24 audited historical names for the production
project `ceeytbfmwsnzalxlkalc`. It does not rename migrations or update database
history. Unknown differences still stop the release.

The names changed in commit `c083075fe75976852fa2307c54d8fc7b3b33e9a6`.
A read-only comparison of the stored statements with that commit's
parent finds all 24 historical SQL sequences. Twenty-one match today's parsed SQL.
Three contain real temporary helper-identifier changes:

| Version | Historical helper spelling | Repository helper spelling |
| --- | --- | --- |
| `20260627000011` | Two lineup helpers use `_unchecked_cycle18`. | They use `_unchecked_legacy`. |
| `20260627000017` | The update helper uses `_uncapped_cycle23`; calls use the cycle18 names. | They use `_unchecked_legacy`. |
| `20260627000025` | The cleanup block renames the cycle18/cycle23 helpers. | It renames the legacy helpers. |

Both sequences converge to the same three `_unchecked` helpers. This is not a
claim that those three historical files have identical SQL. The preflight checks
seven live function bodies, signatures, settings, and effective grants. It also
rejects old helper objects or remaining calls to their old names.

The exact project, versions, old/current names, fingerprints, classifications,
and approved five-migration range live in
[`release-history-attestations.json`](../tests/e2e/release-history-attestations.json).
Repository file fingerprints use SHA-256 over file bytes. Stored SQL fingerprints
use SHA-256 over the concatenated lowercase SHA-256 hex strings of each statement,
in recorded order. Statement counts are checked separately. No SQL normalization
or identifier substitution occurs in the production fingerprint check.

[`release-schema-history.sql`](../tests/e2e/release-schema-history.sql) reads only
metadata inside a READ ONLY transaction. It returns fingerprints, not stored SQL,
function bodies, credentials, or application rows. The workflow validates the
target, checks the linked project's ref before querying, and passes the same ref
to the planner. This also works with the workflow's pinned Supabase CLI 2.109.1.

The generic history planner still requires exact names. The production entry
point accepts only the attested 24 old labels and their exact SQL. It preserves
the original labels in its result. Missing, duplicate, reordered, or foreign
versions fail. Changed attested SQL or source files fail. Changed helper bodies
or grants fail. Unapproved pending files fail.

The approved range ends at `20260921000002`. A partially applied approved range
plans only its remaining suffix. Later schema releases must extend the reviewed
range and update any changed convergence expectations. Unrelated applied rows
retain the ordered version/name check; their SQL is not covered by this audit.

This preflight belongs to the required release-soak workflow. Supabase's own
migration planner compares versions and does not enforce these extra checks.
A successful CLI dry run does not replace release-soak or compatibility gates.
The coordinated deployment workflow also deploys frontend and Edge artifacts;
running this read-only check does not authorize those actions or apply migrations.
