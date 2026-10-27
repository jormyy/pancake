export function navigationEvidenceFailures(report, routeLabels, requiredRoles) {
  const failures = []
  for (const role of requiredRoles) {
    const accounts = report.accounts.filter(account => account.role === role)
    if (accounts.length !== 1) { failures.push(`${role}: expected one account walkthrough`); continue }
    const account = accounts[0]
    if (account.error) failures.push(`${role}: ${account.error}`)
    if (account.errors.length) failures.push(`${role}: browser page errors`)
    if (account.blockedRemoteRequests.length) failures.push(`${role}: requests outside the isolated services`)
    const passed = new Set(account.routes.filter(route => route.status === 'PASS').map(route => route.name))
    for (const label of routeLabels) if (!passed.has(label)) failures.push(`${role}: missing ${label}`)
    if (!account.journeys.length) failures.push(`${role}: no entry points exercised`)
    for (const journey of account.journeys) {
      if (journey.status !== 'PASS') failures.push(`${role}: failed ${journey.name}`)
      if (journey.taps > (journey.daily ? 3 : 4)) failures.push(`${role}: too many taps for ${journey.name}`)
    }
  }
  return failures
}
