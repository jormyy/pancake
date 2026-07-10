import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolveReleaseProvenance, validateReleaseProvenance } from './release-provenance.mjs'
import { DATA_LATENCY_STEP_KEYS } from './data-latency-contract.mjs'

const ROOT = process.cwd()
const MANIFEST_PATH = path.join(ROOT, 'tests/e2e/performance-budgets.json')
const PERF_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-perf-report.md')
const DATA_LATENCY_REPORT_PATH = path.join(ROOT, 'tests/e2e-data-latency-report.md')
const REPORT_PATH = path.join(ROOT, 'tests/performance-budget-report.md')

const cliArgs = process.argv.slice(2)
const args = new Set(cliArgs)
const requireReport = args.has('--require-report')
const requireDataReport = args.has('--require-data-report')
const requireWorkflowReports = args.has('--require-workflow-reports')
const requiredSeasonReports = Number(cliArgs.find((arg) => arg.startsWith('--require-season-reports='))?.split('=')[1] ?? 0)

const readJsonFile = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'))

/** @typedef {{ commitSha: string, runId: string, bundleDigest: string }} ReleaseProvenance */

const getPath = (value, dottedPath) => dottedPath
  .split('.')
  .reduce((current, key) => {
    if (current == null) return undefined
    if (Array.isArray(current)) return current.find((entry) => entry?.id === key || entry === key)
    return current[key]
  }, value)

export const validateManifest = (manifest) => {
  const failures = []
  const workflows = manifest.workflows ?? []
  const budgets = manifest.globalBudgets ?? {}

  if (manifest.version !== 1) failures.push('manifest version must be 1')
  if (workflows.length !== 10) failures.push(`expected 10 top workflows, found ${workflows.length}`)

  const ranks = new Set()
  const ids = new Set()
  for (const workflow of workflows) {
    if (!Number.isInteger(workflow.rank) || workflow.rank < 1 || workflow.rank > 10) {
      failures.push(`${workflow.id ?? workflow.name}: rank must be 1-10`)
    }
    if (ranks.has(workflow.rank)) failures.push(`duplicate workflow rank ${workflow.rank}`)
    ranks.add(workflow.rank)

    if (!workflow.id || ids.has(workflow.id)) failures.push(`missing or duplicate workflow id ${workflow.id}`)
    ids.add(workflow.id)

    for (const field of ['name', 'route', 'frequency', 'pain', 'owner']) {
      if (!workflow[field]) failures.push(`${workflow.id}: missing ${field}`)
    }
    if (!Array.isArray(workflow.criticalPath) || workflow.criticalPath.length < 3) {
      failures.push(`${workflow.id}: criticalPath must name at least 3 dependencies`)
    }
    if (!workflow.measurement?.primary || !workflow.measurement?.report) {
      failures.push(`${workflow.id}: missing measurement command/report`)
    }

    const workflowBudgets = workflow.budgets ?? {}
    for (const key of ['feedbackMs', 'cachedRequestMs', 'fullLoadMs']) {
      if (!Number.isFinite(workflowBudgets[key]) || workflowBudgets[key] <= 0) {
        failures.push(`${workflow.id}: budgets.${key} must be a positive number`)
      }
    }
    if (Number.isFinite(workflowBudgets.feedbackMs) && workflowBudgets.feedbackMs > budgets.instantFeedbackMs) failures.push(`${workflow.id}: feedback budget exceeds ${budgets.instantFeedbackMs}ms`)
    if (Number.isFinite(workflowBudgets.cachedRequestMs) && workflowBudgets.cachedRequestMs > budgets.cachedRequestMs) failures.push(`${workflow.id}: cached request budget exceeds ${budgets.cachedRequestMs}ms`)
    if (Number.isFinite(workflowBudgets.fullLoadMs) && workflowBudgets.fullLoadMs > budgets.fullWorkflowMs) failures.push(`${workflow.id}: full-load budget exceeds ${budgets.fullWorkflowMs}ms`)
  }

  for (let rank = 1; rank <= 10; rank += 1) {
    if (!ranks.has(rank)) failures.push(`missing workflow rank ${rank}`)
  }

  for (const key of ['instantFeedbackMs', 'cachedRequestMs', 'fullWorkflowMs', 'longTaskMs', 'maxHeartbeatLagMs', 'maxMutationLoopMs', 'maxInitialWebJsKb', 'maxRouteWebJsKb', 'maxDbQueryMs']) {
    if (!Number.isFinite(budgets[key]) || budgets[key] <= 0) {
      failures.push(`globalBudgets.${key} must be a positive number`)
    }
  }

  return failures
}

