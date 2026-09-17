/**
 * Host-drawn prompts that plugin code can trigger but never render.
 *
 * Two flows need the user in the loop mid-invocation:
 *   - entering a credential (`host.secret.request`)
 *   - approving a model download (`host.onnx.load` on an uncached model)
 *
 * Both must be drawn by the host: a plugin that could paint its own credential
 * field would simply read what the user typed. So the plugin supplies a label
 * and the host renders a dialog whose chrome - which plugin is asking, where the
 * value may be sent - is not under plugin control.
 */
import { shallowReactive } from 'vue'
import { nanoid } from '@/lib/id'

export interface SecretPrompt {
  id: string
  pluginId: string
  pluginName: string
  /** Storage key inside the plugin's namespace. */
  name: string
  /** Plugin-supplied description of what the credential is for. Rendered as text. */
  label: string
  hint?: string
  /** Origins the value will be allowed to reach. Approved as shown. */
  allowOrigins: string[]
  /** True when a value is already stored and this is a replacement. */
  replacing: boolean
  resolve: (accepted: boolean) => void
}

export interface ConfirmPrompt {
  id: string
  title: string
  message: string
  detail?: string
  confirmLabel: string
  tone: 'default' | 'destructive'
  resolve: (accepted: boolean) => void
}

export const secretPrompts = shallowReactive<SecretPrompt[]>([])
export const confirmPrompts = shallowReactive<ConfirmPrompt[]>([])

/** Resolves once the user saves a value or dismisses the dialog. */
export function promptForSecret(input: Omit<SecretPrompt, 'id' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    const id = nanoid(8)
    secretPrompts.push({
      ...input,
      id,
      resolve: (accepted) => {
        const index = secretPrompts.findIndex((p) => p.id === id)
        if (index !== -1) secretPrompts.splice(index, 1)
        resolve(accepted)
      },
    })
  })
}

export function promptForConfirmation(
  input: Omit<ConfirmPrompt, 'id' | 'resolve' | 'confirmLabel' | 'tone'> &
    Partial<Pick<ConfirmPrompt, 'confirmLabel' | 'tone'>>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const id = nanoid(8)
    confirmPrompts.push({
      confirmLabel: '继续',
      tone: 'default',
      ...input,
      id,
      resolve: (accepted) => {
        const index = confirmPrompts.findIndex((p) => p.id === id)
        if (index !== -1) confirmPrompts.splice(index, 1)
        resolve(accepted)
      },
    })
  })
}
