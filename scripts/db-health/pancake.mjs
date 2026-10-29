import { runCli } from './index.mjs'

if (process.argv[2] !== 'db-health') {
  process.stderr.write('Use pancake db-health [--output FILE | --sources | --verify | --walk DIRECTORY | --compare BEFORE AFTER SEASON_DAYS [SIMULATED_DAYS]]\n')
  process.exitCode = 2
} else {
  await runCli(process.argv.slice(3))
}
