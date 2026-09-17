import { get as idbGet } from 'idb-keyval'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  dropPluginSecrets,
  hasSecret,
  kvRead,
  kvWrite,
  listSecrets,
  referencedSecrets,
  storeSecret,
  substituteSecrets,
} from '@/core/capabilities/vault'

const PLUGIN = 'test.translator'
const SECRET_VALUE = 'sk-live-THIS-MUST-NEVER-LEAK'

beforeEach(async () => {
  await dropPluginSecrets(PLUGIN)
  await dropPluginSecrets('test.other')
  await storeSecret(
    { pluginId: PLUGIN, name: 'apiKey', label: 'API Key', allowOrigins: ['https://api.example.com'] },
    SECRET_VALUE,
  )
})

describe('secret substitution', () => {
  it('substitutes for an approved origin', async () => {
    const result = await substituteSecrets('Bearer {{secret:apiKey}}', PLUGIN, 'Translator', 'https://api.example.com')
    expect(result.text).toBe(`Bearer ${SECRET_VALUE}`)
    expect(result.used).toEqual(['apiKey'])
  })

  it('refuses to send a secret to an origin the user did not approve', async () => {
    await expect(
      substituteSecrets('Bearer {{secret:apiKey}}', PLUGIN, 'Translator', 'https://evil.example'),
    ).rejects.toThrow(/只允许发往/)
  })

  it('treats a lookalike origin as a different origin', async () => {
    for (const origin of [
      'http://api.example.com', // downgraded scheme
      'https://api.example.com:8443', // different port
      'https://api.example.com.evil.example', // suffix trick
    ]) {
      await expect(substituteSecrets('{{secret:apiKey}}', PLUGIN, 'Translator', origin)).rejects.toThrow()
    }
  })

  it('fails closed for an unknown secret instead of sending the placeholder', async () => {
    await expect(
      substituteSecrets('{{secret:doesNotExist}}', PLUGIN, 'Translator', 'https://api.example.com'),
    ).rejects.toThrow(/不存在的凭据/)
  })

  it('does not let one plugin use another plugin\'s secret', async () => {
    await expect(
      substituteSecrets('{{secret:apiKey}}', 'test.other', 'Other', 'https://api.example.com'),
    ).rejects.toThrow(/不存在的凭据/)
  })

  it('passes text without placeholders through untouched', async () => {
    const result = await substituteSecrets('no secrets here', PLUGIN, 'Translator', 'https://evil.example')
    expect(result).toEqual({ text: 'no secrets here', used: [] })
  })

  it('normalises a bare host into an https origin when storing', async () => {
    await storeSecret({ pluginId: PLUGIN, name: 'bare', label: 'x', allowOrigins: ['api.bare.example'] }, 'v')
    const meta = (await listSecrets()).find((m) => m.name === 'bare')
    expect(meta?.allowOrigins).toEqual(['https://api.bare.example'])
  })

  it('refuses to store a secret with no usable origin', async () => {
    await expect(
      storeSecret({ pluginId: PLUGIN, name: 'nowhere', label: 'x', allowOrigins: ['javascript:alert(1)', ''] }, 'v'),
    ).rejects.toThrow(/至少绑定一个目标域名/)
  })

  it('records usage', async () => {
    await substituteSecrets('{{secret:apiKey}}', PLUGIN, 'Translator', 'https://api.example.com')
    const meta = (await listSecrets()).find((m) => m.name === 'apiKey')
    expect(meta?.useCount).toBe(1)
    expect(meta?.lastUsedAt).toBeTypeOf('number')
  })
})

describe('secret confidentiality', () => {
  it('never exposes the value through metadata', async () => {
    const serialised = JSON.stringify(await listSecrets())
    expect(serialised).not.toContain(SECRET_VALUE)
    expect(await hasSecret(PLUGIN, 'apiKey')).toBe(true)
  })

  it('stores the value encrypted, not as plaintext', async () => {
    const raw = await idbGet(`omnitool.vault.secret.${PLUGIN}/apiKey`)
    const bytes = JSON.stringify(raw, (_, v) => (v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v))
    expect(bytes).not.toContain(SECRET_VALUE)
    expect(new TextDecoder().decode(new Uint8Array((raw as { data: ArrayBuffer }).data))).not.toContain('sk-live')
  })

  it('removes every secret of a plugin on uninstall', async () => {
    expect(await dropPluginSecrets(PLUGIN)).toBe(1)
    expect(await hasSecret(PLUGIN, 'apiKey')).toBe(false)
  })
})

describe('placeholder parsing', () => {
  it('finds each distinct reference once', () => {
    expect(referencedSecrets('{{secret:a}} x {{ secret:b }} {{secret:a}}')).toEqual(['a', 'b'])
  })

  it('ignores malformed references', () => {
    expect(referencedSecrets('{{secret:}} {{secret:has space}} {secret:x}')).toEqual([])
  })
})

describe('kv store', () => {
  it('round-trips values and keeps them encrypted at rest', async () => {
    await kvWrite('test.kv', { token: 'plain-kv-marker', n: 42 })
    expect(await kvRead('test.kv')).toEqual({ token: 'plain-kv-marker', n: 42 })
    const raw = (await idbGet('omnitool.vault.kv.test.kv')) as { data: ArrayBuffer }
    expect(new TextDecoder().decode(new Uint8Array(raw.data))).not.toContain('plain-kv-marker')
  })

  it('isolates plugins from each other', async () => {
    await kvWrite('test.kv-a', { secret: 1 })
    expect(await kvRead('test.kv-b')).toEqual({})
  })
})
