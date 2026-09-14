/**
 * Embedders. The mock is deterministic (same text always maps to the same
 * vector) so ingestion is reproducible and testable with no keys or network. The
 * Voyage embedder is used only when a Voyage key is present.
 *
 * Both produce 1024-d vectors to match the `chunks.embedding` column. The mock
 * raises on the sentinel EMBED_FAIL_MARKER, standing in for an input the embedding
 * provider rejects (a permanent per-document failure), so the queue's retry and
 * dead-letter path is exercisable in tests. Binary content is handled earlier, at
 * the connector boundary: Postgres text columns cannot even store a NUL byte.
 *
 * Voyage publishes no Node SDK, so VoyageEmbedder calls the REST endpoint with
 * fetch. That is the one place this file is not a translation of embeddings.py.
 */

import { createHash } from 'node:crypto'
import { settings } from './config.ts'

export const EMBED_DIM = 1024

// A document containing this marker fails embedding on every attempt. Test hook
// that mimics a provider rejecting a specific input.
export const EMBED_FAIL_MARKER = '[[EMBED-FAIL]]'

export interface Embedder {
  readonly name: string
  readonly dim: number
  embedDocuments(texts: string[]): Promise<number[][]>
  embedQuery(text: string): Promise<number[]>
}

function unit(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((acc, x) => acc + x * x, 0)) || 1.0
  return vec.map((x) => x / norm)
}

/**
 * Python's `random.Random(seed).uniform(-1, 1)`, reimplemented.
 *
 * The mock's contract is that the same text always yields the same vector. Node
 * has no seedable RNG, and the point of the mock is reproducibility, so the
 * generator is written out: a Mersenne Twister seeded the way CPython seeds it
 * from an integer, producing the identical float sequence. Two consequences worth
 * stating, because both were the reason for doing it this way rather than
 * reaching for any seeded-RNG package: a vector embedded by the Python app is
 * retrievable by this one against the same database, and the mock's fixtures did
 * not have to be regenerated for the port.
 */
class MersenneTwister {
  private mt = new Uint32Array(624)
  private index = 625

  /**
   * One word of state.
   *
   * Every read here is in bounds by construction, but noUncheckedIndexedAccess
   * types a typed-array read as possibly undefined and has no way to know that.
   * A fallback of 0 says the same thing an assertion would and stays checkable.
   */
  private at(i: number): number {
    return this.mt[i] ?? 0
  }

  constructor(seed: bigint) {
    // CPython's init_by_array over the seed's 32-bit little-endian words.
    this.initGenrand(19650218)
    const key: number[] = []
    let s = seed
    if (s === 0n) key.push(0)
    while (s > 0n) {
      key.push(Number(s & 0xffffffffn))
      s >>= 32n
    }
    let i = 1
    let j = 0
    let k = Math.max(624, key.length)
    for (; k > 0; k--) {
      const prev = this.at(i - 1)
      const mixed = (BigInt(this.at(i)) ^
        ((BigInt(prev) ^ (BigInt(prev) >> 30n)) * 1664525n)) & 0xffffffffn
      this.mt[i] = Number((mixed + BigInt(key[j] ?? 0) + BigInt(j)) & 0xffffffffn)
      i++
      j++
      if (i >= 624) {
        this.mt[0] = this.at(623)
        i = 1
      }
      if (j >= key.length) j = 0
    }
    for (k = 623; k > 0; k--) {
      const prev = this.at(i - 1)
      const mixed = (BigInt(this.at(i)) ^
        ((BigInt(prev) ^ (BigInt(prev) >> 30n)) * 1566083941n)) & 0xffffffffn
      this.mt[i] = Number((mixed - BigInt(i)) & 0xffffffffn)
      i++
      if (i >= 624) {
        this.mt[0] = this.at(623)
        i = 1
      }
    }
    this.mt[0] = 0x80000000
    this.index = 624
  }

  private initGenrand(seed: number): void {
    this.mt[0] = seed >>> 0
    for (let i = 1; i < 624; i++) {
      const prev = this.at(i - 1)
      const mixed = (BigInt(1812433253) * (BigInt(prev) ^ (BigInt(prev) >> 30n)) + BigInt(i)) &
        0xffffffffn
      this.mt[i] = Number(mixed)
    }
    this.index = 624
  }

