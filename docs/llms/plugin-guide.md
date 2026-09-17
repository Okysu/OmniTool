# OmniTool Plugin Guide

OmniTool is a local-first file toolkit that runs entirely in the browser. Every tool — PDF, image, audio/video, documents, archives, local AI — is a plugin, and the built-in tools use exactly the same API as third-party plugins. This guide is the complete reference for writing one.

A plugin is one JavaScript file that calls `definePlugin()` once. There is no build step, no `import`, no framework.

## Minimal example

```js
definePlugin({
  id: 'com.example.copy',
  name: 'Copy',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'copy',
      name: 'Copy file',
      category: 'other',
      async run(ctx) {
        const input = ctx.inputs[0]
        const bytes = await ctx.host.fs.readAll(input.id)
        const out = await ctx.host.fs.writeAll('copy-' + input.name, bytes, input.type)
        return { outputs: [out.id], summary: 'Copied 1 file' }
      },
    },
  ],
})
```

User-facing strings (tool names, labels, summaries, errors) may be in any language; OmniTool's own UI is Chinese, so Chinese strings fit in naturally.

## Runtime environment

Plugin code runs in a Web Worker inside a sandboxed iframe with an opaque origin.

| Available | Not available |
| --- | --- |
| Plain JavaScript, `WebAssembly` | `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts` — they throw; use `host.net` |
| `OffscreenCanvas`, `createImageBitmap`, `ImageData` | `document`, `window`, the DOM, `DOMParser` |
| `TextEncoder`/`TextDecoder`, `Blob`, typed arrays, `crypto.getRandomValues` | `crypto.subtle` (an opaque origin is not a secure context) — use `host.fs.digest` |
| The `host.*` namespaces your plugin was granted | `localStorage`, `indexedDB` — use `host.kv` |

Image processing belongs in the sandbox with `OffscreenCanvas`: it runs off the UI thread.

## Manifest

### Plugin fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Globally unique, `/^[a-z0-9][a-z0-9._-]{1,63}$/i`. Reverse-DNS, e.g. `com.you.tools`. Never change it. |
| `name` | string | yes | Display name |
| `version` | string | | Semver. Bump on every release. |
| `description`, `author`, `homepage` | string | | Metadata |
| `icon` | string | | Lucide icon name in kebab-case, e.g. `file-json` |
| `capabilities` | string[] | | Requested capabilities (see below). Declare only what you use. |
| `deps` | Dependency[] | | Third-party scripts the host fetches, verifies and injects |
| `tools` | Tool[] | yes | At least one |

### Tool fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Unique within the plugin, at least 2 characters |
| `name` | string | yes | Display name |
| `category` | string | yes | `pdf`, `media`, `image`, `document`, `ai`, `archive`, `other` |
| `description`, `icon`, `keywords` | | | Shown on cards and used by search |
| `accept` | string[] | | File filter: extensions (`.pdf`), wildcards (`image/*`) or exact MIME types |
| `multiple` | boolean | | Accept several files. Default `false`. |
| `minFiles` | number | | Inputs required before the run button enables. Default `1` (`0` with `input: 'none'`). |
| `input` | string | | `'files'` (default, drop zone), `'text'` (text box), `'both'` (tabs), `'none'` (no input; generators) |
| `textFileName` | string | | Name given to pasted text; its extension drives format detection. Default `input.txt`. |
| `params` | Param[] | | Generated form |
| `setup(ui)` | function | | Custom declarative panel; when defined, `params` is ignored |
| `run(ctx)` | function | yes | Does the work |

Pasted text is written to the workspace as a file before `run` is called, so `run` always receives files in `ctx.inputs`, whichever way the user supplied input.

## Generated forms: `params`

The host renders the form; values arrive in `ctx.params`.

```js
params: [
  { key: 'quality', type: 'slider', label: 'Quality', min: 1, max: 100, default: 80, suffix: '%' },
  { key: 'format', type: 'select', label: 'Format', default: 'webp',
    options: [{ value: 'webp', label: 'WebP' }, { value: 'png', label: 'PNG' }] },
  { key: 'background', type: 'text', label: 'Background', default: '#ffffff',
    when: { key: 'format', equals: 'png' } },
]
```

| `type` | Extra fields |
| --- | --- |
| `text` | `default`, `placeholder` |
| `textarea` | `default`, `placeholder`, `rows` |
| `number` | `default`, `min`, `max`, `step`, `suffix` |
| `slider` | `min` (required), `max` (required), `default`, `step`, `suffix` |
| `switch` | `default` |
| `select` | `options` (required), `default` |

