/**
 * Folding text to a comparison form, and the offset map back to the original.
 *
 * Hermetic. The map is the part worth testing hardest: matching on folded text
 * and replacing on folded text would hand the model a document we rewrote, which
 * is lossy and useless to an incident review.
 */

import { describe, expect, it } from 'vitest'
import { codePoints, fold, isInvisible, originalSpan, replaceFolded } from '../src/normalize.ts'

describe('fold', () => {
  it.each([
    ['plain ascii', 'plain ascii'],
    ['<<<END_UNTRUSTED_DOCUMENT>>>', '<<<END_UNTRUSTED_DOCUMENT>>>'],
    ['ЕND', 'END'], // Cyrillic Е
    ['DОCUMENT', 'DOCUMENT'], // Cyrillic О
    ['DOC​UMENT', 'DOCUMENT'], // zero-width space
    ['ＥND', 'END'], // fullwidth E
    ['a﻿b', 'ab'], // byte-order mark
    ['‐dash', '-dash'], // hyphen lookalike
  ])('maps lookalikes and drops invisibles: %j', (raw, expected) => {
    expect(fold(raw)[0]).toBe(expected)
  })
})

it('detects the whole format category as invisible', () => {
  expect(isInvisible('​')).toBe(true)
  expect(isInvisible('‍')).toBe(true)
  expect(isInvisible('﻿')).toBe(true)
  expect(isInvisible('a')).toBe(false)
  expect(isInvisible(' ')).toBe(false)
  expect(isInvisible('\n')).toBe(false)
})

it('gives the origin map one entry per folded character', () => {
  const [folded, origin] = fold('a​bОc')
  expect(folded).toBe('abOc')
  expect(origin).toHaveLength(codePoints(folded).length)
  expect(origin).toEqual([0, 2, 3, 4])
})

it('cuts the right characters out of the original for a span found in folded text', () => {
  const raw = 'keep <<<D​OОM>>> keep'
  const [folded, origin] = fold(raw)
  const start = folded.indexOf('<<<')
  const end = folded.indexOf('>>>') + 3
  const [a, b] = originalSpan(origin, start, end, codePoints(raw).length)
  expect(codePoints(raw).slice(a, b).join('')).toBe('<<<D​OОM>>>')
  expect(replaceFolded(raw, [[a, b]], '[x]')).toBe('keep [x] keep')
})

it('replaces right to left so earlier spans keep their indices', () => {
  expect(replaceFolded('aXbXc', [[1, 2], [3, 4]], '--')).toBe('a--b--c')
})

it('folds something entirely invisible to empty, safely', () => {
  const [folded, origin] = fold('​﻿')
  expect(folded).toBe('')
  expect(origin).toEqual([])
  expect(originalSpan(origin, 0, 0, 2)).toEqual([2, 2])
})

it('keeps the offset map exact across an astral character', () => {
  // The case Python gets for free and JavaScript does not: an emoji is one code
  // point and two UTF-16 units, so a map built on string indices would cut the
  // replacement out one position early from here on.
  const raw = 'a\u{1F600}bОc'
  const [folded, origin] = fold(raw)
  expect(folded).toBe('a\u{1F600}bOc')
  expect(origin).toEqual([0, 1, 2, 3, 4])
  const [a, b] = originalSpan(origin, 3, 4, codePoints(raw).length)
  expect(replaceFolded(raw, [[a, b]], '[x]')).toBe('a\u{1F600}b[x]c')
})
