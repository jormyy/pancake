import { spawn } from 'node:child_process'

export function command(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    let inputError
    child.stdin.on('error', error => { inputError = error })
    let timedOut = false, killTimer
    const timer = options.timeout === 0 ? null : setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    }, options.timeout ?? 120000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', bytes => stdout.push(bytes))
    child.stderr.on('data', bytes => stderr.push(bytes))
    child.on('close', code => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      const result = { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }
      if (timedOut) reject(new Error(`${file} timed out`))
      else if (code !== 0 && !options.allowFailure) {
        const detail = result.stderr.split('\n').filter(line => /error|fatal|failed|unhealthy|timeout|server closed|connection.*lost|psql:/i.test(line) && !/detail:|statement:|context:/i.test(line))
          .join('\n').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]').replace(/sb_secret_[\w-]+/g, '[redacted]').slice(-1200)
        reject(new Error(`${file} failed (${code}); ${options.label ?? 'command failed'}${detail ? `: ${detail}` : ''}`))
      }
      else if (inputError) reject(inputError)
      else resolve(result)
    })
    child.stdin.end(options.input)
  })
}