Every param supports `hint` and `when` (conditional display; `equals` may be an array). Give every param a sensible `default`. Coerce numbers with `Number()` in `run`.

## Running: `run(ctx)`

| Field | Meaning |
| --- | --- |
| `ctx.inputs` | `FileRef[]` — `{ id, name, size, type }`. Only `id` is a capability. |
| `ctx.params` | Form values, or the bound state of your `setup` panel |
| `ctx.signal` | `AbortSignal`, aborted when the user cancels |
| `ctx.throwIfAborted()` | Throws if cancelled. Call between expensive steps and in loops. |
| `ctx.progress(value, label?)` | `value` in 0..1, or `null` for indeterminate. Throttled by the host. |
| `ctx.host` | The host API. Prefer it over the global `host` inside `run`: FFmpeg and download progress, and cancellation, are attributed to this task. |

Return `{ outputs: [fileId, …], summary }`. Make the summary specific: "657.6 KB → 6.0 KB (-99.1%)" is better than "Done".

Errors: `throw new Error('…')`. The message is shown to the user verbatim, so write what went wrong and what to do about it (for example "report.pdf is password-protected; unlock it first"), never a raw stack trace.

## Custom panels: `setup(ui)`

For interactions a form cannot express — timelines, crop boxes, live previews, drawing — define `setup(ui)`. A panel is data, not markup: the host renders it with its own components, so no HTML, styles or event handlers cross the sandbox boundary, and all strings render as plain text.

```js
async setup(ui) {
  const input = ui.inputs[0]
  if (!input) {
    ui.render({ runDisabled: true, nodes: [{ type: 'alert', tone: 'info', text: 'Drop a video first.' }] })
    return
  }
  ui.render({
    state: { range: [], copy: true },
    runLabel: 'Export clip',
    nodes: [
      { type: 'timeline', fileId: input.id, bind: 'range' },
      { type: 'switch', bind: 'copy', label: 'Lossless cut' },
    ],
  })
},

async run(ctx) {
  const [start, end] = ctx.params.range   // bound panel state is ctx.params
}
```

### The `ui` object

| Member | Meaning |
| --- | --- |
| `ui.inputs` | Currently selected files (readable while the panel is open) |
| `ui.state` | Current bound values, kept in sync with user edits |
| `ui.host` | The host API |
| `ui.render(panel)` | Replaces the panel: `{ nodes, state?, runLabel?, runDisabled? }` |
| `ui.setState(patch)` | Updates bound values without resending the tree |
| `ui.on('change', (key, value, state) => …)` | A bound control changed |
| `ui.on('action', (name, _, state) => …)` | A `button` was clicked |
| `ui.on('pointer', (canvasId, p, state) => …)` | Pointer input on an interactive canvas: `p = { type: 'down' \| 'move' \| 'up', x, y, buttons }` in canvas pixels |
| `ui.on('canvas', (canvasId, canvas, state) => …)` | A canvas surface was handed over (first render and every re-mount). Repaint here. |
| `await ui.canvas(id)` | The `OffscreenCanvas` behind a rendered `canvas` node |

`on()` returns an unsubscribe function.

Lifecycle: `setup` runs when the tool opens and again whenever the selected inputs change (the old panel is torn down first). When the tool runs, the bound state becomes `ctx.params`. Tools with `setup` have no `params`, so the host fills no defaults — default missing keys in `run` yourself.

### Nodes

Every node supports `when: { key, equals }`. Unknown node types are ignored.

