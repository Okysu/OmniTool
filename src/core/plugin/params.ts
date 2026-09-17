/**
 * Helpers shared by everything that runs a tool on the user's behalf - the tool
 * workbench and pipelines - so both derive defaults and filter inputs the same way.
 */
import type { ParamValues, ToolManifest } from '@/core/types'

/** A tool's parameter values before the user touches the form. */
export function defaultParams(tool: Pick<ToolManifest, 'params'>): ParamValues {
  const values: ParamValues = {}
  for (const param of tool.params ?? []) {
    if (param.default !== undefined) values[param.key] = param.default as string | number | boolean
    else if (param.type === 'switch') values[param.key] = false
    else if (param.type === 'number' || param.type === 'slider') values[param.key] = param.min ?? 0
    else if (param.type === 'select') values[param.key] = param.options[0]?.value ?? ''
    else values[param.key] = ''
  }
  return values
}

/** Whether a file satisfies an `accept` list (`.ext`, `type/*` or an exact MIME type). Empty accepts anything. */
export function matchesAccept(file: { name: string; type: string }, accept: readonly string[] = []): boolean {
  if (accept.length === 0) return true
  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()
  return accept.some((rule) => {
    const pattern = rule.trim().toLowerCase()
    if (pattern.startsWith('.')) return name.endsWith(pattern)
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1))
    return type === pattern
  })
}