/** @param {any} manifest @param {any} report @param {ReleaseProvenance} [expectedProvenance] */
export const validateBrowserPerfReport = (manifest, report, expectedProvenance = undefined) => {
  const failures = []
  const budgets = manifest.globalBudgets

  if (report.status !== 'PASS') failures.push(`browser perf report status is ${report.status ?? 'missing'}`)

  if (report.draftPerf?.longTaskSupported !== true || report.homePerf?.longTaskSupported !== true) failures.push('browser long-task observation was unavailable')
  for (const [surface, measurement] of [['draft', report.draftPerf], ['home', report.homePerf]]) {
    if (!Number.isFinite(measurement?.maxLagMs) || measurement.maxLagMs < 0) {
      failures.push(`${surface} heartbeat lag must be a finite nonnegative number`)
    } else if (measurement.maxLagMs > budgets.maxHeartbeatLagMs) {
      failures.push(`${surface} heartbeat lag ${measurement.maxLagMs}ms exceeds ${budgets.maxHeartbeatLagMs}ms`)
    }
    if (!Number.isFinite(measurement?.maxLongTaskMs) || measurement.maxLongTaskMs < 0) {
      failures.push(`${surface} max long task must be a finite nonnegative number`)
    } else if (measurement.maxLongTaskMs > budgets.longTaskMs) {
      failures.push(`${surface} long task ${measurement.maxLongTaskMs}ms exceeds ${budgets.longTaskMs}ms`)
    }
  }
  if (!Number.isFinite(report.load?.durationMs) || report.load.durationMs < 0) {
    failures.push('mutation loop duration must be a finite nonnegative number')
  } else if (report.load.durationMs > budgets.maxMutationLoopMs) {
    failures.push(`mutation loop ${report.load.durationMs}ms exceeds ${budgets.maxMutationLoopMs}ms`)
  }

  failures.push(...validateWorkflowReportKeys(manifest, report, 'tests/e2e-browser-perf-report.md', expectedProvenance))

  return failures
}

const budgetMeasurementKeys = {
  feedbackMs: 'feedbackMs',
  fullLoadMs: 'coldFullLoadMs',
}

