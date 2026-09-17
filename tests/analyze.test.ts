import { describe, expect, it } from 'vitest'
import { analyzeSource } from '@/core/plugin/analyze'

const ids = (code: string) => analyzeSource(code).signals.map((s) => s.id)

describe('analyzeSource', () => {
  it('flags bare network calls the sandbox CSP will block', () => {
    expect(ids('await fetch("https://x")')).toContain('raw-net')
    expect(ids('const ws = new WebSocket ("wss://x")')).toContain('raw-net')
  })

  it('does not mistake the host proxy for a raw call', () => {
    const signals = ids('await ctx.host.net.fetch(url, { method: "POST" }); await host.net.fetchText(url)')
    expect(signals).toContain('net')
    expect(signals).not.toContain('raw-net')
  })

  it('does not mistake a method named fetch for a call', () => {
    expect(ids('class DataFactory { async fetch({ kind }) { return load(kind) } }')).not.toContain('raw-net')
    expect(ids('function fetch(url) { return cache[url] }')).not.toContain('raw-net')
    expect(ids('const r = await fetch(url)')).toContain('raw-net')
  })

  it('recognises every capability a plugin actually uses', () => {
    const code = 'await host.secret.request("k", { origins: [o] }); await host.onnx.load(m); await host.ffmpeg.probe(id)'
    const report = analyzeSource(code, { capabilities: ['secret', 'onnx', 'ffmpeg', 'image'] } as never)
    expect(report.unused).toEqual(['image'])
  })
})
