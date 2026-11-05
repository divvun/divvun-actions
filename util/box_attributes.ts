// Archive attributes for a box archive the box CLI wrote. The CLI sets only
// its own, so the ones a .pkt.box needs are added to its trailer here.
//
// A version 1 trailer begins with the attribute-key schema and the archive's
// attribute map (box spec attributes.root); records, path index and block
// index follow, and none of them refers to a position in the trailer. Only
// those first two parts are rewritten, and new keys go after the existing
// ones, so every key index the records hold stays valid.

export const BOX_HEADER_SIZE = 32

const MAGIC = [0xff, 0x42, 0x4f, 0x58]
const FLAG_EXTERNAL_LINKS = 0b01
const FLAG_ESCAPED_PATHS = 0b10
const STRING_TYPE = 1
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Where the trailer begins in the box archive whose first
 * {@link BOX_HEADER_SIZE} bytes are `header`. Refuses an archive that
 * allows external links or escaped paths, which Pahkat refuses too.
 */
export function boxTrailerOffset(header: Uint8Array): number {
  if (
    header.length < BOX_HEADER_SIZE ||
    MAGIC.some((byte, i) => header[i] !== byte)
  ) {
    throw new Error("Not a box archive")
  }
  if (header[4] === 0) {
    throw new Error("A version 0 box archive has another trailer layout")
  }
  if (header[5] & (FLAG_EXTERNAL_LINKS | FLAG_ESCAPED_PATHS)) {
    throw new Error("The box archive allows external links or escaped paths")
  }
  const view = new DataView(header.buffer, header.byteOffset, BOX_HEADER_SIZE)
  const offset = view.getBigUint64(0x10, true)
  if (offset < BigInt(BOX_HEADER_SIZE) || offset > MAX_SAFE) {
    throw new Error(`The box archive's trailer offset ${offset} is invalid`)
  }
  return Number(offset)
}

/**
 * `trailer`, a version 1 box trailer, with `attributes` added to its
 * archive attributes as strings. Refuses a name the archive already has.
 */
export function withArchiveAttributes(
  trailer: Uint8Array,
  attributes: Record<string, string>,
): Uint8Array {
  const reader = new Reader(trailer)

  const keyCount = reader.vu64()
  const keysStart = reader.pos
  const names = new Set<string>()
  for (let i = 0; i < keyCount; i++) {
    reader.take(1)
    names.add(new TextDecoder("utf-8", { fatal: true }).decode(reader.bytes()))
  }
  const keysEnd = reader.pos

  const declared = reader.u64()
  const countStart = reader.pos
  const entryCount = reader.vu64()
  const entriesStart = reader.pos
  for (let i = 0; i < entryCount; i++) {
    reader.vu64()
    reader.bytes()
  }
  const entriesEnd = reader.pos
  // Writers before box's sans-IO rewrite counted the byte-count field itself.
  const consumed = entriesEnd - countStart
  if (declared !== consumed && declared !== consumed + 8) {
    throw new Error(
      `The box archive's attribute map declares ${declared} bytes, but its ` +
        `entries take ${consumed}`,
    )
  }

  const added = Object.entries(attributes)
  const encoder = new TextEncoder()
  const newKeys: Uint8Array[] = []
  const newEntries: Uint8Array[] = []
  added.forEach(([name, value], i) => {
    if (names.has(name)) {
      throw new Error(`The box archive already has an attribute ${name}`)
    }
    newKeys.push(Uint8Array.of(STRING_TYPE), ...lengthPrefixed(encoder.encode(name)))
    newEntries.push(vu64(keyCount + i), ...lengthPrefixed(encoder.encode(value)))
  })

  const count = vu64(entryCount + added.length)
  const entries = [trailer.subarray(entriesStart, entriesEnd), ...newEntries]
  const byteCount = count.length +
    entries.reduce((sum, part) => sum + part.length, 0)

  return concat([
    vu64(keyCount + added.length),
    trailer.subarray(keysStart, keysEnd),
    ...newKeys,
    u64(byteCount),
    count,
    ...entries,
    trailer.subarray(entriesEnd),
  ])
}

// FastVint (box spec wire.root.primitives): the leading zeros of the first
// byte give the length, 1 to 9 bytes. The first byte's remaining bits are the
// high part of the value and the bytes after it the low part, least
// significant first, and each length starts where the shorter one's values
// end, at VU64_START[length].
const VU64_START = [
  0n,
  0n,
  0x80n,
  0x4080n,
  0x20_4080n,
  0x1020_4080n,
  0x8_1020_4080n,
  0x408_1020_4080n,
  0x2_0408_1020_4080n,
  0x102_0408_1020_4080n,
]

function vu64(n: number): Uint8Array {
  const value = BigInt(n)
  let length = 1
  while (length < 9 && value >= VU64_START[length + 1]) length++
  const rest = value - VU64_START[length]
  const out = new Uint8Array(length)
  for (let i = 1; i < length; i++) {
    out[i] = Number((rest >> BigInt(8 * (i - 1))) & 0xffn)
  }
  out[0] = length === 9
    ? 0
    : (0x80 >> (length - 1)) | Number(rest >> BigInt(8 * (length - 1)))
  return out
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array[] {
  return [vu64(bytes.length), bytes]
}

function u64(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

class Reader {
  pos = 0
  #data: Uint8Array

  constructor(data: Uint8Array) {
    this.#data = data
  }

  take(length: number): Uint8Array {
    if (this.pos + length > this.#data.length) {
      throw new Error(`The box archive's trailer ends at byte ${this.pos}`)
    }
    const bytes = this.#data.subarray(this.pos, this.pos + length)
    this.pos += length
    return bytes
  }

  u64(): number {
    const bytes = this.take(8)
    const value = new DataView(bytes.buffer, bytes.byteOffset, 8)
      .getBigUint64(0, true)
    return safe(value)
  }

  vu64(): number {
    const first = this.take(1)[0]
    const length = first === 0 ? 9 : Math.clz32(first) - 23
    const rest = this.take(length - 1)
    let value = length === 9 ? 0n : BigInt(first & (0xff >> length))
    for (let i = rest.length - 1; i >= 0; i--) {
      value = (value << 8n) | BigInt(rest[i])
    }
    return safe(value + VU64_START[length])
  }

  bytes(): Uint8Array {
    return this.take(this.vu64())
  }
}

function safe(value: bigint): number {
  if (value > MAX_SAFE) {
    throw new Error(`The box archive's trailer holds a value too large: ${value}`)
  }
  return Number(value)
}
