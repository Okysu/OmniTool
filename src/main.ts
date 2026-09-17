import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './styles/index.css'

import { initSettings, settings } from '@/core/settings'
import { initVfs } from '@/core/vfs'
import { initRegistry } from '@/core/plugin/registry'
import { initSubscriptions, syncAll } from '@/core/plugin/subscription'
import { pushToast } from '@/core/ui/toast'

// Theme first: it is synchronous and avoids a flash of the wrong palette.
initSettings()

createApp(App).use(router).mount('#app')

/**
 * Storage, plugins and subscriptions boot after mount so the shell paints
 * immediately; views render their own loading state from `registryState.ready`.
 */
async function bootstrap() {
  try {
    await initVfs()
    await initRegistry()
    await initSubscriptions()
  } catch (error) {
    pushToast({
      level: 'error',
      title: '启动失败',
      message: error instanceof Error ? error.message : String(error),
      timeout: 0,
    })
    return
  }

  if (settings.autoUpdateSubscriptions) {
    // Never blocks the UI, and a failing subscription is reported in its own row.
    void syncAll()
  }
}

void bootstrap()

// Request durable storage so the browser does not evict the workspace under
// pressure. Silently ignored where unsupported; purely an optimisation.
void navigator.storage?.persist?.().catch(() => {})
