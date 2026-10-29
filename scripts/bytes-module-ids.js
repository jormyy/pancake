const { appendFileSync } = require('node:fs')
const path = require('node:path')

exports.recordModuleIds = createFactory => () => {
  const createId = createFactory()
  const seen = new Set()
  return (file, context) => {
    const id = createId(file, context)
    const environment = context?.environment ?? 'client'
    const key = `${environment}:${id}:${file}`
    if (context?.platform === 'web' && !seen.has(key)) {
      seen.add(key)
      appendFileSync(process.env.PANCAKE_BYTES_MODULES, `${JSON.stringify({ id, environment, path: path.relative(process.cwd(), file) })}\n`)
    }
    return id
  }
}

exports.recordModules = filter => module => {
  if (filter && !filter(module)) return false
  const output = module.output.find(output => output.type.startsWith('js/'))
  if (output?.data.code) appendFileSync(`${process.env.PANCAKE_BYTES_MODULES}.code`, `${JSON.stringify({ path: path.relative(process.cwd(), module.path), code: output.data.code })}\n`)
  return true
}