/** @param {any} manifest @param {any} report @param {string} reportPath @param {ReleaseProvenance} [expectedProvenance] */
export const validateWorkflowReportKeys = (manifest, report, reportPath, expectedProvenance = undefined) => {
  const failures = []
  failures.push(...validateReleaseProvenance(report, expectedProvenance, reportPath))
  if (report.status !== 'PASS') {
    failures.push(`${reportPath} status is ${report.status ?? 'missing'}`)
  }

  for (const workflow of manifest.workflows.filter((item) => item.measurement?.report === reportPath)) {
    for (const key of workflow.measurement?.reportKeys ?? []) {
      if (getPath(report, key) == null) {
        failures.push(`${workflow.id}: ${reportPath} is missing ${key}`)
      }
    }
  }
  const measurements = Array.isArray(report.workflowMeasurements) ? report.workflowMeasurements : []
  const byWorkflow = new Map(measurements.map((measurement) => [measurement.id, measurement]))
  if (byWorkflow.size !== measurements.length) failures.push(`${reportPath} contains duplicate workflow measurements`)
  for (const workflow of manifest.workflows.filter((item) => item.measurement?.report === reportPath)) {
    const measurement = byWorkflow.get(workflow.id)
    if (!measurement) {
      failures.push(`${workflow.id}: ${reportPath} is missing workflow measurement`)
      continue
    }

    for (const [budgetKey, measurementKey] of Object.entries(budgetMeasurementKeys)) {
      if (workflow.budgets?.[budgetKey] != null && !Number.isFinite(measurement[measurementKey])) {
        failures.push(`${workflow.id}: ${reportPath} is missing numeric ${measurementKey}`)
      }
    }
    const timedWarmRequest = Number.isInteger(measurement.warmRequestCount) && measurement.warmRequestCount > 0 &&
      Number.isFinite(measurement.warmCachedRequestMs) && measurement.warmCachedRequestMs >= 0
    const explicitNoWarmRequest = measurement.warmRequestCount === 0 && measurement.warmCachedRequestMs == null &&
      measurement.warmRequestEvidence === 'no-fetch-or-xhr-observed'
    if (!timedWarmRequest && !explicitNoWarmRequest) {
      failures.push(`${workflow.id}: ${reportPath} is missing explicit warm request evidence`)
    }
    if (measurement.feedbackObserved !== true || !measurement.feedbackInteraction) failures.push(`${workflow.id}: ${reportPath} is missing observed interaction feedback`)
    if (workflow.id === 'home-live-lineup') {
      if (!Number.isFinite(measurement.initialWebJsKb) || measurement.initialWebJsKb <= 0) failures.push(`${workflow.id}: ${reportPath} is missing positive initialWebJsKb`)
      else if (measurement.initialWebJsKb > manifest.globalBudgets.maxInitialWebJsKb) failures.push(`${workflow.id}: initial JS ${measurement.initialWebJsKb}KB exceeds ${manifest.globalBudgets.maxInitialWebJsKb}KB`)
    } else {
      const transferredRouteBytes = Number.isFinite(measurement.routeWebJsKb) && measurement.routeWebJsKb > 0
        && Number.isInteger(measurement.routeJsNetworkEntryCount) && measurement.routeJsNetworkEntryCount > 0
      const provenRouteCacheHit = measurement.routeJsCacheHit === true
        && measurement.routeJsNetworkEntryCount === 0
        && Number.isInteger(measurement.routeJsEntryCount) && measurement.routeJsEntryCount > 0
        && Number.isFinite(measurement.routeJsDecodedKb) && measurement.routeJsDecodedKb > 0
      if (!transferredRouteBytes && !provenRouteCacheHit) failures.push(`${workflow.id}: ${reportPath} is missing route JS transfer or cache-hit evidence`)
      const ledger = Array.isArray(measurement.routeJsLedger) ? measurement.routeJsLedger : []
      const ledgerIsValid = ledger.length === measurement.routeJsEntryCount && ledger.every((entry) => (
        typeof entry?.url === 'string' && entry.url.length > 0 &&
        Number.isFinite(entry.encodedBodySize) && entry.encodedBodySize > 0 &&
        Number.isFinite(entry.decodedBodySize) && entry.decodedBodySize > 0
      ))
      if (!ledgerIsValid) failures.push(`${workflow.id}: ${reportPath} is missing a valid route JS provenance ledger`)
      const ledgerEncodedKb = Math.round(ledger.reduce((sum, entry) => sum + Number(entry.encodedBodySize || 0), 0) / 1024 * 10) / 10
      if (!Number.isFinite(measurement.routeJsEncodedKb) || Math.abs(ledgerEncodedKb - measurement.routeJsEncodedKb) > 0.1) {
        failures.push(`${workflow.id}: ${reportPath} route JS encoded total does not match its provenance ledger`)
      } else if (measurement.routeJsEncodedKb > manifest.globalBudgets.maxRouteWebJsKb) {
        failures.push(`${workflow.id}: route JS ${measurement.routeJsEncodedKb}KB exceeds ${manifest.globalBudgets.maxRouteWebJsKb}KB`)
      }
    }

    if (measurement.feedbackMs != null && measurement.feedbackMs > workflow.budgets.feedbackMs) {
      failures.push(`${workflow.id}: ${reportPath} feedback ${measurement.feedbackMs}ms exceeds ${workflow.budgets.feedbackMs}ms`)
    }
    if (measurement.warmCachedRequestMs != null && measurement.warmCachedRequestMs > workflow.budgets.cachedRequestMs) {
      failures.push(`${workflow.id}: ${reportPath} warmed cached request ${measurement.warmCachedRequestMs}ms exceeds ${workflow.budgets.cachedRequestMs}ms`)
    }
    if (measurement.coldFullLoadMs != null && measurement.coldFullLoadMs > workflow.budgets.fullLoadMs) {
      failures.push(`${workflow.id}: ${reportPath} cold full load ${measurement.coldFullLoadMs}ms exceeds ${workflow.budgets.fullLoadMs}ms`)
    }
  }

  return failures
}

