# Migration phase timings

PostgreSQL has 0.25 CPU and 1 GiB. Three interleaved runs use the restored 245,097 rows.

Times are median seconds. The JSON includes every run and individual function, index, and FK timings.

| Phase | Before | After |
| --- | ---: | ---: |
| catalog | 0.087 | 0.009 |
| prepare | 0.004 | 0.000 |
| lock_acquired | 0.000 | 0.000 |
| count | 0.112 | 0.000 |
| copy | 11.082 | 0.000 |
| verify | 1.505 | 0.000 |
| swap | 0.001 | 0.000 |
| functions | 0.094 | 0.001 |
| views | 0.003 | 0.004 |
| drop_old_functions | 0.001 | 0.001 |
| publication | 0.000 | 0.000 |
| retire_old_table | 0.309 | 0.485 |
| indexes | 0.001 | 0.000 |
| outgoing_fks | 0.191 | 0.000 |
| incoming_fks | 0.000 | 0.000 |
| policies | 0.000 | 0.000 |
| triggers | 0.002 | 0.002 |
| grants | 0.001 | 0.001 |
| prepare_heap | 0.000 | 0.000 |
| copy_verify | 0.000 | 2.799 |
| bulk_indexes | 0.000 | 4.994 |
| index_names | 0.000 | 0.001 |
| outgoing_fks_not_valid | 0.000 | 0.001 |
| incoming_fks_not_valid | 0.000 | 0.000 |
| validate_outgoing_fks | 0.000 | 0.116 |
| validate_incoming_fks | 0.000 | 0.000 |
| Writer lock | 13.603 | 8.294 |
| Complete call | 13.844 | 8.507 |
