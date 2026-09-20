/**
 * Microphone recording helpers: the container depends on what the engine can
 * encode, and every audio tool accepts `audio/*`, so the chosen format must be
 * one of those.
 */
import { describe, expect, it } from 'vitest'
import { extensionForMime, formatDuration, microphoneError, peakLevel, pickRecorderFormat, recordingName } from '@/lib/recording'

describe('recorder format', () => {
  it('prefers Opus, falls back to what Safari can encode', () => {
    expect(pickRecorderFormat((t) => t.startsWith('audio/webm'))).toMatchObject({ mimeType: 'audio/webm;codecs=opus', extension: 'webm' })
    expect(pickRecorderFormat((t) => t.startsWith('audio/mp4'))).toMatchObject({ extension: 'm4a' })
    expect(pickRecorderFormat((t) => t === 'audio/webm')).toMatchObject({ mimeType: 'audio/webm', extension: 'webm' })
    expect(pickRecorderFormat(() => false)).toBeNull()
  })

  it('names the file by what was actually produced', () => {
    expect(extensionForMime('audio/webm;codecs=opus')).toBe('webm')
    expect(extensionForMime('audio/mp4')).toBe('m4a')
    expect(extensionForMime('audio/x-weird', 'ogg')).toBe('ogg')
    expect(recordingName('webm', new Date(2026, 8, 20, 9, 5, 3))).toBe('录音-20260920-090503.webm')
  })
})

describe('display helpers', () => {
  it('formats elapsed time', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(9_500)).toBe('0:09')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
  })

  it('reads a peak level from time-domain samples', () => {
    expect(peakLevel(new Uint8Array([128, 128, 128]))).toBe(0)
    expect(peakLevel(new Uint8Array([128, 192, 64]))).toBeCloseTo(0.5)
    expect(peakLevel(new Uint8Array([0, 255]))).toBe(1)
  })

  it('explains why the microphone is unavailable', () => {
    expect(microphoneError(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toContain('拒绝了麦克风权限')
    expect(microphoneError(Object.assign(new Error('x'), { name: 'NotFoundError' }))).toContain('没有找到可用的麦克风')
    expect(microphoneError(Object.assign(new Error('busy'), { name: 'NotReadableError' }))).toContain('被其他程序占用')
    expect(microphoneError(new Error('boom'))).toContain('boom')
  })
})
