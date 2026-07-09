import path from 'node:path'
import process from 'node:process'
import { createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'
import { installRuntimeOverrides } from './browser-runtime-overrides.mjs'

export const ROOT = process.cwd()
export const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
export const MULTI_TEAM_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-multi-team-report.md')
export const browser = createBrowser({ cwd: ROOT })
export const listSessions = () => listBrowserSessions({ cwd: ROOT })
export const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()
export const tradeSessionName = (code, runId) =>
  `pc-${code}-${runId}-${process.pid}`.replace(/[^a-zA-Z0-9._-]/g, '-')

const parseEvalJson = (output) => {
  const value = JSON.parse(output.split('\n').filter(Boolean).at(-1))
  return typeof value === 'string' ? JSON.parse(value) : value
}

export const installBrowserHooks = async (session, env, options = {}) => {
  await installRuntimeOverrides(browser, session, env, {
    alerts: true,
    confirm: true,
    openBeforeSet: options.openBeforeSet ?? false,
    reloadAfterSet: options.reloadAfterSet ?? false,
  })
}

const authState = async (session) => parseEvalJson(await browser(session, ['eval', `(() => {
  const text = document.body?.innerText || '';
  return JSON.stringify({
    url: location.href,
    isSignIn: text.includes('Sign In') && text.includes("Don't have an account?"),
    sample: text.slice(0, 400)
  });
})()`]))

const submitSignIn = async (session) => {
  const result = parseEvalJson(await browser(session, ['eval', `(() => {
    const candidates = [...document.querySelectorAll('[aria-label], [role="button"], button')];
    const named = candidates.find((element) => element.getAttribute('aria-label') === 'Sign In' || (element.textContent || '').trim() === 'Sign In');
    const textNode = named || [...document.querySelectorAll('*')].reverse().find((element) => (element.textContent || '').trim() === 'Sign In');
    const target = textNode?.closest?.('[role="button"], button, [tabindex]') || textNode;
    if (!target) return JSON.stringify({ ok: false, sample: (document.body?.innerText || '').slice(0, 400) });
    target.click();
    return JSON.stringify({ ok: true });
  })()`]))
  if (!result.ok) throw new Error(`browser trade sign-in button not found: ${result.sample}`)
}

export const signInBrowser = async (session, env, user, password) => {
  await installBrowserHooks(session, env, { openBeforeSet: true, reloadAfterSet: true })
  await browser(session, ['wait', '1500'])
  let state = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fillSignInCredentials(browser, session, user.email, password)
    await submitSignIn(session)
    await browser(session, ['wait', '4000'])
    state = await authState(session)
    if (!state.isSignIn) return
    if (attempt < 3) {
      await browser(session, ['open', env.frontendUrl])
      await installBrowserHooks(session, env)
      await browser(session, ['wait', '1500'])
    }
  }
  throw new Error(`browser trade sign-in stayed on auth screen at ${state?.url ?? '<unknown>'}: ${state?.sample ?? '<no sample>'}`)
}

export const assertPageText = async (session, required, label) => {
  const parsed = parseEvalJson(await browser(session, ['eval', `(() => {
    const text = document.body?.innerText || '';
    const required = ${JSON.stringify(required)};
    return JSON.stringify({
      ok: required.every((value) => text.includes(value)),
      missing: required.filter((value) => !text.includes(value)),
      sample: text.slice(0, 1200)
    });
  })()`]))
  if (!parsed.ok) throw new Error(`${label} missing page text: ${parsed.missing.join(', ')}. Sample: ${parsed.sample}`)
  return parsed
}

export const clickButton = async (session, name, label) => {
  const clickByDom = async () => {
    const parsed = parseEvalJson(await browser(session, ['eval', `(() => {
      const named = [...document.querySelectorAll('[aria-label], [role="button"], button')]
        .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)} || (element.textContent || '').trim() === ${JSON.stringify(name)});
      const textNode = named || [...document.querySelectorAll('*')].reverse()
        .find((element) => (element.textContent || '').trim() === ${JSON.stringify(name)});
      const target = textNode?.closest?.('[role="button"], button, [tabindex]') || textNode;
      if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400) });
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return JSON.stringify({ ok: true, ariaLabel: target.getAttribute('aria-label'), text: target.textContent });
    })()`]))
    if (!parsed.ok) throw new Error(`${label}: button not found: ${name}. Body: ${parsed.body}`)
    return parsed
  }
  try {
    return await clickByDom()
  } catch (domError) {
    try {
      await browser(session, ['find', 'role', 'button', 'click', '--name', name])
      return { ok: true, method: 'agent-browser-find-role-button' }
    } catch {
      throw domError
    }
  }
}

const clickTab = async (session, name) => {
  const parsed = parseEvalJson(await browser(session, ['eval', `(() => {
    const norm = (value) => (value || '').trim();
    const target = [...document.querySelectorAll('[role="tab"], [role="button"], button, [tabindex]')]
      .find((element) => {
        const accessibleName = norm(element.getAttribute('aria-label')) || norm(element.textContent);
        return accessibleName === ${JSON.stringify(name)} || accessibleName.startsWith(${JSON.stringify(`${name},`)}) || accessibleName.startsWith(${JSON.stringify(name)});
      });
    if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400) });
    target.click();
    return JSON.stringify({ ok: true });
  })()`]))
  if (!parsed.ok) throw new Error(`tab not found: ${name}. Body: ${parsed.body}`)
}

export const openOffersTab = async (session, env) => {
  await browser(session, ['open', joinUrl(env.frontendUrl, '/trades')])
  await installBrowserHooks(session, env)
  await browser(session, ['wait', '2500'])
  await clickTab(session, 'Offers')
  await browser(session, ['wait', '2500'])
}
