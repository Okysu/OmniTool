import { describe, expect, it } from 'vitest'
import { sanitizeName } from '@/core/vfs'

describe('workspace file names', () => {
  it('keeps relative folders', () => {
    expect(sanitizeName('docs/guide/a.txt')).toBe('docs/guide/a.txt')
    expect(sanitizeName('docs\\win\\b.txt')).toBe('docs/win/b.txt')
  })

  it('cannot climb out of an archive or become absolute', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('etc/passwd')
    expect(sanitizeName('/abs/./x/../y.txt')).toBe('abs/x/y.txt')
    expect(sanitizeName('..')).toBe('output.bin')
  })

  it('removes control characters and empty names', () => {
    expect(sanitizeName(`a${String.fromCharCode(0)}b${String.fromCharCode(31)}.txt`)).toBe('ab.txt')
    expect(sanitizeName('   ')).toBe('output.bin')
  })

  it('shortens long paths but keeps the file name and extension', () => {
    const name = sanitizeName(`${'deep/'.repeat(80)}photo.jpeg`)
    expect(name.length).toBeLessThanOrEqual(240)
    expect(name.endsWith('/photo.jpeg')).toBe(true)
  })
})
