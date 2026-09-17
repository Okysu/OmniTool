const ALPHABET = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict'

/** Collision-resistant, URL-safe id backed by the CSPRNG. */
export function nanoid(size = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  let out = ''
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i] & 61]
  return out
}
