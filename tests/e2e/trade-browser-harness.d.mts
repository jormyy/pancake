import type { ResolvedE2EEnvironment } from './env.mjs'

export const ROOT: string
export const ARTIFACT_ROOT: string
export const REPORT_PATH: string
export const ACCEPT_REPORT_PATH: string
export const TERMINAL_REPORT_PATH: string
export const FUTURE_PICK_REPORT_PATH: string
export const FUTURE_PICK_ACCEPT_REPORT_PATH: string
export const OVERFLOW_ACCEPT_REPORT_PATH: string
export const POST_DEADLINE_REPORT_PATH: string
export const VETO_REPORT_PATH: string
export const MULTI_TEAM_REPORT_PATH: string
export const browser: (session: string, args: string[], options?: { timeout?: number; maxBuffer?: number }) => Promise<string>
export function listSessions(): Promise<string>
export function safeName(value: string): string
export function tradeSessionName(code: string, runId: string): string
export function joinUrl(base: string, pathname: string): string
export function clickLastButton(session: string, name: string, label: string): Promise<unknown>
export function readButtonState(session: string, name: string, label: string): Promise<unknown>
export function clickTab(session: string, namePrefix: string, label: string): Promise<unknown>
export function installBrowserHooks(session: string, env: ResolvedE2EEnvironment): Promise<void>
export function readBrowserAlerts(session: string): Promise<unknown[]>
export function assertPageText(session: string, required: string[], label: string): Promise<void>
export function clickButton(session: string, name: string, label: string): Promise<unknown>
export function signInBrowser(session: string, env: ResolvedE2EEnvironment, user: { email: string }, password: string): Promise<void>
export function openOffersTab(session: string, env: ResolvedE2EEnvironment): Promise<void>
