/**
 * Where model files are downloaded from.
 *
 * Plugins name models by their canonical Hugging Face URL. Users who cannot
 * reach huggingface.co (or run their own cache) can point downloads at a mirror
 * with the same path layout. Trust does not move with the URL: every file is
 * still checked against the SHA-256 the plugin pinned, so a mirror can make a
 * download fail but can never substitute a different model.
 */
export type ModelSource = 'official' | 'hf-mirror' | 'custom'

export const MODEL_SOURCES: Array<{ value: ModelSource; label: string; endpoint: string }> = [
  { value: 'official', label: 'Hugging Face 官方（huggingface.co）', endpoint: 'https://huggingface.co' },
  { value: 'hf-mirror', label: 'HF-Mirror 国内镜像（hf-mirror.com）', endpoint: 'https://hf-mirror.com' },
  { value: 'custom', label: '自定义镜像地址', endpoint: '' },
]

const HF_HOST = 'huggingface.co'

/** A problem with a custom endpoint, or '' when it is usable. */
export function endpointProblem(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return '请输入完整地址，例如 https://hf-mirror.example.com'
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '只支持 https 地址（本机 http://localhost 除外）'
  if (url.search || url.hash) return '地址不能包含查询参数或 #'
  return ''
}

/** The endpoint in effect, falling back to official for an unusable custom value. */
export function modelEndpoint(source: ModelSource, custom: string): string {
  if (source === 'custom') return endpointProblem(custom) ? MODEL_SOURCES[0].endpoint : custom.trim().replace(/\/+$/, '')
  return (MODEL_SOURCES.find((s) => s.value === source) ?? MODEL_SOURCES[0]).endpoint
}

/** Rewrites a huggingface.co URL onto the chosen endpoint; other URLs are left alone. */
export function resolveModelUrl(url: string, source: ModelSource, custom: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.hostname !== HF_HOST || parsed.protocol !== 'https:') return url
  const endpoint = modelEndpoint(source, custom)
  if (endpoint === MODEL_SOURCES[0].endpoint) return url
  return `${endpoint}${parsed.pathname}${parsed.search}`
}