/** @param {any} manifest @param {any} report @param {boolean} requireComplete @param {ReleaseProvenance} [expectedProvenance] */
export const validateDataLatencyReport = (manifest, report, requireComplete, expectedProvenance = undefined) => {
  const failures = []
  failures.push(...validateReleaseProvenance(report, expectedProvenance, 'data latency report'))
  const reportedWorkflows = Array.isArray(report.workflows) ? report.workflows : []
  const byWorkflow = new Map(reportedWorkflows.map((workflow) => [workflow.id, workflow]))
  const workflows = manifest.workflows ?? []
  const requestBudget = manifest.globalBudgets.maxDbQueryMs
  const workflowBudget = manifest.globalBudgets.fullWorkflowMs

  if (report.status !== 'PASS') failures.push(`data latency report status is ${report.status ?? 'missing'}`)
  if (requireComplete) {
    if (byWorkflow.size !== reportedWorkflows.length) failures.push('data latency report contains duplicate workflow ids')
    if (JSON.stringify(reportedWorkflows.map((workflow) => workflow?.id)) !== JSON.stringify(workflows.map((workflow) => workflow.id))) {
      failures.push('data latency workflows do not match the canonical ordered contract')
    }
    if (report.budgets?.dataRequestMs !== requestBudget) failures.push(`data latency request budget ${report.budgets?.dataRequestMs ?? 'missing'} does not match manifest ${requestBudget}`)
    if (report.budgets?.workflowTotalMs !== workflowBudget) failures.push(`data latency workflow budget ${report.budgets?.workflowTotalMs ?? 'missing'} does not match manifest ${workflowBudget}`)
    if (typeof report.schemaVersion !== 'string' || !/^\d+$/.test(report.schemaVersion)) {
      failures.push('data latency report is missing applied schema version')
    }
    if (typeof report.repositorySchemaVersion !== 'string' || !/^\d+$/.test(report.repositorySchemaVersion)) {
      failures.push('data latency report is missing repository schema version')
    }
    if (report.schemaVersion && report.repositorySchemaVersion && report.schemaVersion !== report.repositorySchemaVersion) {
      failures.push(`data latency report schema ${report.schemaVersion} does not match repository head ${report.repositorySchemaVersion}`)
    }
  }

  for (const workflow of workflows) {
    const measured = byWorkflow.get(workflow.id)
    if (!measured) {
      failures.push(`${workflow.id}: data latency report is missing workflow`)
      continue
    }
    if (requireComplete && measured.status !== 'PASS') {
      failures.push(`${workflow.id}: data latency workflow status is ${measured.status ?? 'missing'}`)
    }
    if (!Number.isFinite(measured.totalMedianMs) || measured.totalMedianMs < 0) {
      failures.push(`${workflow.id}: data latency total must be a finite nonnegative number`)
    } else if (measured.totalMedianMs > workflowBudget) {
      failures.push(`${workflow.id}: data latency total ${measured.totalMedianMs}ms exceeds ${workflowBudget}ms`)
    }
    const steps = Array.isArray(measured.steps) ? measured.steps : []
    if (requireComplete) {
      const expectedKeys = DATA_LATENCY_STEP_KEYS[workflow.id]
      if (!expectedKeys) {
        failures.push(`${workflow.id}: no canonical data latency step contract exists`)
      } else if (JSON.stringify(steps.map((step) => step?.key)) !== JSON.stringify(expectedKeys)) {
        failures.push(`${workflow.id}: data latency steps do not match the canonical ordered contract`)
      }
      if (steps.length === 0) failures.push(`${workflow.id}: data latency steps are missing`)
    }
    for (const step of steps) {
      if (requireComplete && step.workflowId !== workflow.id) {
        failures.push(`${workflow.id}: data step ${step.label ?? '<missing>'} has mismatched workflowId ${step.workflowId ?? 'missing'}`)
      }
      if (requireComplete && (!Number.isInteger(step.samples) || step.samples < 1)) {
        failures.push(`${workflow.id}: data step ${step.label ?? '<missing>'} samples must be a positive integer`)
      }
      if (requireComplete && (!Number.isInteger(step.rowCount) || step.rowCount < 0)) {
        failures.push(`${workflow.id}: data step ${step.label ?? '<missing>'} rowCount must be a nonnegative integer`)
      }
      if (step.status === 'SKIP') {
        if (requireComplete) failures.push(`${workflow.id}: data step ${step.label} was skipped`)
        continue
      }
      if (step.status !== 'PASS') {
        failures.push(`${workflow.id}: data step ${step.label} status ${step.status}${step.error ? ` (${step.error})` : ''}`)
      } else if (!Number.isFinite(step.medianMs) || step.medianMs < 0) {
        failures.push(`${workflow.id}: data step ${step.label} median must be a finite nonnegative number`)
      } else if (step.medianMs > requestBudget) {
        failures.push(`${workflow.id}: data step ${step.label} ${step.medianMs}ms exceeds ${requestBudget}ms`)
      }
      if (step.status === 'PASS' && (!Number.isFinite(step.maxMs) || step.maxMs < 0)) {
        failures.push(`${workflow.id}: data step ${step.label} max must be a finite nonnegative number`)
      } else if (step.status === 'PASS' && step.maxMs > manifest.globalBudgets.maxDbQueryMs) {
        failures.push(`${workflow.id}: data step ${step.label} max ${step.maxMs}ms exceeds ${manifest.globalBudgets.maxDbQueryMs}ms`)
      }
      if (step.status === 'PASS' && Number.isFinite(step.medianMs) && Number.isFinite(step.maxMs) && step.maxMs < step.medianMs) {
        failures.push(`${workflow.id}: data step ${step.label} max is below its median`)
      }
    }
    if (requireComplete && Number.isFinite(measured.totalMedianMs) && steps.every((step) => Number.isFinite(step?.medianMs))) {
      const summedMedianMs = Math.round(steps.reduce((sum, step) => sum + step.medianMs, 0) * 10) / 10
      if (measured.totalMedianMs !== summedMedianMs) {
        failures.push(`${workflow.id}: data latency total ${measured.totalMedianMs}ms does not equal step medians ${summedMedianMs}ms`)
      }
    }
  }

  return failures
}

