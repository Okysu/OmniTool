<script setup lang="ts">
/**
 * Hosts a plugin-drawn panel for one tool.
 *
 * Owns the whole UI-session lifecycle: boots the plugin's sandbox, opens a
 * session with the current inputs, re-opens it when the inputs change (so a
 * plugin can re-probe the new file), forwards interactions, transfers canvases,
 * and closes the session on unmount so its inputs stop being readable.
 *
 * The bound state is exposed as `v-model` and becomes the tool's `ctx.params`
 * when it runs, so `run()` never needs to know a panel existed.
 */
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import Spinner from '@/components/common/Spinner.vue'
import PanelNode from './PanelNode.vue'
import { findPlugin, getSandbox, type ToolEntry } from '@/core/plugin/registry'
import type { SandboxHost, UiSession } from '@/core/sandbox/host'
import { sanitizePanel, sanitizeState, type UiNode, type UiState, type UiValue } from '@/core/ui/schema'
import * as vfs from '@/core/vfs'
import type { ParamValues } from '@/core/types'

const props = defineProps<{
  entry: ToolEntry
  inputs: string[]
  /**
   * A sandbox to use instead of the installed plugin's, with a revision that
   * changes whenever it is replaced. The tutorial runs code that is never
   * installed this way.
   */
  sandbox?: { revision: number; get: () => Promise<SandboxHost> }
}>()
const state = defineModel<ParamValues>({ required: true })
const emit = defineEmits<{ meta: [meta: { runLabel?: string; runDisabled: boolean }] }>()

const nodes = shallowRef<UiNode[]>([])
const status = ref<'booting' | 'ready' | 'error'>('booting')
const error = ref('')

/**
 * Working copy of the bound state, updated synchronously.
 *
 * `state` is a v-model: writing it emits to the parent, and reading it back
 * returns the old value until the parent re-renders. Two changes in one tick -
 * a widget reporting metadata and then a range, or a plugin `setState` landing
 * beside a user edit - would each be built from that stale value, and the
 * second would silently erase the first. Every write goes through `live`.
 */
let live: ParamValues = { ...state.value }
watch(state, (value) => {
  live = { ...value }
})

function patchState(patch: ParamValues) {
  live = { ...live, ...patch }
  state.value = live
}

let session: UiSession | null = null
/** Bumped on every re-open so late messages from a stale session are ignored. */
let generation = 0

async function open() {
  const current = ++generation
  session?.close()
  session = null
  status.value = 'booting'
  error.value = ''
  // Unmount the previous tree. Canvases were transferred to the old session, so
  // they must remount to be handed to the new one; stale controls also must not
  // stay clickable while the plugin rebuilds for the new inputs.
  nodes.value = []

  const record = props.sandbox ? null : findPlugin(props.entry.pluginId)
  if (!props.sandbox && !record) {
    status.value = 'error'
    error.value = '插件已卸载'
    return
  }

  try {
    const sandbox = props.sandbox ? await props.sandbox.get() : await getSandbox(record!)
    if (current !== generation) return

    const inputs = props.inputs
      .map((id) => vfs.get(id))
      .filter((e): e is vfs.VfsEntry => Boolean(e))
      .map((e) => vfs.toRef(e))

    session = sandbox.openUi(props.entry.tool.id, inputs, { ...live }, {
      onRender: (raw) => {
        if (current !== generation) return
        const panel = sanitizePanel(raw)
        nodes.value = panel.nodes
        if (panel.state) patchState(panel.state as ParamValues)
        emit('meta', { runLabel: panel.runLabel, runDisabled: panel.runDisabled ?? false })
        status.value = 'ready'
      },
      onState: (patch) => {
        if (current !== generation) return
        patchState(sanitizeState(patch) as ParamValues)
      },
      onReady: () => {
        if (current === generation && status.value === 'booting') status.value = 'ready'
      },
      onError: (message) => {
        if (current !== generation) return
        status.value = 'error'
        error.value = message
      },
    })
  } catch (err) {
    if (current !== generation) return
    status.value = 'error'
    error.value = err instanceof Error ? err.message : String(err)
  }
}

watch(() => [props.entry.key, props.inputs.join('|'), props.sandbox?.revision], open, { immediate: true })
onBeforeUnmount(() => {
  generation++
  session?.close()
})

function onChange(key: string, value: UiValue) {
  patchState({ [key]: value as ParamValues[string] })
  session?.event('change', key, value, live)
}

function onAction(name: string) {
  session?.event('action', name, null, live)
}

function onPointer(canvasId: string, event: Record<string, number | string>) {
  session?.event('pointer', canvasId, event, live)
}

function onCanvas(canvasId: string, canvas: OffscreenCanvas, width: number, height: number) {
  session?.attachCanvas(canvasId, canvas, width, height)
}
</script>

<template>
  <div>
    <div v-if="status === 'booting' && nodes.length === 0" class="flex items-center gap-2 py-6 text-xs text-muted-foreground">
      <Spinner :size="14" />
      正在加载插件界面…
    </div>

    <div v-else-if="status === 'error'" class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <Icon name="circle-alert" :size="14" class="mt-0.5 shrink-0 text-destructive" />
      <p class="break-words text-xs leading-relaxed text-destructive">{{ error }}</p>
    </div>

    <div v-if="nodes.length" class="flex flex-col gap-4" :class="status === 'error' ? 'mt-3' : ''">
      <PanelNode
        v-for="(node, index) in nodes"
        :key="index"
        :node="node"
        :state="state as UiState"
        @change="onChange"
        @action="onAction"
        @pointer="onPointer"
        @canvas="onCanvas"
      />
    </div>
  </div>
</template>
