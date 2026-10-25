import { createInterface } from 'node:readline'
{
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    if (line === 'FAIL') { process.stderr.write('deliberate failure\n'); process.exit(3) }
    if (line === '\\quit') process.exit(0)
    if (line.startsWith('\\echo ')) process.stdout.write(`${line.slice(6)}\n`)
    else if (line !== ';') process.stdout.write(`${line}\n`)
  }
  process.exit(0)
}
