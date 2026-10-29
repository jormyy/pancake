import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { createGzip } from 'node:zlib'
import { project } from './common.mjs'

export function redactPostgresLine(line) {
  return line.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
    .replace(/(app\.edge_internal_token\s*=\s*)'[^']*'/g, "$1'[redacted]'")
}

export function startPostgresLog(file, since, launch = (file, args, options) => spawn(file, args, options), { maximumBytes = 64 * 1024 * 1024, onLimit = async () => {} } = {}) {
  const destination = createWriteStream(file, { mode: 0o600 })
  const output = createGzip({ level: 1 })
  output.pipe(destination)
  const child = launch('docker', ['logs', '--follow', '--since', since, `supabase_db_${project}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  let carry = '', error, capturedBytes = 0, observedBytes = 0, limited = false, cutoff
  const write = bytes => {
    observedBytes += bytes.length
    if (limited) return
    if (capturedBytes + bytes.length > maximumBytes) {
      limited = true
      cutoff = Promise.resolve().then(onLimit).catch(value => { error = value })
      child.kill('SIGTERM')
      return
    }
    capturedBytes += bytes.length
    carry += bytes.toString()
    const end = carry.lastIndexOf('\n')
    if (end < 0) return
    if (!output.write(redactPostgresLine(carry.slice(0, end + 1)))) {
      child.stdout.pause()
      child.stderr.pause()
      output.once('drain', () => { child.stdout.resume(); child.stderr.resume() })
    }
    carry = carry.slice(end + 1)
  }
  child.stdout.on('data', write)
  child.stderr.on('data', write)
  child.on('error', value => { error = value })
  output.on('error', value => { error = value })
  destination.on('error', value => { error = value })
  return {
    pid: child.pid,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const done = once(child, 'close')
        child.kill('SIGTERM')
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
        await done
        clearTimeout(timeout)
      }
      await cutoff
      output.end(redactPostgresLine(carry))
      if (!destination.closed) await once(destination, 'close')
      if (error) throw error
      return { maximumBytes, capturedBytes, observedBytes, limited }
    },
  }
}