/** @param {any} manifest @param {any[]} reports @param {number} expectedSeasons @param {ReleaseProvenance} [expectedProvenance] */
export const validateRetainedSeasonReports = (manifest, reports, expectedSeasons, expectedProvenance = undefined) => {
  const failures = []
  const byKey = new Map(reports.map((report) => [`${report.scenario}:${report.season}`, report]))
  for (let season = 1; season <= expectedSeasons; season += 1) {
    for (const [scenario, reportPath] of [['smoke', 'tests/e2e-browser-report.md'], ['performance', 'tests/e2e-browser-perf-report.md']]) {
      const retained = byKey.get(`${scenario}:${season}`)
      if (!retained) {
        failures.push(`season ${season}: retained ${scenario} report is missing`)
        continue
      }
      failures.push(...validateReleaseProvenance(retained, expectedProvenance, `season ${season} retained ${scenario}`))
      if (retained.status !== 'PASS') failures.push(`season ${season}: retained ${scenario} status is ${retained.status ?? 'missing'}`)
      if (!retained.result || typeof retained.result !== 'object') {
        failures.push(`season ${season}: retained ${scenario} result is missing`)
        continue
      }
      const reportFailures = scenario === 'performance'
        ? validateBrowserPerfReport(manifest, retained.result, expectedProvenance)
        : validateWorkflowReportKeys(manifest, retained.result, reportPath, expectedProvenance)
      failures.push(...reportFailures.map((failure) => `season ${season}: ${failure}`))
    }
  }
  return failures
}

const tableCell = (value) => String(value ?? '')
  .replaceAll('\\', '\\\\')
  .replaceAll('|', '\\|')
  .replaceAll('\n', '<br>')

