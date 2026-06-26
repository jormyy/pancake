// CORS origin policy. The API is bearer-token only (no cookies), so cross-origin
// JS cannot read a victim's token; CORS is defense-in-depth. Set
// CORS_ALLOWED_ORIGINS (comma-separated) in production to restrict the browser
// surface to the web app's own origin(s); unset/dev (or "*") reflects any origin.
export function resolveCorsOrigin(): true | string[] {
    const raw = process.env.CORS_ALLOWED_ORIGINS?.trim()
    if (!raw || raw === '*') return true
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
}
