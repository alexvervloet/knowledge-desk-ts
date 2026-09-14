/**
 * Character-window chunking with overlap. Deliberately simple: the point of
 * this project is the operational layer, not retrieval quality, so a fixed
 * window is enough and stays predictable in tests. Token-aware chunking is a
 * later swap.
 */

import { settings } from './config.ts'
import { codePoints } from './normalize.ts'

export function chunkText(text: string, size?: number, overlap?: number): string[] {
  const windowSize = size ?? settings.chunkSize
  const step0 = overlap ?? settings.chunkOverlap
  if (windowSize <= 0) throw new Error('chunk size must be positive')
  if (step0 >= windowSize) throw new Error('overlap must be smaller than size')

  // Python indexes strings by code point, not UTF-16 unit. An emoji in a
  // document would otherwise be cut in half at a window boundary here and
  // produce a different chunking than the Python side for the same input.
  const chars = codePoints(text.trim())
  if (chars.length === 0) return []

  const step = windowSize - step0
  const chunks: string[] = []
  for (let start = 0; start < chars.length; start += step) {
    const piece = chars.slice(start, start + windowSize).join('').trim()
    if (piece) chunks.push(piece)
    if (start + windowSize >= chars.length) break
  }
  return chunks
}