| Type | Fields | Purpose |
| --- | --- | --- |
| `stack`, `row` | `children`, `gap`; row also `align`, `wrap` | Layout |
| `section` | `title`, `children` | Titled group |
| `separator` | | Divider |
| `text` | `text`, `variant: title \| body \| muted \| mono` | Text |
| `badge` | `text`, `tone` | Badge |
| `alert` | `text`, `title`, `tone: info \| success \| warning \| destructive` | Callout |
| `facts` | `rows: [{ label, value }]` | Key/value list, good for probe results |
| `input` | `bind`, `label`, `hint`, `placeholder`, `inputType: text \| number`, `min`, `max`, `step`, `suffix` | Input |
| `textarea` | `bind`, `label`, `hint`, `rows`, `mono` | Multi-line text |
| `select` | `bind`, `label`, `options` | Dropdown |
| `segmented` | `bind`, `label`, `options` | 2–4 exclusive options |
| `slider` | `bind`, `min`, `max`, `step`, `suffix`, `label` | Slider |
| `switch` | `bind`, `label`, `hint` | Toggle |
| `color` | `bind`, `label` | Color picker |
| `button` | `text`, `action` (required), `variant`, `icon`, `disabled`, `busy` | Emits an `action` event |
| `preview` | `fileId`, `height` | Inline preview of an image, video, audio, PDF or text file |
| `timeline` | `fileId`, `bind` | Media scrubber with a two-handle range; binds `[startSeconds, endSeconds]` |
| `media` | `fileId`, `range`, `crop`, `cropAspect`, `markers`, `meta`, `effects`, `height` | Visual media editor (below) |
| `reorder` | `bind`, `items: [{ label, detail }]`, `label` | Reorderable list; binds a permutation such as `[2, 0, 1]` |
| `canvas` | `id`, `aspect`, `height`, `interactive` | Drawing surface (below) |

### `media`: visual audio/video editing

Every field except `fileId` names a state key. The host handles playback, dragging and previews; the plugin only reads and writes state.

| Field | Bound value | Interaction |
| --- | --- | --- |
| `range` | `[start, end]` seconds | Two-handle range on a waveform strip |
| `crop` | `[x, y, w, h]` as fractions (0–1) of the source frame; `[]` hides the box | Drag and resize a box over the picture |
| `cropAspect` | Pixel ratio w/h, `0` for free | Constrains the crop box |
| `markers` | Seconds (up to 64) | "Mark current frame" |
| `meta` | Written by the host as `[duration, width, height]` | Fires a `change` once the media loads |
| `effects` | `{ effect: key }` or `{ effect: { bind, scale } }` | Live preview |

Effects: `rotate` (degrees, multiples of 90), `flipH`/`flipV`/`mute` (boolean), `brightness` (-1..1, like ffmpeg `eq`), `contrast`/`saturation`/`speed`/`volume` (multipliers, 1 = unchanged), `hue` (degrees), `fadeIn`/`fadeOut` (seconds from the range edges). Previews are approximate; the export is whatever your FFmpeg command does. Apply filters in the order crop → rotate/flip → color, which is how the preview is drawn. Crop as fractions lets one box apply to files of different resolutions: `crop=trunc(iw*w/2)*2:trunc(ih*h/2)*2:trunc(iw*x):trunc(ih*y)`.

### `canvas`: pixel-level interaction

```js
const strokes = []   // module scope: run() executes in the same sandbox and can read it

setup(ui) {
  ui.render({ nodes: [{ type: 'canvas', id: 'pad', aspect: 2, interactive: true }] })
  let surface = null
  ui.on('canvas', (id, canvas) => { surface = canvas; paint(surface) })
  ui.on('pointer', (id, p) => {
    if (!surface) return
    const point = [p.x / surface.width, p.y / surface.height]
    if (p.type === 'down') strokes.push([point])
    else if (p.type === 'move' && p.buttons) strokes[strokes.length - 1]?.push(point)
    paint(surface)
  })
}
```

Canvas size is fixed at hand-over (container size × device pixel ratio). Moves are coalesced to one per frame. When a node is hidden and shown again the host hands over a new canvas, so repaint in `ui.on('canvas')`.

## Host API

Each namespace requires the matching capability; calls without a grant are rejected by the host.

### `fs` — files

Readable: this invocation's inputs, the open panel's inputs, and files your plugin created. Nothing else.

```js
await host.fs.read(id, offset = 0, length = -1)     // Uint8Array
await host.fs.readAll(id)
await host.fs.readText(id)
await host.fs.readJSON(id)
await host.fs.blob(id, type?)
await host.fs.create(name, type?)                   // FileRef, open for writing
await host.fs.write(id, data)                       // append (copied)
await host.fs.writeTransfer(id, data)               // append (transferred; data becomes unusable)
await host.fs.close(id)                             // FileRef
await host.fs.writeAll(name, data, type?)           // create + write + close
await host.fs.remove(id)                            // delete a file you created
await host.fs.digest(id, 'SHA-256')                 // hex digest
```

Output names may contain folders (`docs/a.txt`); the host sanitizes each segment and keeps the structure when the user downloads a ZIP.

### `ui` — notifications

