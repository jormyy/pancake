import assert from 'node:assert/strict'

const literal = "'(?:''|[^'])*'|\\$(?:[a-zA-Z_]\\w*)?\\$[\\s\\S]*?\\$(?:[a-zA-Z_]\\w*)?\\$"
const value = token => token.startsWith("'") ? token.slice(1, -1).replaceAll("''", "'") : token.replace(/^\$\w*\$|\$\w*\$$/g, '')

export function installedCronJobs(migrations) {
  const jobs = new Map()
  const calls = new RegExp(`cron\\.(schedule|unschedule)\\(\\s*(${literal}|jobname|jobid)`, 'g')
  for (const { name, source } of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = source.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const call of sql.matchAll(calls)) {
      const tail = sql.slice(call.index + call[0].length)
      if (call[1] === 'schedule') {
        const args = new RegExp(`^\\s*,\\s*(${literal})\\s*,\\s*(${literal})\\s*\\)`).exec(tail)
        assert.ok(args, `Unsupported cron schedule in ${name}`)
        const jobname = value(call[2])
        jobs.set(jobname, { jobname, schedule: value(args[1]), command: value(args[2]) })
      } else if (!['jobname', 'jobid'].includes(call[2])) jobs.delete(value(call[2]))
      else {
        const clause = tail.slice(0, tail.indexOf(';'))
        const names = /WHERE\s+jobname\s+(?:IN\s*\(([^)]+)\)|=\s*('(?:''|[^'])*'))/i.exec(clause)
        const command = /WHERE\s+command\s+ILIKE\s+'%([^']+)%'/i.exec(clause)
        assert.ok(names || command, `Unsupported cron removal in ${name}`)
        if (names) for (const token of (names[1] ?? names[2]).matchAll(/'(?:''|[^'])*'/g)) jobs.delete(value(token[0]))
        if (command) for (const [key, job] of jobs) if (job.command.toLowerCase().includes(command[1].toLowerCase())) jobs.delete(key)
      }
    }
  }
  return [...jobs.values()].sort((a, b) => a.jobname.localeCompare(b.jobname))
}
