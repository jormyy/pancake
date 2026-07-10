import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const MANIFEST_PATH = path.join(ROOT, 'tests/e2e/performance-budgets.json')
const PERF_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-perf-report.md')
const DATA_LATENCY_REPORT_PATH = path.join(ROOT, 'tests/e2e-data-latency-report.md')
const REPORT_PATH = path.join(ROOT, 'tests/performance-budget-report.md')

const args = new Set(process.argv.slice(2))
const requireReport = args.has('--require-report')
const requireDataReport = args.has('--require-data-report')
const requireWorkflowReports = args.has('--require-workflow-reports')

const readJsonFile = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'))

const getPath = (value, dottedPath) => dottedPath
  .split('.')
  .reduce((current, key) => {
    if (current == null) return undefined
    if (Array.isArray(current)) return current.find((entry) => entry?.id === key || entry === key)
    return current[key]
  }, value)

const validateManifest = (manifest) => {
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
    if (workflowBudgets.feedbackMs > budgets.instantFeedbackMs) {
      failures.push(`${workflow.id}: feedback budget exceeds ${budgets.instantFeedbackMs}ms`)
    }
    if (workflowBudgets.cachedRequestMs > budgets.cachedRequestMs) {
      failures.push(`${workflow.id}: cached request budget exceeds ${budgets.cachedRequestMs}ms`)
    }
    if (workflowBudgets.fullLoadMs > budgets.fullWorkflowMs) {
      failures.push(`${workflow.id}: full-load budget exceeds ${budgets.fullWorkflowMs}ms`)
    }
  }

  for (let rank = 1; rank <= 10; rank += 1) {
    if (!ranks.has(rank)) failures.push(`missing workflow rank ${rank}`)
  }

  for (const key of ['instantFeedbackMs', 'cachedRequestMs', 'fullWorkflowMs', 'maxHeartbeatLagMs', 'maxMutationLoopMs']) {
    if (!Number.isFinite(budgets[key]) || budgets[key] <= 0) {
      failures.push(`globalBudgets.${key} must be a positive number`)
    }
  }

  return failures
}

const validateBrowserPerfReport = (manifest, report) => {
  const failures = []
  const budgets = manifest.globalBudgets

  if (report.status !== 'PASS') failures.push(`browser perf report status is ${report.status ?? 'missing'}`)

  if (report.draftPerf?.maxLagMs > budgets.maxHeartbeatLagMs) {
    failures.push(`draft heartbeat lag ${report.draftPerf.maxLagMs}ms exceeds ${budgets.maxHeartbeatLagMs}ms`)
  }
  if (report.homePerf?.maxLagMs > budgets.maxHeartbeatLagMs) {
    failures.push(`home heartbeat lag ${report.homePerf.maxLagMs}ms exceeds ${budgets.maxHeartbeatLagMs}ms`)
  }
  if (report.load?.durationMs > budgets.maxMutationLoopMs) {
    failures.push(`mutation loop ${report.load.durationMs}ms exceeds ${budgets.maxMutationLoopMs}ms`)
  }

  failures.push(...validateWorkflowReportKeys(manifest, report, 'tests/e2e-browser-perf-report.md'))

  return failures
}

const validateWorkflowReportKeys = (manifest, report, reportPath) => {
  const failures = []
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
  for (const workflow of manifest.workflows.filter((item) => item.measurement?.report === reportPath)) {
    const measurement = byWorkflow.get(workflow.id)
    if (!measurement) continue

    if (measurement.feedbackMs != null && measurement.feedbackMs > workflow.budgets.feedbackMs) {
      failures.push(`${workflow.id}: ${reportPath} feedback ${measurement.feedbackMs}ms exceeds ${workflow.budgets.feedbackMs}ms`)
    }
    if (measurement.cachedRequestMs != null && measurement.cachedRequestMs > workflow.budgets.cachedRequestMs) {
      failures.push(`${workflow.id}: ${reportPath} cached request ${measurement.cachedRequestMs}ms exceeds ${workflow.budgets.cachedRequestMs}ms`)
    }
    if (measurement.fullLoadMs != null && measurement.fullLoadMs > workflow.budgets.fullLoadMs) {
      failures.push(`${workflow.id}: ${reportPath} full load ${measurement.fullLoadMs}ms exceeds ${workflow.budgets.fullLoadMs}ms`)
    }
  }

  return failures
}

const validateDataLatencyReport = (manifest, report, requireComplete) => {
  const failures = []
  const byWorkflow = new Map((report.workflows ?? []).map((workflow) => [workflow.id, workflow]))
  const workflows = manifest.workflows ?? []
  const requestBudget = report.budgets?.dataRequestMs ?? manifest.globalBudgets.cachedRequestMs
  const workflowBudget = report.budgets?.workflowTotalMs ?? manifest.globalBudgets.fullWorkflowMs

  if (report.status !== 'PASS') failures.push(`data latency report status is ${report.status ?? 'missing'}`)

  for (const workflow of workflows) {
    const measured = byWorkflow.get(workflow.id)
    if (!measured) {
      failures.push(`${workflow.id}: data latency report is missing workflow`)
      continue
    }
    if (measured.totalMedianMs > workflowBudget) {
      failures.push(`${workflow.id}: data latency total ${measured.totalMedianMs}ms exceeds ${workflowBudget}ms`)
    }
    for (const step of measured.steps ?? []) {
      if (step.status === 'SKIP') {
        if (requireComplete) failures.push(`${workflow.id}: data step ${step.label} was skipped`)
        continue
      }
      if (step.status !== 'PASS') {
        failures.push(`${workflow.id}: data step ${step.label} status ${step.status}${step.error ? ` (${step.error})` : ''}`)
      } else if (step.medianMs > requestBudget) {
        failures.push(`${workflow.id}: data step ${step.label} ${step.medianMs}ms exceeds ${requestBudget}ms`)
      }
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

  if (!reportPresent && requireReport) {
    reportFailures.push(`required browser perf report is missing: ${path.relative(ROOT, PERF_REPORT_PATH)}`)
  }
  if (!dataReportPresent && requireDataReport) {
    reportFailures.push(`required data latency report is missing: ${path.relative(ROOT, DATA_LATENCY_REPORT_PATH)}`)
  }
  if (reportPresent) {
    reportFailures.push(...validateBrowserPerfReport(manifest, readJsonFile(PERF_REPORT_PATH)))
  }
  if (dataReportPresent) {
    reportFailures.push(...validateDataLatencyReport(manifest, readJsonFile(DATA_LATENCY_REPORT_PATH), requireDataReport))
  }
  const optionalReports = Array.from(new Set(
    manifest.workflows
      .map((workflow) => workflow.measurement?.report)
      .filter((reportPath) => reportPath && reportPath !== 'tests/e2e-browser-perf-report.md'),
  ))
  for (const reportPath of optionalReports) {
    const absoluteReportPath = path.join(ROOT, reportPath)
    if (!existsSync(absoluteReportPath)) {
      if (requireWorkflowReports) reportFailures.push(`required workflow report is missing: ${reportPath}`)
      continue
    }
    reportFailures.push(...validateWorkflowReportKeys(manifest, readJsonFile(absoluteReportPath), reportPath))
  }

  await writeReport({ manifest, manifestFailures, reportFailures, reportPresent, dataReportPresent })
  const failures = [...manifestFailures, ...reportFailures]
  console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'} ${path.relative(ROOT, REPORT_PATH)}`)
  if (failures.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
