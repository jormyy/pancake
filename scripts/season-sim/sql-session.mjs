import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export function createSqlSession(executable, env, args = ['-XqAt', '--set', 'ON_ERROR_STOP=1']) {
  let child, output = '', errors = '', pending, queue = Promise.resolve()
  const references = enabled => {
    for (const handle of [child, child?.stdin, child?.stdout, child?.stderr]) handle?.[enabled ? 'ref' : 'unref']?.()
  }
  const start = () => {
    child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      output += chunk
      if (!pending) return
      const end = output.indexOf(`${pending.marker}\n`)
      if (end < 0) return
      const result = output.slice(0, end).trim()
      output = output.slice(end + pending.marker.length + 1)
      const completed = pending
      pending = null
      references(false)
      completed.resolve(result)
    })
    child.stderr.on('data', chunk => { errors += chunk })
    const fail = error => {
      pending?.reject(error)
      pending = null
      child = null
    }
    child.on('error', fail)
    child.on('exit', code => fail(new Error(`Local SQL client exits ${code}: ${errors.trim()}`)))
  }
  const query = statement => {
    const operation = queue.then(() => new Promise((resolve, reject) => {
      if (!child) start()
      references(true)
      errors = ''
      const marker = `season_sim_${randomUUID().replaceAll('-', '')}`
      pending = { marker, resolve, reject }
      child.stdin.write(`${statement}\n;\n\\echo ${marker}\n`)
    }))
    queue = operation.catch(() => {})
    return operation
  }
  const close = async () => {
    await queue
    child?.stdin.end('\\quit\n')
  }
  return { query, close }
}
