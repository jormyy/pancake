export async function settleControl(page, control) {
  if (control.kind === 'fill' && control.label === 'Search players') {
    const last = control.keystrokes.at(-1)
    await page.waitForFunction(({ value, at }) => Date.now() - at >= 300
      && window.__perfLabSearch.some(result => result.query === value && result.at >= at && result.ready), last, { timeout: 15000 })
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  try {
    await page.waitForLoadState('networkidle', { timeout: 2000 })
    control.networkQuiet = true
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error
    control.networkQuiet = false
  }
}
