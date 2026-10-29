# Extended slow screen measurements

Each time is the largest p95 across three managers and the tested variants.

## Addendum changes from 75196628

| CPU | Function | Before fresh ms | After fresh ms | Before warm ms | After warm ms | Before / after warm buffers |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | view_roster | 17.70 | 13.44 | 3.88 | 3.08 | 399 / 399 |
| 1 | view_players | 45.66 | 47.71 | 23.38 | 27.16 | 2107 / 2107 |
| 1 | view_league | 7.41 | 8.60 | 1.06 | 0.92 | 162 / 162 |
| 1 | view_trades | 20.68 | 19.95 | 10.20 | 8.47 | 595 / 388 |
| 1 | view_player | 41.05 | 36.80 | 18.89 | 14.13 | 2241 / 1421 |
| 1 | view_trade_block | 15.23 | 13.04 | 3.01 | 2.56 | 416 / 368 |
| 1 | get_trade_revaluation_inputs | 28.18 | 28.84 | 10.01 | 8.77 | 924 / 1007 |
| 1 | 40-card trades | 269.80 | 25.37 | 224.48 | 15.17 | 24472 / 2126 |
| 0.25 | view_roster | 89.07 | 94.52 | 80.47 | 77.41 | 381 / 381 |
| 0.25 | view_players | 206.13 | 290.34 | 108.88 | 109.88 | 2085 / 2085 |
| 0.25 | view_league | 80.25 | 51.74 | 1.56 | 75.98 | 159 / 159 |
| 0.25 | view_trades | 104.46 | 97.88 | 84.35 | 83.65 | 595 / 387 |
| 0.25 | view_player | 208.62 | 204.92 | 101.25 | 100.73 | 2181 / 1361 |
| 0.25 | view_trade_block | 99.81 | 100.90 | 79.32 | 6.05 | 358 / 327 |
| 0.25 | get_trade_revaluation_inputs | 181.46 | 104.23 | 84.66 | 81.80 | 896 / 979 |
| 0.25 | 40-card trades | 1078.46 | 105.31 | 981.48 | 94.28 | 24472 / 2095 |

## Combined changes from release 2.8, 628c7def

| CPU | Function | Before fresh ms | After fresh ms | Before warm ms | After warm ms | Before / after warm buffers |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | view_roster | 13.87 | 12.84 | 4.18 | 2.70 | 504 / 399 |
| 1 | view_players | 42.10 | 43.62 | 38.64 | 20.06 | 2165 / 2052 |
| 1 | view_league | 3.28 | 4.14 | 0.65 | 0.45 | 49 / 40 |
| 1 | view_trades | 34.67 | 15.62 | 18.76 | 5.76 | 1683 / 387 |
| 1 | view_player | 26.51 | 28.29 | 13.88 | 7.48 | 1023 / 821 |
| 1 | view_trade_block | 15.43 | 12.84 | 4.92 | 2.44 | 530 / 368 |
| 1 | get_trade_revaluation_inputs | 33.50 | 27.24 | 16.69 | 6.91 | 992 / 1007 |
| 1 | 40-card trades | 558.82 | 24.11 | 515.52 | 15.22 | 76126 / 2170 |
| 0.25 | view_roster | 92.62 | 94.01 | 81.52 | 3.10 | 539 / 434 |
| 0.25 | view_players | 281.87 | 287.83 | 202.83 | 96.51 | 2206 / 2093 |
| 0.25 | view_league | 80.62 | 4.24 | 0.70 | 77.06 | 55 / 46 |
| 0.25 | view_trades | 186.49 | 95.05 | 95.26 | 6.57 | 1854 / 539 |
| 0.25 | view_player | 180.54 | 183.24 | 90.70 | 83.14 | 1064 / 862 |
| 0.25 | view_trade_block | 91.95 | 92.53 | 81.25 | 77.91 | 571 / 390 |
| 0.25 | get_trade_revaluation_inputs | 101.61 | 182.81 | 100.71 | 83.19 | 992 / 1007 |
| 0.25 | 40-card trades | 2378.67 | 101.32 | 2189.63 | 94.39 | 72718 / 2123 |