const writeReport = async ({ manifest, manifestFailures, reportFailures, reportPresent, dataReportPresent }) => {
  const rows = manifest.workflows
    .sort((a, b) => a.rank - b.rank)
    .map((workflow) => ({
      rank: workflow.rank,
      workflow: workflow.name,
      route: workflow.route,
      budgets: `${workflow.budgets.feedbackMs}/${workflow.budgets.cachedRequestMs}/${workflow.budgets.fullLoadMs}ms`,
      measurement: workflow.measurement.primary,
    }))
  const failures = [...manifestFailures, ...reportFailures]
  const lines = [
    '# Performance Budget Check',
    '',
    `- Status: ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Browser perf report: ${reportPresent ? 'present' : 'missing'}`,
    `- Data latency report: ${dataReportPresent ? 'present' : 'missing'}`,
    '',
    '| Rank | Workflow | Route | Feedback/Cached/Full | Measurement |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.rank} | ${tableCell(row.workflow)} | ${tableCell(row.route)} | ${row.budgets} | ${tableCell(row.measurement)} |`),
    '',
  ]

  if (failures.length > 0) {
    lines.push('## Failures', '', ...failures.map((failure) => `- ${failure}`), '')
  } else if (!reportPresent) {
    lines.push(
      '## Notes',
      '',
      '- Static budget manifest passed. Run `npm run e2e:browser-perf && npm run perf:budget -- --require-report` to enforce measured browser responsiveness.',
      '',
    )
  }

  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`)
}

const main = async () => {
  const manifest = readJsonFile(MANIFEST_PATH)
  const manifestFailures = validateManifest(manifest)
  const reportPresent = existsSync(PERF_REPORT_PATH)
  const dataReportPresent = existsSync(DATA_LATENCY_REPORT_PATH)
  const reportFailures = []
  const optionalReports = Array.from(new Set(
    manifest.workflows
      .map((workflow) => workflow.measurement?.report)
      .filter((reportPath) => reportPath && reportPath !== 'tests/e2e-browser-perf-report.md'),
  ))
  const hasWorkflowReport = optionalReports.some((reportPath) => existsSync(path.join(ROOT, reportPath)))
  const expectedProvenance = reportPresent || dataReportPresent || hasWorkflowReport || requiredSeasonReports > 0
    ? await resolveReleaseProvenance()
    : undefined

  if (cliArgs.some((arg) => arg.startsWith('--require-season-reports=')) && (!Number.isInteger(requiredSeasonReports) || requiredSeasonReports < 1)) reportFailures.push('--require-season-reports must be a positive integer')

  if (!reportPresent && requireReport) {
    reportFailures.push(`required browser perf report is missing: ${path.relative(ROOT, PERF_REPORT_PATH)}`)
  }
  if (!dataReportPresent && requireDataReport) {
    reportFailures.push(`required data latency report is missing: ${path.relative(ROOT, DATA_LATENCY_REPORT_PATH)}`)
  }
  if (reportPresent) {
    reportFailures.push(...validateBrowserPerfReport(manifest, readJsonFile(PERF_REPORT_PATH), expectedProvenance))
  }
  if (dataReportPresent) {
    reportFailures.push(...validateDataLatencyReport(manifest, readJsonFile(DATA_LATENCY_REPORT_PATH), requireDataReport, expectedProvenance))
  }
  for (const reportPath of optionalReports) {
    const absoluteReportPath = path.join(ROOT, reportPath)
    if (!existsSync(absoluteReportPath)) {
      if (requireWorkflowReports) reportFailures.push(`required workflow report is missing: ${reportPath}`)
      continue
    }
    reportFailures.push(...validateWorkflowReportKeys(manifest, readJsonFile(absoluteReportPath), reportPath, expectedProvenance))
  }
  if (requiredSeasonReports > 0) {
    const retainedReports = []
    const registryRoot = path.join(ROOT, 'tests/artifacts/registry')
    for (let season = 1; season <= requiredSeasonReports; season += 1) {
      for (const scenario of ['smoke', 'performance']) {
        const reportPath = path.join(registryRoot, `${scenario}-season-${season}.json`)
        if (existsSync(reportPath)) retainedReports.push(readJsonFile(reportPath))
      }
    }
    reportFailures.push(...validateRetainedSeasonReports(manifest, retainedReports, requiredSeasonReports, expectedProvenance))
  }

  await writeReport({ manifest, manifestFailures, reportFailures, reportPresent, dataReportPresent })
  const failures = [...manifestFailures, ...reportFailures]
  console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'} ${path.relative(ROOT, REPORT_PATH)}`)
  if (failures.length > 0) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
