/**
 * Bundled plugins.
 *
 * These are ordinary plugins: same source format, same sandbox, same host API,
 * same capability checks. The only differences are that their source ships with
 * the app instead of being fetched, their grants are pre-approved, and they
 * cannot be uninstalled (only disabled).
 *
 * Keeping the built-ins on the public API is deliberate - every gap in the
 * Plugin API shows up here first.
 */
import imageTools from './image-tools.js?raw'
import pdfTools from './pdf-tools.js?raw'
import mediaTools from './media-tools.js?raw'
import dataTools from './data-tools.js?raw'
import archiveTools from './archive-tools.js?raw'
import aiTools from './ai-tools.js?raw'

export interface BuiltinPlugin {
  /** Must match the `id` the source passes to `definePlugin`. */
  id: string
  code: string
}

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  { id: 'omnitool.image', code: imageTools },
  { id: 'omnitool.pdf', code: pdfTools },
  { id: 'omnitool.media', code: mediaTools },
  { id: 'omnitool.data', code: dataTools },
  { id: 'omnitool.archive', code: archiveTools },
  { id: 'omnitool.ai', code: aiTools },
]