```js
await host.ui.notify(message, 'info' | 'success' | 'warn' | 'error')
```

Use it for side information ("skipped 2 empty files"); throw for failures.

### `kv` — private storage

```js
await host.kv.get(key)          // value or null
await host.kv.set(key, value)   // JSON-serializable, max 256 KB
await host.kv.remove(key)
await host.kv.keys()
```

Private to your plugin and encrypted at rest. For preferences and history, not credentials.

### `net` — network (high risk)

```js
await host.net.fetch(url, { method, headers, body })   // { status, ok, headers, body: Uint8Array }
await host.net.fetchText(url, init)
await host.net.fetchJSON(url, init)
```

Requests never carry the user's cookies; only `http:`/`https:`; responses up to 64 MB; localhost and private networks are blocked unless the user allows them. Declaring `net` tells the user their files may leave the machine — only do it when the tool genuinely needs a remote service.

### `secret` — credentials

A plugin never sees a credential's value. The host draws the input dialog; the plugin references the secret by name in `host.net` requests, and the host substitutes it only for origins the user approved.

```js
await ctx.host.secret.request('apiKey', {
  label: 'DeepL API Key',
  hint: 'Find it at deepl.com/account',
  origins: ['https://api-free.deepl.com'],
})

await ctx.host.net.fetch('https://api-free.deepl.com/v2/translate', {
  method: 'POST',
  headers: { Authorization: 'DeepL-Auth-Key {{secret:apiKey}}' },
  body: JSON.stringify({ text: ['hello'], target_lang: 'ZH' }),
})

await host.secret.has(name)
await host.secret.list()       // metadata only
await host.secret.remove(name)
```

Requires both `net` and `secret`.

### `image` — host-side canvas (fallback)

```js
await host.image.probe(id)             // { width, height }
await host.image.transcode(id, { format, quality, maxWidth, maxHeight, width, background })
                                       // { width, height, type, body: ArrayBuffer }
await host.image.encoders()            // ['image/png', …]
```

Prefer `OffscreenCanvas` in the sandbox. Use this for SVG, which workers cannot decode (`width` sets the exact output width).

### `ffmpeg` — local audio/video

```js
const { files, log } = await ctx.host.ffmpeg.run({
  args: ['-i', '$in0', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '$out0'],
  inputs: [ctx.inputs[0].id],
  outputs: ['audio.mp3'],
  label: 'Extract audio',
})

await ctx.host.ffmpeg.probe(id)
// { durationSeconds, width, height, videoCodec, audioCodec, log }
```

- Refer to inputs as `$in0`, `$in1`, … and outputs as `$out0`, …; placeholders also work inside filter strings.
- An output name containing `%04d` is an image sequence; every frame is collected.
- Outputs go straight to the workspace — a 2 GB result never enters your heap.
- Do not pass `-threads`; the host assigns a thread budget (the WASM build has a fixed thread pool and exceeding it deadlocks).
- `lavfi` sources work with `inputs: []`, e.g. `-f lavfi -i sine=frequency=440:duration=2`.
- Probe before using a stream that may not exist: a screen recording has no audio track, and `[0:a:0]` on it fails with an opaque error. Check `audioCodec` and throw a clear message instead.
- FFmpeg loads on first use (about 32 MB) and is shared by all plugins; runs are queued.

### `onnx` — local model inference

```js
const session = await ctx.host.onnx.load({
  id: 'u2netp',                    // plain file-name characters
  name: 'U²-Net (portable)',
  url: 'https://huggingface.co/…/model.onnx',
  sha256: '…64 hex characters…',   // required; verified on download and every load
  bytes: 4_600_000,
  license: 'Apache-2.0',
})
const info = await ctx.host.onnx.info(session)      // { inputs, outputs }
const out = await ctx.host.onnx.run(session, {
  input: { type: 'float32', dims: [1, 3, 320, 320], data: float32Array },
})
await ctx.host.onnx.release(session)
```

- The first use of a model asks the user to approve the download (source, size, SHA-256, license are shown), then caches it locally. Users can switch Hugging Face URLs to a mirror in settings; the SHA-256 check still applies.
- Inference runs in a dedicated worker (WebGPU when a real adapter exists, otherwise multi-threaded WASM).
- Sessions are scoped to your plugin and released when its sandbox is disposed.

Autoregressive models: keep outputs inside the runtime and feed them back without copying.

