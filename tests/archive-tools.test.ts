import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { gzipSync, strToU8, unzipSync, zipSync } from 'fflate'
import { loadPlugin } from './harness/plugin'

let plugin: ReturnType<typeof loadPlugin>

beforeAll(() => {
  plugin = loadPlugin('src/plugins/builtin/archive-tools.js', ['fflate'])
})

const text = (value: string) => new TextEncoder().encode(value)
const files = [
  { name: 'readme.txt', content: 'hello archive' },
  { name: '说明.md', content: '# 中文内容' },
  { name: 'photo.jpg', content: new Uint8Array(2048).map((_, i) => i & 0xff) },
]

async function create(format: string, params: Record<string, unknown> = {}) {
  return plugin.run('create', files, { format, name: 'bundle', level: 6, ...params })
}

async function extract(name: string, bytes: Uint8Array, params: Record<string, unknown> = {}) {
  return plugin.run('extract', [{ name, content: bytes }], { mode: 'extract', filter: '', prefix: false, ...params })
}

const byName = (outputs: Array<{ name: string; text: string; bytes: Uint8Array }>) =>
  Object.fromEntries(outputs.map((o) => [o.name, o]))

describe('create', () => {
  it('writes a ZIP any unzip can read, with UTF-8 names', async () => {
    const result = await create('zip')
    const zip = result.outputs[0]
    expect(zip.name).toBe('bundle.zip')
    const entries = unzipSync(zip.bytes)
    expect(Object.keys(entries).sort()).toEqual(['photo.jpg', 'readme.txt', '说明.md'])
    expect(new TextDecoder().decode(entries['说明.md'])).toBe('# 中文内容')
  })

  it('writes a TAR.GZ that GNU tar extracts, including a long Unicode path', async () => {
    const long = `${'很长的目录/'.repeat(12)}文件.txt`
    const result = await plugin.run('create', [...files, { name: long, content: 'deep' }], { format: 'tar.gz', name: 'bundle', level: 6 })
    const dir = mkdtempSync(join(tmpdir(), 'omni-tar-'))
    writeFileSync(join(dir, 'bundle.tar.gz'), result.outputs[0].bytes)
    execFileSync('tar', ['-xzf', 'bundle.tar.gz'], { cwd: dir })
    expect(readFileSync(join(dir, '说明.md'), 'utf8')).toBe('# 中文内容')
    expect(readFileSync(join(dir, long), 'utf8')).toBe('deep')
    expect(readFileSync(join(dir, 'photo.jpg'))).toEqual(Buffer.from(files[2].content as Uint8Array))
  })

  it('does not overwrite inputs that share a name', async () => {
    const result = await plugin.run('create', [{ name: 'a.txt', content: '1' }, { name: 'a.txt', content: '2' }, { name: '.env', content: '3' }, { name: '.env', content: '4' }], { format: 'zip', name: 'x', level: 6 })
    expect(Object.keys(unzipSync(result.outputs[0].bytes)).sort()).toEqual(['.env', '.env (2)', 'a (2).txt', 'a.txt'])
  })

  it('gzips each file separately', async () => {
    const result = await create('gz')
    expect(result.outputs.map((o) => o.name)).toEqual(['readme.txt.gz', '说明.md.gz', 'photo.jpg.gz'])
  })
})

