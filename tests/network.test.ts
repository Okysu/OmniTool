import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authorizeNetwork, isPrivateHost } from '@/core/capabilities/network'
import { promptForConfirmation } from '@/core/ui/prompt'
import { settings } from '@/core/settings'
import { dispatch, type CapabilityContext } from '@/core/capabilities'

vi.mock('@/core/ui/prompt', () => ({ promptForConfirmation: vi.fn(), promptForSecret: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('location', new URL('https://omnitool.example'))
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('ok')))
  vi.mocked(promptForConfirmation).mockResolvedValue(true)
  settings.allowLocalNetwork = false
})

function context(): CapabilityContext {
  return { pluginId: 'test.net', pluginName: 'Test', grants: new Set(['net']),
    trusted: false, allowedInputs: new Set(), ownedOutputs: new Set(), networkScope: {} }
}

describe('plugin network boundary', () => {
  it.each([
    'http://2130706433', 'http://0177.0.0.1', 'http://127.1', 'http://0x7f000001',
    'http://[::ffff:7f00:1]', 'http://[::ffff:192.168.1.1]', 'http://[::]', 'http://[::1]',
    'http://[fe80::1]', 'http://[fc00::1]', 'http://[fd00::1]', 'http://[ff02::1]',
    'http://0.1.2.3', 'http://10.1.2.3', 'http://172.16.1.1', 'http://192.168.1.1',
    'http://169.254.169.254', 'http://100.64.1.1', 'http://localhost.', 'http://a.localhost',
    'http://printer.local', 'http://intranet', 'http://[2002:7f00:1::]',
  ])('rejects local destination %s before any request or prompt', async (address) => {
    expect(isPrivateHost(new URL(address).hostname)).toBe(true)
    await expect(dispatch(context(), 'net.fetch', [address])).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(promptForConfirmation).not.toHaveBeenCalled()
  })

  it('requires explicit origin approval before a simple POST, regardless of DNS', async () => {
    vi.mocked(promptForConfirmation).mockResolvedValue(false)
    await expect(dispatch(context(), 'net.fetch', ['https://rebind.example', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'private data',
    }])).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(promptForConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('https://rebind.example'),
    }))
  })

  it('scopes approval to the sandbox and exact origin, and never follows redirects', async () => {
    const ctx = context()
    await dispatch(ctx, 'net.fetch', ['https://api.example/a'])
    await dispatch(ctx, 'net.fetch', ['https://api.example/b'])
    expect(promptForConfirmation).toHaveBeenCalledTimes(1)
    await dispatch(ctx, 'net.fetch', ['https://api.example:8443'])
    await dispatch(context(), 'net.fetch', ['https://api.example'])
    expect(promptForConfirmation).toHaveBeenCalledTimes(3)
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      redirect: 'error', credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer',
    }))
  })

  it('rejects same-origin requests and URL credentials', async () => {
    for (const url of ['https://omnitool.example/api', 'https://user:password@api.example']) {
      await expect(dispatch(context(), 'net.fetch', [url])).rejects.toThrow()
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('still asks for origin approval when local networking is enabled', async () => {
    settings.allowLocalNetwork = true
    await dispatch(context(), 'net.fetch', ['http://127.0.0.1:11434'])
    expect(promptForConfirmation).toHaveBeenCalledOnce()
  })

  it('deduplicates simultaneous prompts and checks cancellation before fetching', async () => {
    let approve!: (value: boolean) => void
    vi.mocked(promptForConfirmation).mockImplementation(() => new Promise((resolve) => { approve = resolve }))
    const scope = {}, url = new URL('https://api.example'), controller = new AbortController()
    const a = authorizeNetwork(scope, 'Test', url, false, controller.signal)
    const b = authorizeNetwork(scope, 'Test', url, false)
    controller.abort()
    approve(true)
    await expect(a).rejects.toThrow()
    await expect(b).resolves.toBeUndefined()
    expect(promptForConfirmation).toHaveBeenCalledOnce()
  })

  it.each(['8.8.8.8', '[2606:4700:4700::1111]', 'api.example'])('allows eligible public host %s to reach approval', (host) => {
    expect(isPrivateHost(new URL('https://' + host).hostname)).toBe(false)
  })
})