```js
const step = await ctx.host.onnx.run(decoder, feeds, {
  keep: ['present.0.decoder.key'],               // returned as { type, dims, tensor: 't17' }
  outputs: ['logits', 'present.0.decoder.key'],  // compute only these (default: all)
})
await ctx.host.onnx.run(decoder, {
  'past_key_values.0.decoder.key': { tensor: step['present.0.decoder.key'].tensor },
}, { keep: [/* … */] })
await ctx.host.onnx.dispose([step['present.0.decoder.key'].tensor])
```

Handles are per plugin, capped at 4096 live tensors, and freed with the sandbox.

## Dependencies

```js
deps: [
  { id: 'pdf-lib', url: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js', global: 'PDFLib', integrity: 'sha384-…' },
]
```

The host fetches the script, verifies `integrity` (Subresource Integrity), caches it and injects it before your code. The script must be a classic script (UMD/IIFE) that defines a global; there is no `import`. If a bundle starts with `"use strict"`, its top-level `var X` does not become global under the host's indirect `eval` — end the file with `globalThis.X = X`. Dependencies run with your plugin's permissions, and the install dialog says so.

OmniTool serves some libraries from its own origin: `/vendor/pdf-lib.js` (`PDFLib`), `/vendor/pdfjs.js` (`pdfjsLib`), `/vendor/fflate.js` (`fflate`), `/vendor/fontkit.js` (`fontkit`).

Large or rarely used libraries can be lazy and carry binary assets:

```js
deps: [
  {
    id: 'magick',
    url: '/vendor/magick/magick.js',
    global: 'MagickWasm',
    lazy: true,
    assets: { 'magick.wasm': { url: '/vendor/magick/magick.wasm', integrity: 'sha384-…' } },
  },
],

async run(ctx) {
  const { exports, assets } = await loadDependency('magick')   // fetched on first call, then reused
  await exports.initializeImageMagick(new Uint8Array(assets['magick.wasm']))
}
```

`loadDependency(id)` returns `{ exports, assets }` (`assets`: name → `ArrayBuffer`). Only dependencies declared in the installed manifest can be loaded. Assets are verified on every load; each may be up to 64 MB.

## Capabilities and security

| Capability | Risk | Grants |
| --- | --- | --- |
| `fs` | low | Read inputs, write outputs |
| `ui` | low | Notifications |
| `image` | low | Host canvas decode/encode |
| `ffmpeg` | low | Local FFmpeg |
| `onnx` | low | Local inference (each model download is approved by the user) |
| `kv` | medium | Private encrypted storage |
| `secret` | medium | Ask for credentials that can be used but never read |
| `net` | high | Outbound requests — user files may leave the machine |

The user approves capabilities one by one at install time, alongside a static analysis of the source (dynamic code execution, network endpoints, declared-but-unused high-risk capabilities, used-but-undeclared ones). A subscription update that requests new capabilities is held for review instead of applying silently.

## Installing and publishing

- Local install: in OmniTool, open 插件与订阅 (Plugins) → 创建新插件 (New plugin), paste the code, save with Ctrl/⌘ S. The editor validates the manifest in a zero-permission sandbox and offers completions for `host.`, `ctx.` and `ui.`.
- Publishing: host the file at any https URL; users add it as a subscription. A subscription URL may also point to an index:

```json
{
  "name": "My tools",
  "description": "A few handy tools",
  "plugins": [
    { "url": "./json-tools.js" },
    { "url": "https://example.com/other-plugin.js" }
  ]
}
```

Relative URLs resolve against the index. Update by publishing a new file with a higher `version`.

## Checklist

- `id` is reverse-DNS, unique, and never changes; `version` is bumped per release.
- Only the capabilities the code actually uses are declared.
- Every param has a sensible `default`; `setup` tools default missing keys in `run`.
- Error messages tell the user what happened and what to do.
- Batch work reports `ctx.progress` and calls `ctx.throwIfAborted()`.
- Streams are probed before use; very large images are considered.
- Cross-origin dependencies have `integrity`.
- Summaries are specific.

## Debugging

- `console.log`/`warn`/`error` from a plugin are forwarded to the browser console with the plugin name.
- The editor shows the parsed manifest, static analysis results and registration errors live.
- Settings → Diagnostics shows the sandbox isolation level, the FFmpeg core, the ONNX backend and the full host method list.
- The interactive tutorial at `/#/learn` runs any plugin code in a real sandbox with a live preview.
