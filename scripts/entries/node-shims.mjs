/**
 * Injected into bundles that expect Node's `Buffer` global (iconv-lite, used by
 * the Outlook MSG reader for legacy code pages). Browser-safe userland versions.
 */
import { Buffer } from 'buffer'

export { Buffer }
