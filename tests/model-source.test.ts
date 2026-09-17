/** Model download source: mirror rewriting and endpoint validation. */
import { describe, expect, it } from 'vitest'
import { endpointProblem, modelEndpoint, resolveModelUrl } from '@/core/capabilities/model-source'

const MODEL = 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx'

describe('model source', () => {
  it('leaves URLs alone on the official source', () => {
    expect(resolveModelUrl(MODEL, 'official', '')).toBe(MODEL)
  })

  it('rewrites huggingface.co onto a mirror, keeping the path', () => {
    expect(resolveModelUrl(MODEL, 'hf-mirror', '')).toBe('https://hf-mirror.com/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx')
    expect(resolveModelUrl(MODEL, 'custom', 'https://cache.example.com/hf/')).toBe('https://cache.example.com/hf/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx')
  })

  it('never rewrites other hosts or look-alikes', () => {
    for (const url of ['https://example.com/model.onnx', 'https://huggingface.co.evil.com/x/resolve/main/a.onnx', 'http://huggingface.co/x/resolve/main/a.onnx']) {
      expect(resolveModelUrl(url, 'hf-mirror', '')).toBe(url)
    }
  })

  it('falls back to official for an unusable custom endpoint', () => {
    expect(modelEndpoint('custom', 'ftp://mirror')).toBe('https://huggingface.co')
    expect(resolveModelUrl(MODEL, 'custom', 'not a url')).toBe(MODEL)
  })

  it('validates custom endpoints', () => {
    expect(endpointProblem('https://mirror.example.com')).toBe('')
    expect(endpointProblem('http://localhost:8080')).toBe('')
    expect(endpointProblem('http://mirror.example.com')).toContain('https')
    expect(endpointProblem('https://mirror.example.com/?token=1')).toContain('查询参数')
    expect(endpointProblem('mirror.example.com')).toContain('完整地址')
  })
})
