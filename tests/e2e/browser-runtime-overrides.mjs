export const installRuntimeOverrides = async (browser, session, env, options = {}) => {
  if (options.openBeforeSet !== false) {
    await browser(session, ['open', env.frontendUrl])
  }
  await browser(session, [
    'eval',
    `(() => {
      window.localStorage.setItem('PANCAKE_API_URL', ${JSON.stringify(env.apiBaseUrl)});
      window.localStorage.setItem('PANCAKE_SUPABASE_URL', ${JSON.stringify(env.supabaseUrl)});
      window.localStorage.setItem('PANCAKE_SUPABASE_ANON_KEY', ${JSON.stringify(env.anonKey)});
      return JSON.stringify({ ok: true });
    })()`,
  ])
  if (options.reloadAfterSet !== false) {
    await browser(session, ['open', env.frontendUrl])
  }
  if (options.alerts || options.confirm) {
    await browser(session, [
      'eval',
      `(() => {
      ${options.alerts ? `
      window.__pancakeAlerts = [];
      window.alert = (message) => window.__pancakeAlerts.push(String(message));
      ` : ''}
      ${options.confirm ? `
      window.confirm = (message) => {
        window.__pancakeAlerts = window.__pancakeAlerts || [];
        window.__pancakeAlerts.push(String(message));
        return true;
      };
      ` : ''}
      return JSON.stringify({ ok: true });
    })()`,
    ])
  }
}

export const normalizeBrowserErrors = (output) => output
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => !/^[\u2713\u2717\s]+$/.test(line))
  .join('\n')
