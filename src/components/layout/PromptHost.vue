<script setup lang="ts">
/**
 * Renders the dialogs plugins can trigger but never draw.
 *
 * The credential dialog in particular is deliberately hostile to spoofing: the
 * plugin supplies only the label and hint text, while the identity of the
 * asking plugin and the full origin allowlist are rendered by us from the
 * vault's own record. A plugin cannot dress this up as a different plugin, and
 * cannot widen the allowlist after the fact - what is shown here is exactly
 * what gets stored.
 */
import { computed, nextTick, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { confirmPrompts, secretPrompts } from '@/core/ui/prompt'
import { storeSecret } from '@/core/capabilities/vault'
import { pushToast } from '@/core/ui/toast'

/* ------------------------------- secrets -------------------------------- */

const secret = computed(() => secretPrompts[0] ?? null)
const value = ref('')
const reveal = ref(false)
const saving = ref(false)
const field = ref<InstanceType<typeof Input> | null>(null)

watch(secret, async (prompt) => {
  value.value = ''
  reveal.value = false
  if (!prompt) return
  await nextTick()
  // Focus the field, not the confirm button: the user came here to type.
  ;(document.getElementById('omni-secret-value') as HTMLInputElement | null)?.focus()
})

async function saveSecret() {
  const prompt = secret.value
  if (!prompt || !value.value) return
  saving.value = true
  try {
    await storeSecret(
      {
        pluginId: prompt.pluginId,
        name: prompt.name,
        label: prompt.label,
        allowOrigins: prompt.allowOrigins,
      },
      value.value,
    )
    value.value = ''
    prompt.resolve(true)
    pushToast({ level: 'success', message: `凭据「${prompt.name}」已加密保存` })
  } catch (error) {
    pushToast({ level: 'error', title: '保存失败', message: error instanceof Error ? error.message : String(error) })
  } finally {
    saving.value = false
  }
}

function dismissSecret() {
  value.value = ''
  secret.value?.resolve(false)
}

/* ------------------------------- confirms ------------------------------- */

const confirm = computed(() => confirmPrompts[0] ?? null)
</script>

<template>
  <!-- Credential entry -->
  <Dialog :open="!!secret" @update:open="!$event && dismissSecret()">
    <DialogContent v-if="secret" class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Icon name="key" :size="16" />
          {{ secret.replacing ? '更新凭据' : '录入凭据' }}
        </DialogTitle>
        <DialogDescription>
          插件「{{ secret.pluginName }}」请求保存一项凭据。保存后它<strong>无法读回明文</strong>，
          只能在向下列域名发起请求时由宿主代为填入。
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="rounded-lg border border-border bg-muted/40 p-3">
          <p class="text-xs font-medium">{{ secret.label }}</p>
          <p v-if="secret.hint" class="mt-1 text-[11px] leading-relaxed text-muted-foreground">{{ secret.hint }}</p>
          <p class="mt-2 font-mono text-[10px] text-muted-foreground">{{ secret.pluginId }} / {{ secret.name }}</p>
        </div>

        <div>
          <Label class="text-xs">允许发送到</Label>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            <Badge v-for="origin in secret.allowOrigins" :key="origin" variant="outline" class="font-mono">
              {{ origin }}
            </Badge>
          </div>
          <p class="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            发往其他任何地址的请求都会被拒绝，即使插件已获得网络权限。
          </p>
        </div>

        <div>
          <Label for="omni-secret-value" class="text-xs">凭据值</Label>
          <div class="mt-1.5 flex gap-2">
            <Input
              id="omni-secret-value"
              ref="field"
              v-model="value"
              :type="reveal ? 'text' : 'password'"
              autocomplete="off"
              spellcheck="false"
              placeholder="粘贴或输入…"
              class="font-mono"
              @keydown.enter="saveSecret"
            />
            <Button variant="outline" size="icon" :title="reveal ? '隐藏' : '显示'" @click="reveal = !reveal">
              <Icon :name="reveal ? 'eye' : 'lock'" :size="15" />
            </Button>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="dismissSecret">取消</Button>
        <Button size="sm" :disabled="!value || saving" @click="saveSecret">
          <Icon :name="saving ? 'loader' : 'shield-check'" :size="14" :class="saving ? 'animate-spin' : ''" />
          加密保存
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Generic confirmation (model downloads, etc.) -->
  <Dialog :open="!!confirm" @update:open="!$event && confirm?.resolve(false)">
    <DialogContent v-if="confirm" class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ confirm.title }}</DialogTitle>
        <DialogDescription>{{ confirm.message }}</DialogDescription>
      </DialogHeader>

      <pre
        v-if="confirm.detail"
        class="max-h-48 overflow-auto scroll-slim whitespace-pre-wrap rounded-lg bg-muted p-3 text-[11px] leading-relaxed"
      >{{ confirm.detail }}</pre>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="confirm.resolve(false)">取消</Button>
        <Button
          size="sm"
          :variant="confirm.tone === 'destructive' ? 'destructive' : 'default'"
          @click="confirm.resolve(true)"
        >
          {{ confirm.confirmLabel }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