describe('extract', () => {
  it('round-trips every format it creates', async () => {
    for (const format of ['zip', 'tar', 'tar.gz']) {
      const archive = (await create(format)).outputs[0]
      const result = await extract(archive.name, archive.bytes)
      const out = byName(result.outputs)
      expect(Object.keys(out).sort(), format).toEqual(['photo.jpg', 'readme.txt', '说明.md'])
      expect(out['readme.txt'].text, format).toBe('hello archive')
      expect(Array.from(out['photo.jpg'].bytes), format).toEqual(Array.from(files[2].content as Uint8Array))
    }
  })

  it('reads archives made by GNU tar, keeping folders', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-src-'))
    mkdirSync(join(dir, 'docs/sub'), { recursive: true })
    writeFileSync(join(dir, 'docs/sub/a.txt'), 'A')
    writeFileSync(join(dir, 'docs/说明.txt'), '中')
    execFileSync('tar', ['-czf', 'src.tgz', 'docs'], { cwd: dir })
    const result = await extract('src.tgz', readFileSync(join(dir, 'src.tgz')), { prefix: true })
    expect(result.outputs.map((o) => o.name).sort()).toEqual(['src/docs/sub/a.txt', 'src/docs/说明.txt'])
  })

  it('decodes GBK file names from ZIPs made on Chinese Windows', async () => {
    // Build a ZIP whose name bytes are GBK with the UTF-8 flag cleared, the way
    // Windows Explorer writes it: an ASCII placeholder of equal length, patched.
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x74, 0x78, 0x74]) // 中文.txt
    const placeholder = 'XXXX.txt'
    const zip = zipSync({ [placeholder]: strToU8('gbk!') })
    for (let i = 0; i <= zip.length - placeholder.length; i++) {
      if (new TextDecoder().decode(zip.subarray(i, i + placeholder.length)) === placeholder) zip.set(gbk, i)
    }
    const result = await extract('win.zip', zip)
    expect(result.outputs[0].name).toBe('中文.txt')
    expect(result.outputs[0].text).toBe('gbk!')
  })

  it('extracts a single .gz to the name without its extension', async () => {
    const result = await extract('notes.txt.gz', gzipSync(text('plain')))
    expect(result.outputs[0].name).toBe('notes.txt')
    expect(result.outputs[0].text).toBe('plain')
  })

  it('filters by glob, by file name or by full path', async () => {
    const archive = zipSync({ 'a/one.pdf': text('1'), 'b/two.pdf': text('2'), 'b/three.txt': text('3') })
    expect((await extract('x.zip', archive, { filter: '*.pdf' })).outputs.map((o) => o.name).sort()).toEqual(['a/one.pdf', 'b/two.pdf'])
    expect((await extract('x.zip', archive, { filter: 'b/*' })).outputs.map((o) => o.name).sort()).toEqual(['b/three.txt', 'b/two.pdf'])
    await expect(extract('x.zip', archive, { filter: '*.doc' })).rejects.toThrow(/没有与/)
  })

  it('strips path traversal from entry names', async () => {
    const archive = zipSync({ '../../evil.sh': text('x'), '/abs/root.txt': text('y') })
    const names = (await extract('evil.zip', archive)).outputs.map((o) => o.name).sort()
    expect(names).toEqual(['abs/root.txt', 'evil.sh'])
  })

  it('refuses an archive that declares an enormous uncompressed size', async () => {
    const archive = zipSync({ 'bomb.bin': new Uint8Array(1024) })
    // Patch the declared uncompressed size (central directory offset +24) to 3 GB.
    const view = new DataView(archive.buffer)
    for (let i = archive.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 3 * 1024 * 1024 * 1024, true)
        break
      }
    }
    await expect(extract('bomb.zip', archive)).rejects.toThrow(/压缩炸弹/)
  })

  it('lists contents without extracting', async () => {
    const archive = (await create('zip')).outputs[0]
    const result = await plugin.run('extract', [{ name: 'bundle.zip', content: archive.bytes }], { mode: 'list' })
    const [listing] = JSON.parse(result.outputs[0].text)
    expect(listing).toMatchObject({ archive: 'bundle.zip', format: 'zip', files: 3 })
    expect(result.summary).toBe('1 个压缩包，共 3 个文件')
  })

  it('names unsupported formats instead of failing obscurely', async () => {
    await expect(extract('x.arj', new Uint8Array([0x60, 0xea, 1, 2, 3, 4, 5, 6]))).rejects.toThrow('不是可识别的压缩包')
    await expect(extract('x.7z', new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]))).rejects.toThrow('空的或已损坏')
  })
})

describe('7z, RAR and encrypted ZIP (libarchive)', () => {
  // Fixtures from libarchive-wasm's test suite (MIT): an `example/` tree with
  // README.md (144 B), dir/image.png (1559 B) and a symlink.
  const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/archives/${name}`))
  const readme = '# example\n\n```\narchives/example'

  for (const name of ['lzma2.7z', 'bzip2.7z', 'v4.rar', 'v5.rar']) {
    it(`extracts ${name}`, async () => {
      const result = await extract(name, fixture(name))
      const out = byName(result.outputs)
      expect(out['example/README.md'].text.startsWith(readme)).toBe(true)
      expect(out['example/dir/image.png'].bytes.length).toBe(1559)
      expect([...out['example/dir/image.png'].bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47])
      // 7z stores the symlink as a link, which is not materialised.
      if (name.endsWith('.7z')) expect(out['example/dir/symlink']).toBeUndefined()
    })
  }

  it('lists a 7z without extracting', async () => {
    const result = await plugin.run('extract', [{ name: 'a.7z', content: fixture('lzma2.7z') }], { mode: 'list' })
    const [listing] = JSON.parse(result.outputs[0].text)
    expect(listing.format).toBe('7z')
    expect(listing.files).toBe(2)
  })

  it('applies the filter to RAR entries', async () => {
    const result = await extract('v5.rar', fixture('v5.rar'), { filter: '*.png', prefix: true })
    expect(result.outputs.map((o) => o.name)).toEqual(['v5/example/dir/image.png'])
  })

  it('decrypts a password-protected ZIP and explains a missing or wrong password', async () => {
    const zip = fixture('deflate-encrypted.zip')
    await expect(extract('secret.zip', zip)).rejects.toThrow('请填写解压密码')
    await expect(extract('secret.zip', zip, { password: 'nope' })).rejects.toThrow('解压密码不正确')
    const result = await extract('secret.zip', zip, { password: 'Passw0rd!' })
    expect(byName(result.outputs)['example/README.md'].text.startsWith(readme)).toBe(true)
  })

  it('says plainly when RAR file names are encrypted', async () => {
    await expect(extract('locked.rar', fixture('v4-encrypted.rar'), { password: 'Passw0rd!' })).rejects.toThrow('连文件名也加密了')
  })
})
