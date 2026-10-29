import assert from 'node:assert/strict'

const literal = "'(?:''|[^'])*'|\\$(?:[a-zA-Z_]\\w*)?\\$[\\s\\S]*?\\$(?:[a-zA-Z_]\\w*)?\\$"
const value = token => token.startsWith("'") ? token.slice(1, -1).replaceAll("''", "'") : token.replace(/^\$\w*\$|\$\w*\$$/g, '')

export function installedCronJobs(migrations) {
  const jobs = new Map()
  const calls = new RegExp(`cron\\.(schedule|unschedule|alter_job)\\(\\s*(${literal}|jobname|jobid)`, 'g')
  for (const { name, source } of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = source.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const normalized = sql.replace(new RegExp(`UPDATE\\s+cron\\.job\\s+SET\\s+command\\s*=\\s*(${literal})\\s+WHERE\\s+jobname\\s*=\\s*(${literal})`, 'gi'), (_, command, jobname) => `SELECT cron.alter_job(jobid,command:=${command}) FROM cron.job WHERE jobname=${jobname}`)
    for (const call of normalized.matchAll(calls)) {
      const tail = normalized.slice(call.index + call[0].length)
      if (call[1] === 'alter_job') {
        const update = new RegExp(`^\\s*,\\s*((?:(?:schedule|command)\\s*:=\\s*(?:${literal})\\s*,?\\s*)+)\\)\\s*FROM\\s+cron\\.job\\s+WHERE\\s+jobname\\s*=\\s*(${literal})`, 'i').exec(tail)
        assert.ok(update, `Unsupported cron update in ${name}`)
        const job = jobs.get(value(update[2]))
        if (job) for (const assignment of update[1].matchAll(new RegExp(`(schedule|command)\\s*:=\\s*(${literal})`, 'g'))) job[assignment[1]] = value(assignment[2])
      } else if (call[1] === 'schedule') {
        const args = new RegExp(`^\\s*,\\s*(${literal})\\s*,\\s*(${literal})\\s*\\)`).exec(tail)
        assert.ok(args, `Unsupported cron schedule in ${name}`)
        const jobname = value(call[2])
        jobs.set(jobname, { jobname, schedule: value(args[1]), command: value(args[2]) })
      } else if (!['jobname', 'jobid'].includes(call[2])) jobs.delete(value(call[2]))
      else {
        const clause = tail.slice(0, tail.indexOf(';'))
        const names = /WHERE\s+jobname\s*(?:IN\s*\(([^)]+)\)|=\s*('(?:''|[^'])*'))/i.exec(clause)
        const command = /WHERE\s+command\s*ILIKE\s*'%([^']+)%'/i.exec(clause)
        assert.ok(names || command, `Unsupported cron removal in ${name}`)
        if (names) for (const token of (names[1] ?? names[2]).matchAll(/'(?:''|[^'])*'/g)) jobs.delete(value(token[0]))
        if (command) for (const [key, job] of jobs) if (job.command.toLowerCase().includes(command[1].toLowerCase())) jobs.delete(key)
      }
    }
  }
  return [...jobs.values()].sort((a, b) => a.jobname.localeCompare(b.jobname))
}
