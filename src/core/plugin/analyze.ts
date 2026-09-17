/**
 * Static risk report shown before a plugin is installed.
 *
 * This is a *disclosure* tool, not a security control. Obfuscated code will slip
 * past every pattern here, which is exactly why the real boundaries are the
 * opaque-origin sandbox and the capability grants. What this buys the user is an
 * honest, readable summary of what the code appears to do before they say yes.
 */
import { CAPABILITY_INFO, type Capability, type PluginManifest } from '@/core/types'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface RiskSignal {
  id: string
  label: string
  detail: string
  level: RiskLevel
  /** Number of matches found in the source. */
  hits: number
}

export interface RiskReport {
  level: RiskLevel
  signals: RiskSignal[]
  /** Capabilities the manifest declares. */
  declared: Capability[]
  /** Capabilities the code appears to use but did not declare. */
  undeclared: Capability[]
  /** Capabilities declared but never referenced - candidates to decline. */
  unused: Capability[]
  sizeBytes: number
  /** Rough obfuscation tell: very long lines or a high non-ASCII escape ratio. */
  suspiciousFormatting: boolean
}

interface Pattern {
  id: string
  label: string
  detail: string
  level: RiskLevel
  regex: RegExp
}

const PATTERNS: Pattern[] = [
  {
    id: 'net',
    label: '外网请求',
    detail: '脚本会通过宿主代理向外部地址发送数据，你的文件内容可能离开本机。',
    level: 'high',
    regex: /host\s*\.\s*net\s*\.\s*fetch/g,
  },
  {
    id: 'raw-net',
    label: '直接网络调用（将被拦截）',
    detail: '脚本直接调用了 fetch/XMLHttpRequest/WebSocket。沙盒 CSP 会拦截这些调用，插件可能无法正常工作。',
    level: 'medium',
    regex: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(/g,
  },
  {
    id: 'kv',
    label: '持久化存储',
    detail: '脚本会在本地保存数据。存储区为该插件私有，无法读取其他插件的数据。',
    level: 'medium',
    regex: /host\s*\.\s*kv\s*\./g,
  },
  {
    id: 'dynamic-code',
    label: '动态代码执行',
    detail: '脚本在运行时构造并执行代码，静态审查无法覆盖其真实行为。',
    level: 'high',
    regex: /\b(?:eval|new\s+Function|Function\s*\(\s*['"])/g,
  },
  {
    id: 'fs-read',
    label: '读取文件内容',
    detail: '脚本会读取你拖入的文件。仅限本次调用的输入文件。',
    level: 'low',
    regex: /host\s*\.\s*fs\s*\.\s*read/g,
  },
  {
    id: 'fs-write',
    label: '写出文件',
    detail: '脚本会在工作区生成新文件。',
    level: 'low',
    regex: /host\s*\.\s*fs\s*\.\s*(?:create|write)/g,
  },
  {
    id: 'deps',
    label: '加载外部依赖',
    detail: '插件声明了外部脚本依赖，这些脚本会被注入沙盒并拥有与插件相同的权限。',
    level: 'high',
    regex: /\bdeps\s*:/g,
  },
]

/** Which capability each pattern implies, for the declared/used cross-check. */
const PATTERN_CAPABILITY: Record<string, Capability | undefined> = {
  net: 'net',
  kv: 'kv',
  'fs-read': 'fs',
  'fs-write': 'fs',
}

const CAPABILITY_USAGE: Array<{ capability: Capability; regex: RegExp }> = [
  { capability: 'fs', regex: /host\s*\.\s*fs\s*\./ },
  { capability: 'ui', regex: /host\s*\.\s*ui\s*\./ },
  { capability: 'net', regex: /host\s*\.\s*net\s*\./ },
  { capability: 'kv', regex: /host\s*\.\s*kv\s*\./ },
  { capability: 'image', regex: /host\s*\.\s*image\s*\./ },
  { capability: 'ffmpeg', regex: /host\s*\.\s*ffmpeg\s*\./ },
]

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }

export function analyzeSource(code: string, manifest?: PluginManifest | null): RiskReport {
  const signals: RiskSignal[] = []

  for (const pattern of PATTERNS) {
    const hits = code.match(pattern.regex)?.length ?? 0
    if (hits > 0) {
      signals.push({ id: pattern.id, label: pattern.label, detail: pattern.detail, level: pattern.level, hits })
    }
  }

  const declared = manifest?.capabilities ?? []
  const used = CAPABILITY_USAGE.filter((entry) => entry.regex.test(code)).map((entry) => entry.capability)
  const undeclared = used.filter((c) => !declared.includes(c))
  const unused = declared.filter((c) => !used.includes(c))

  // A declared-but-unreferenced high-risk capability is worth calling out - it
  // is the classic shape of a plugin that will start phoning home after an
  // update it can push without re-asking.
  for (const capability of unused) {
    if (CAPABILITY_INFO[capability].risk === 'high') {
      signals.push({
        id: `unused-${capability}`,
        label: `声明了未使用的高风险能力：${CAPABILITY_INFO[capability].label}`,
        detail: '当前代码并未用到该能力。建议在安装时取消勾选，插件更新后若确实需要会再次提示。',
        level: 'medium',
        hits: 0,
      })
    }
  }

  const suspiciousFormatting = detectObfuscation(code)
  if (suspiciousFormatting) {
    signals.push({
      id: 'obfuscated',
      label: '疑似压缩或混淆代码',
      detail: '代码包含超长行或大量转义字符，难以人工审查。请仅在信任来源时安装。',
      level: 'medium',
      hits: 0,
    })
  }

  const level = signals.reduce<RiskLevel>((worst, s) => (RANK[s.level] > RANK[worst] ? s.level : worst), 'low')

  return {
    level,
    signals: signals.sort((a, b) => RANK[b.level] - RANK[a.level]),
    declared,
    undeclared,
    unused,
    sizeBytes: new TextEncoder().encode(code).length,
    suspiciousFormatting,
  }
}

function detectObfuscation(code: string): boolean {
  const lines = code.split('\n')
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
  if (longest > 2000 && lines.length < code.length / 500) return true
  const escapes = code.match(/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/gi)?.length ?? 0
  return escapes > 200
}

/** Capabilities implied by the signals, for pre-ticking the grant checkboxes. */
export function impliedCapabilities(report: RiskReport): Capability[] {
  const set = new Set<Capability>()
  for (const signal of report.signals) {
    const capability = PATTERN_CAPABILITY[signal.id]
    if (capability) set.add(capability)
  }
  return [...set]
}
