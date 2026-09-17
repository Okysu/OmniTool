/**
 * Importing content that is already in the workspace must not store it again,
 * and removing one of several entries that share bytes must not break the rest.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as vfs from '@/core/vfs'

const file = (name: string, content: string | Uint8Array, type = 'text/plain') => new File([content], name, { type })
const text = async (id: string) => (await vfs.blob(id)).text()

beforeAll(async () => {
  await vfs.initVfs()
})

beforeEach(async () => {
  await vfs.clear()
})

describe('import de-duplication', () => {
  it('returns the existing entry when the same file is imported again', async () => {
    const first = await vfs.importFile(file('notes.txt', 'hello world'))
    const again = await vfs.importFile(file('notes.txt', 'hello world'))
    expect(again.id).toBe(first.id)
    expect(vfs.entries).toHaveLength(1)
  })

  it('gives identical bytes under another name their own entry sharing the stored bytes', async () => {
    const original = await vfs.importFile(file('a.txt', 'same bytes'))
    const renamed = await vfs.importFile(file('b.txt', 'same bytes'))
    expect(renamed.id).not.toBe(original.id)
    expect(renamed.name).toBe('b.txt')
    expect(renamed.storage).toBe(original.id)

    await vfs.remove(original.id)
    expect(await text(renamed.id)).toBe('same bytes')
    await vfs.remove(renamed.id)
    expect(vfs.entries).toHaveLength(0)
  })

  it('reuses a processing result with the same bytes', async () => {
    const result = await vfs.writeAll('out.txt', new TextEncoder().encode('result'), 'text/plain', 'task-1')
    const imported = await vfs.importFile(file('out.txt', 'result'))
    expect(imported.id).not.toBe(result.id)
    expect(imported.producedBy).toBeNull()
    expect(imported.storage).toBe(result.id)
  })

  it('aliases a file for a second selection without storing it again', async () => {
    const clip = await vfs.importFile(file('clip.m4a', 'audio'))
    const second = await vfs.alias(clip.id)
    expect(second.id).not.toBe(clip.id)
    expect(second.name).toBe('clip.m4a')
    expect(second.storage).toBe(clip.id)
    expect(vfs.usedBytes()).toBe(5)
    await vfs.remove(clip.id)
    expect(await text(second.id)).toBe('audio')
  })

  it('keeps files that only share a size, head and tail', async () => {
    const size = 300 * 1024
    const a = new Uint8Array(size)
    const b = new Uint8Array(size)
    b[size >> 1] = 1
    const first = await vfs.importFile(file('scan.bin', a, 'application/octet-stream'))
    const second = await vfs.importFile(file('scan.bin', b, 'application/octet-stream'))
    expect(second.id).not.toBe(first.id)
    expect(second.storage).toBeUndefined()
    expect(vfs.entries).toHaveLength(2)
  })
})
