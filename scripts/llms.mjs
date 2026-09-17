/**
 * Generates `public/llms.txt` and `public/llms-full.txt`: English plugin
 * documentation in the form AI assistants read best - plain text, one request.
 *
 * Sources:
 *   docs/llms/plugin-guide.md   the English reference (kept in step with docs/design/02-plugin-api.md)
 *   sdk/omnitool-plugin.d.ts    exact types
 *   docs/learn/*.md             tutorial reference solutions (code only, with English titles)
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFile(join(root, path), 'utf8')

const RULES = `## Hard rules for generated plugins

1. One file, plain JavaScript, no imports/exports, no build step. Call \`definePlugin({...})\` exactly once at top level.
2. The code runs in a sandboxed Web Worker with an opaque origin: there is no \`document\`, \`window\` or \`DOMParser\`; \`fetch\`, \`XMLHttpRequest\` and \`WebSocket\` throw; there is no \`localStorage\`, \`indexedDB\` or \`crypto.subtle\`. \`OffscreenCanvas\`, \`createImageBitmap\`, \`TextEncoder\`, \`Blob\`, typed arrays and \`WebAssembly\` are available.
3. Everything outside the sandbox goes through the host API (\`ctx.host\` in \`run\`, \`ui.host\` in \`setup\`), and each namespace needs a declared capability: fs, ui, kv, image, ffmpeg, onnx, secret, net. Declare only what the code uses.
4. Files are handles: \`ctx.inputs\` is \`[{ id, name, size, type }]\`. Read with \`host.fs.readText(id)\`, \`readAll(id)\` or \`blob(id)\`; write with \`host.fs.writeAll(name, data, mimeType)\`; return \`{ outputs: [file.id], summary }\`.
5. Tool fields: \`id\` (2+ chars), \`name\`, \`category\` (pdf | media | image | document | ai | archive | other), \`run(ctx)\`; optional \`accept\`, \`multiple\`, \`input\` ('files' | 'text' | 'both' | 'none'), and either \`params\` (generated form) or \`setup(ui)\` (declarative panel - never HTML).
6. Every param needs a sensible \`default\`. Read values from \`ctx.params\`; coerce numbers with \`Number()\`.
7. Errors: \`throw new Error('what went wrong and what to do')\` - it is shown to the user verbatim. Report progress with \`ctx.progress(0..1, label)\` and call \`ctx.throwIfAborted()\` between expensive steps.
8. Third-party libraries: declare \`deps: [{ id, url, global, integrity?, lazy? }]\`; the host fetches and injects them. With \`lazy: true\`, obtain them via \`await loadDependency(id)\`, which returns \`{ exports, assets }\`.
9. FFmpeg: \`await ctx.host.ffmpeg.run({ args, inputs: [ids], outputs: [names] })\` with \`$in0\`/\`$out0\` placeholders, no \`-threads\`. Probe (\`ctx.host.ffmpeg.probe(id)\`) before using an audio or video stream that may not exist.
10. Plugin ids are reverse-DNS and never change; bump \`version\` on every release.
`

async function main() {
  const guide = await read('docs/llms/plugin-guide.md')
  const sdk = await read('sdk/omnitool-plugin.d.ts')
  const names = (await readdir(join(root, 'docs/learn'))).filter((n) => /^\d+-[\w-]+\.md$/.test(n)).sort()
  const examples = []
  for (const name of names) {
    const source = (await read(`docs/learn/${name}`)).replace(/\r\n/g, '\n')
    const title = /^titleEn:\s*(.+)$/m.exec(source)?.[1] ?? name.replace(/\.md$/, '')
    const solution = /^```js solution\n([\s\S]*?)^```\s*$/m.exec(source)?.[1]
    if (solution) examples.push({ title, code: solution.trimEnd() })
  }

  const index = `# OmniTool

> A local-first file toolkit that runs entirely in the browser. Every tool - PDF, image, audio/video, documents, archives, local AI - is a sandboxed plugin, and third-party plugins use exactly the same API as the built-in ones.

Use these documents to write OmniTool plugins. Install the result via Plugins → New plugin in the app, or host the file at any https URL and add it as a subscription.

${RULES}
## Documentation

- [Complete plugin documentation](/llms-full.txt): guide, TypeScript declarations and ${examples.length} worked examples in one file.
- [Interactive tutorial](/#/learn): edit plugins with a live preview running in a real sandbox (Chinese).

## Worked examples in llms-full.txt

${examples.map((e, i) => `${i + 1}. ${e.title}`).join('\n')}
`

  const full = `# OmniTool plugin documentation (complete)

Generated from the project's documentation for AI assistants. Sections: hard rules, guide, type declarations, worked examples.

${RULES}
---

# Part 1 · Guide

${guide.replace(/^# OmniTool Plugin Guide\n+/, '').trim()}

---

# Part 2 · Type declarations (sdk/omnitool-plugin.d.ts)

\`\`\`ts
${sdk.trim()}
\`\`\`

---

# Part 3 · Worked examples

Complete, working plugins from the interactive tutorial, in increasing order of difficulty. User-facing strings are Chinese because OmniTool's interface is Chinese; any language works.

${examples.map((e, i) => `## Example ${i + 1}: ${e.title}\n\n\`\`\`js\n${e.code}\n\`\`\``).join('\n\n')}
`

  await mkdir(join(root, 'public'), { recursive: true })
  await writeFile(join(root, 'public/llms.txt'), index)
  await writeFile(join(root, 'public/llms-full.txt'), full)
  console.log(`[llms] wrote public/llms.txt and public/llms-full.txt (${examples.length} examples, ${Math.round(full.length / 1024)} KB)`)
}

await main()
