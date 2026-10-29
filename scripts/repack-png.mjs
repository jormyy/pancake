import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

export function repackPng(input) {
  assert.equal(input.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  const chunks = []
  let offset = 8
  while (offset < input.length) {
    const length = input.readUInt32BE(offset)
    const bytes = input.subarray(offset, offset + length + 12)
    assert.equal(bytes.length, length + 12)
    assert.equal(crc32(bytes.subarray(4, -4)), bytes.readUInt32BE(bytes.length - 4))
    chunks.push({ type: bytes.toString('ascii', 4, 8), bytes })
    offset += bytes.length
  }
  assert.equal(chunks.at(-1).type, 'IEND')
  const pixels = inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.bytes.subarray(8, -4))))
  const packed = deflateSync(pixels, { level: 9 })
  assert.deepEqual(inflateSync(packed), pixels)
  const idat = Buffer.alloc(packed.length + 12)
  idat.writeUInt32BE(packed.length)
  idat.write('IDAT', 4)
  packed.copy(idat, 8)
  idat.writeUInt32BE(crc32(idat.subarray(4, -4)), idat.length - 4)
  let emitted = false
  const output = Buffer.concat([input.subarray(0, 8), ...chunks.flatMap(chunk => {
    if (chunk.type !== 'IDAT') return [chunk.bytes]
    if (emitted) return []
    emitted = true
    return [idat]
  })])
  return output.length < input.length ? output : input
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of process.argv.slice(2)) {
    const before = await readFile(file)
    const after = repackPng(before)
    await writeFile(file, after)
    console.log(`${file}: ${before.length} -> ${after.length}`)
  }
}
