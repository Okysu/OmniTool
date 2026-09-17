<script setup lang="ts">
/**
 * Renders an HTML output the way a browser would, without trusting it.
 *
 * Outputs can come from third-party plugins, so the frame gets an empty
 * `sandbox` (no scripts, forms, popups or top navigation, opaque origin) and a
 * CSP injected into the document that blocks every network fetch. Without the
 * CSP, an `<img src="https://…">` in a converted file would phone home, which a
 * local-first tool must not do just because the user looked at a result.
 */
import { computed } from 'vue'

const props = defineProps<{ html: string; title?: string }>()

const POLICY =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'"

const srcdoc = computed(() => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`
  // A meta CSP only applies from <head>; fragments have none, and the parser
  // hoists a leading <meta> into the implied head.
  const head = /<head(\s[^>]*)?>/i.exec(props.html)
  if (head) return props.html.slice(0, head.index + head[0].length) + meta + props.html.slice(head.index + head[0].length)
  return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${props.html}</body></html>`
})
</script>

<template>
  <iframe
    :srcdoc="srcdoc"
    sandbox=""
    referrerpolicy="no-referrer"
    :title="title ?? 'HTML 预览'"
    class="block w-full border-0 bg-white"
  />
</template>