  private generate(): void {
    const MATRIX_A = 0x9908b0df
    const UPPER = 0x80000000
    const LOWER = 0x7fffffff
    for (let i = 0; i < 624; i++) {
      const y = ((this.at(i) & UPPER) | (this.at((i + 1) % 624) & LOWER)) >>> 0
      let next = (this.at((i + 397) % 624) ^ (y >>> 1)) >>> 0
      if (y % 2 !== 0) next = (next ^ MATRIX_A) >>> 0
      this.mt[i] = next
    }
    this.index = 0
  }

  /** One 32-bit output, tempered. */
  private genrandUint32(): number {
    if (this.index >= 624) this.generate()
    let y = this.at(this.index++)
    y = (y ^ (y >>> 11)) >>> 0
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0
    y = (y ^ (y >>> 18)) >>> 0
    return y
  }

  /** CPython's `random.random()`: 53 bits of randomness from two draws. */
  random(): number {
    const a = this.genrandUint32() >>> 5
    const b = this.genrandUint32() >>> 6
    return (a * 67108864 + b) * (1.0 / 9007199254740992.0)
  }

  /** CPython's `random.uniform(a, b)`. */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random()
  }
}

export class MockEmbedder implements Embedder {
  readonly name = 'mock'
  readonly dim = EMBED_DIM

  private one(text: string): number[] {
    if (text.includes(EMBED_FAIL_MARKER)) {
      throw new Error('embedding provider rejected this input')
    }
    // The same text must yield the same vector, so the generator is seeded from
    // its sha256. Deterministic by design, not crypto.
    const digest = createHash('sha256').update(text, 'utf8').digest()
    const seed = digest.subarray(0, 8).reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
    const rng = new MersenneTwister(seed)
    const vec: number[] = []
    for (let i = 0; i < this.dim; i++) vec.push(rng.uniform(-1.0, 1.0))
    return unit(vec)
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.one(t)))
  }

  embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.one(text))
  }
}

interface VoyageRow {
  embedding: number[]
  index: number
}

/**
 * Check the response really is what the API documents before trusting it.
 *
 * An assertion would compile just as well and would turn a changed response, or
 * an error body served with a 200, into `undefined.map is not a function` three
 * frames away in the worker. Here it is a message naming the endpoint.
 */
function voyageRows(payload: unknown): VoyageRow[] {
  const data: unknown =
    typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'data') : undefined
  if (!Array.isArray(data)) throw new Error('voyage embeddings: response had no data array')
  return data.map((row: unknown) => {
    const embedding: unknown =
      typeof row === 'object' && row !== null ? Reflect.get(row, 'embedding') : undefined
    const index: unknown =
      typeof row === 'object' && row !== null ? Reflect.get(row, 'index') : undefined
    if (!Array.isArray(embedding) || typeof index !== 'number') {
      throw new Error('voyage embeddings: a row was not {embedding, index}')
    }
    return { embedding: embedding.map(Number), index }
  })
}

export class VoyageEmbedder implements Embedder {
  readonly name = 'voyage'
  readonly dim = EMBED_DIM
  private readonly apiKey: string
  private readonly model: string

  constructor() {
    const key = settings.voyageApiKey
    if (key === undefined) throw new Error('VoyageEmbedder needs VOYAGE_API_KEY')
    this.apiKey = key
    this.model = settings.embedModel
  }

  private async embed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: texts, model: this.model, input_type: inputType }),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`voyage embeddings failed: ${response.status} ${body.slice(0, 200)}`)
    }
    // The API does not promise the results come back in request order, and a
    // mismatch here would attach every chunk's vector to the wrong chunk: a
    // silent, total retrieval failure with nothing to see in the logs.
    const ordered = voyageRows(await response.json()).sort((a, b) => a.index - b.index)
    if (ordered.length !== texts.length) {
      throw new Error(`voyage returned ${ordered.length} embeddings for ${texts.length} inputs`)
    }
    return ordered.map((row) => row.embedding)
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts, 'document')
  }

  async embedQuery(text: string): Promise<number[]> {
    const [first] = await this.embed([text], 'query')
    if (first === undefined) throw new Error('voyage returned no embedding for the query')
    return first
  }
}

/** Voyage when a key is present, otherwise the loud deterministic mock. */
export function getEmbedder(): Embedder {
  if (settings.voyageApiKey) return new VoyageEmbedder()
  return new MockEmbedder()
}
