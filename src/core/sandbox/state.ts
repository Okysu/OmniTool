import { reactive } from 'vue'

/**
 * Observed sandbox capabilities, written by every `SandboxHost` as it boots.
 *
 * Lives in its own module so both the plugin registry and the diagnostics panel
 * can read it without importing the registry into the sandbox layer.
 */
export const sandboxState = reactive({
  /** Tier the most recently booted sandbox achieved. */
  isolation: null as import('@/core/types').IsolationMode | null,
  /** Sandboxes booted this session, including throwaway manifest probes. */
  bootCount: 0,
})
