import { hotWorkloads } from './hot.mjs'

let checksum = 0
for (const item of await hotWorkloads()) {
  for (let i = 0; i < 3000; i++) checksum += item.consume(item.run())
}
if (!Number.isFinite(checksum) || checksum <= 0) throw new Error('Profile did no work')
console.log(checksum)
