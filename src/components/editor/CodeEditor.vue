<script setup lang="ts">
/**
 * Monaco (the VS Code editor core) configured for writing OmniTool plugins.
 *
 * What makes it plugin-aware rather than a generic JS box:
 *   - `sdk/omnitool-plugin.d.ts` is registered as an ambient library, so
 *     `definePlugin`, `host.*`, `ctx` and `ui` complete, show hover docs and
 *     type-check as you type.
 *   - The lib is `webworker`, not `dom`: plugins run on a Worker in the
 *     sandbox, so offering `document` completions would be actively misleading.
 *
 * Monaco is several megabytes, so it is imported dynamically and only paid for
 * when someone actually opens the editor.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Spinner from '@/components/common/Spinner.vue'
import pluginTypes from '../../../sdk/omnitool-plugin.d.ts?raw'
import { settings } from '@/core/settings'

const props = withDefaults(defineProps<{ language?: string; readOnly?: boolean }>(), {
  language: 'javascript',
  readOnly: false,
})
const model = defineModel<string>({ required: true })
const emit = defineEmits<{ problems: [count: { errors: number; warnings: number }]; save: [] }>()

const host = ref<HTMLElement | null>(null)
const loading = ref(true)
// `typeof import('monaco-editor')` without dragging the types into the main chunk.
type Monaco = typeof import('monaco-editor')
const monacoRef = shallowRef<Monaco | null>(null)
let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null
let disposables: Array<{ dispose(): void }> = []
let configured = false

function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

async function loadMonaco(): Promise<Monaco> {
  const [monaco, { default: EditorWorker }, { default: TsWorker }] = await Promise.all([
    import('monaco-editor'),
    import('monaco-editor/editor/editor.worker?worker'),
    import('monaco-editor/language/typescript/ts.worker?worker'),
  ])

  // Workers are bundled by Vite as same-origin module workers, so they load
  // under COEP and offline like everything else.
  ;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker(_: string, label: string) {
      return label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()
    },
  }

  if (!configured) {
    configured = true
    const js = monaco.typescript.javascriptDefaults
    js.setCompilerOptions({
      allowJs: true,
      checkJs: true,
      target: monaco.typescript.ScriptTarget.ESNext,
      lib: ['es2022', 'webworker'],
      allowNonTsExtensions: true,
      noEmit: true,
    })
    js.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false })
    js.addExtraLib(pluginTypes, 'file:///node_modules/@types/omnitool/index.d.ts')

    // Accent-tinted themes so the editor does not look bolted on.
    monaco.editor.defineTheme('omni-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#fbfbfc', 'editorLineNumber.foreground': '#a1a1aa' },
    })
    monaco.editor.defineTheme('omni-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#141317', 'editorLineNumber.foreground': '#52525b' },
    })
  }
  return monaco
}

onMounted(async () => {
  const monaco = await loadMonaco()
  monacoRef.value = monaco
  if (!host.value) return

  const uri = monaco.Uri.parse(`file:///plugin-${Math.random().toString(36).slice(2)}.js`)
  const textModel = monaco.editor.createModel(model.value, props.language, uri)

  editor = monaco.editor.create(host.value, {
    model: textModel,
    theme: isDark() ? 'omni-dark' : 'omni-light',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    lineHeight: 20,
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    tabSize: 2,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'gutter',
    readOnly: props.readOnly,
    padding: { top: 12, bottom: 12 },
    fixedOverflowWidgets: true,
    quickSuggestions: { other: true, strings: true, comments: false },
  })

  disposables.push(
    textModel.onDidChangeContent(() => {
      const value = textModel.getValue()
      if (value !== model.value) model.value = value
    }),
    monaco.editor.onDidChangeMarkers((uris) => {
      if (!uris.some((u) => u.toString() === uri.toString())) return
      const markers = monaco.editor.getModelMarkers({ resource: uri })
      emit('problems', {
        errors: markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length,
        warnings: markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length,
      })
    }),
    textModel,
  )

  // Cmd/Ctrl+S saves instead of triggering the browser's "save page" dialog.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit('save'))

  loading.value = false
})

// Keep external edits (template switch, file import) in sync without clobbering the cursor on every keystroke.
watch(model, (value) => {
  const current = editor?.getModel()
  if (current && current.getValue() !== value) current.setValue(value)
})

// Follow the app theme.
watch(
  () => settings.theme,
  () => {
    requestAnimationFrame(() => monacoRef.value?.editor.setTheme(isDark() ? 'omni-dark' : 'omni-light'))
  },
)

onBeforeUnmount(() => {
  for (const item of disposables) item.dispose()
  disposables = []
  editor?.dispose()
  editor = null
})

/** Jumps to a line, e.g. from a validation error. */
function revealLine(line: number) {
  if (!editor) return
  editor.revealLineInCenter(line)
  editor.setPosition({ lineNumber: line, column: 1 })
  editor.focus()
}

defineExpose({ revealLine })
</script>

<template>
  <div class="relative size-full min-h-80">
    <div ref="host" class="absolute inset-0" />
    <div v-if="loading" class="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <Spinner :size="14" />
      正在加载编辑器…
    </div>
  </div>
</template>
