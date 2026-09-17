import { toast as sonner } from 'vue-sonner'

export type ToastLevel = 'info' | 'success' | 'warn' | 'error'

export interface ToastInput {
  message: string
  title?: string
  level?: ToastLevel
  /** Auto-dismiss delay in ms; 0 keeps it until dismissed. */
  timeout?: number
  /** Reusing an id replaces that toast in place instead of stacking a new one. */
  id?: string
}

/**
 * Publishes a toast.
 *
 * Kept as a plain function rather than calling `sonner` directly at call sites:
 * the `ui.notify` capability routes plugin-authored strings through here, and
 * this is where they are forced into a description slot that renders as text.
 */
export function pushToast(input: ToastInput): string | number {
  const level = input.level ?? 'info'
  const duration = input.timeout === 0 ? Number.POSITIVE_INFINITY : (input.timeout ?? (level === 'error' ? 8000 : 4000))

  // With a title present, sonner renders `message` as the description - which is
  // exactly the containment we want for untrusted plugin text.
  const options = input.title ? { description: input.message, duration, id: input.id } : { duration, id: input.id }
  const headline = input.title ?? input.message

  switch (level) {
    case 'success':
      return sonner.success(headline, options)
    case 'warn':
      return sonner.warning(headline, options)
    case 'error':
      return sonner.error(headline, options)
    default:
      return sonner(headline, options)
  }
}

export function dismissToast(id?: string | number): void {
  sonner.dismiss(id)
}
