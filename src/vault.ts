import { ApiError, post, requestRaw } from './api'
import { forgetLocal, lock, readLocal, writeLocal } from './storage'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
export const maxVaultRecord = 4 * 1024 * 1024
const keyName = (user: string) => 'vault-key:' + user

export async function deriveVaultKey(user: string, password: string) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  const salt = encoder.encode('Sillage encrypted vault v1:' + location.origin + ':' + user)
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export function keepVaultKey(user: string, key: CryptoKey) { return writeLocal(keyName(user), key) }
export function forgetVaultKey(user: string) { return forgetLocal(keyName(user)) }

function toBase64(bytes: Uint8Array) {
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
  return btoa(parts.join(''))
}
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}

export class Vault {
  readonly headers: Record<string, string>
  constructor(readonly user: string, private readonly key: CryptoKey, lease: string) {
    this.headers = { 'X-Sillage-Vault': lease }
  }

  private aad(name: string) { return encoder.encode(JSON.stringify(['sillage-vault-v1', this.user, name])) }

  async read<T>(name: string): Promise<T | undefined> {
    let res: Response
    try { res = await requestRaw('vault/records/' + name, { headers: this.headers }) }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined
      throw error
    }
    const data = new Uint8Array(await res.arrayBuffer())
    if (data.length < 29 || data.length > maxVaultRecord) throw new Error('Sauvegarde chiffrée invalide.')
    let clear: ArrayBuffer
    try {
      clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: this.aad(name) }, this.key, data.subarray(12))
    } catch { throw new Error('Impossible de déverrouiller la sauvegarde chiffrée de ce compte.') }
    return JSON.parse(decoder.decode(clear), (_key, value) => {
      if (value && typeof value === 'object') {
        if (typeof value.$bytes === 'string') return fromBase64(value.$bytes)
        if (typeof value.$bigint === 'string') return BigInt(value.$bigint)
      }
      return value
    }) as T
  }

  async write<T>(name: string, value: T) {
    const clear = encoder.encode(JSON.stringify(value, (_key, value) => {
      if (value instanceof Uint8Array) return { $bytes: toBase64(value) }
      if (typeof value === 'bigint') return { $bigint: value.toString() }
      return value
    }))
    if (clear.length + 28 > maxVaultRecord) throw new Error('Cette sauvegarde dépasse la taille prise en charge.')
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad(name) }, this.key, clear)
    clear.fill(0)
    const data = new Uint8Array(iv.length + encrypted.byteLength)
    data.set(iv)
    data.set(new Uint8Array(encrypted), iv.length)
    await requestRaw('vault/records/' + name, { method: 'PUT', headers: this.headers, body: data })
  }

  post<T>(path: string, body: unknown) { return post<T>(path, body, this.headers) }
}

// The server fences writes and MLS mutations with this lease. A crashed device
// releases it by expiry. The encrypted pending event is saved before it is sent.
export async function withVault<T>(user: string, action: (vault: Vault) => Promise<T>, unlockedKey?: CryptoKey) {
  const run = async () => {
    const key = unlockedKey || await readLocal<CryptoKey>(keyName(user))
    if (!key) throw new Error('Reconnecte-toi pour déverrouiller tes conversations.')
    let lease: string | undefined
    for (let attempt = 0; attempt < 20; attempt++) {
      try { lease = (await post<{ lease: string }>('vault/lease', {})).lease; break }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 423) throw error
        await new Promise(resolve => setTimeout(resolve, 350 + Math.random() * 150))
      }
    }
    if (!lease) throw new Error('Un autre appareil synchronise déjà ton compte. Réessaie dans quelques secondes.')
    const vault = new Vault(user, key, lease)
    try { return await action(vault) }
    finally { await vault.post('vault/release', {}).catch(() => {}) }
  }
  return unlockedKey ? run() : lock(user, run)
}
