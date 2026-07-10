export const decodeStaticRequestPath = (urlPath) => {
  try {
    return { ok: true, path: decodeURIComponent(urlPath) }
  } catch {
    return { ok: false, status: 400, message: 'Malformed URL encoding' }
  }
}
