import {
  createApplicationMessage, createCommit, createGroup, decodeGroupState,
  decodeMlsMessage, defaultCapabilities, emptyPskIndex, encodeGroupState, encodeMlsMessage,
  generateKeyPackageWithKey, getCiphersuiteImpl, getCiphersuiteFromName, joinGroup, processMessage,
  zeroOutUint8Array, type ClientState, type GroupState, type KeyPackage, type PrivateKeyPackage,
} from 'ts-mls'
import { defaultClientConfig } from 'ts-mls/clientConfig.js'
import { verifyKeyPackage } from 'ts-mls/keyPackage.js'
import { getGroupMembers } from 'ts-mls/clientState.js'
import { ApiError, post, request } from './api'
import { lock, readLocal, writeLocal } from './storage'
import type { Account, EventRecord, Message, PackageRecord, Payload, Room } from './types'

export const maxAttachment = 1000 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const suite = () => getCiphersuiteImpl(getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'))
type Package = { id: string; publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }
type Identity = { publicKey: Uint8Array; signKey: Uint8Array; packages: Package[]; pins: Record<string, string> }
type Pending = {
  kind: 'events' | 'invite'
  id: string; after: number; data: string
  state: Uint8Array
  payload?: Payload
  target?: { user: string; packageId: string; welcome: string }
}
type LocalRoom = {
  state: Uint8Array
  seq: number
  messages: Message[]
  pending?: Pending
}
type PayloadInput = Omit<Extract<Payload, { kind: 'text' }>, 'from'> | Omit<Extract<Payload, { kind: 'file' }>, 'from'>

export function b64(bytes: Uint8Array) {
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
  return btoa(parts.join(''))
}
function unb64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), char => char.charCodeAt(0)) }

async function passwordProof(user: string, password: string) {
  const secret = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const salt = encoder.encode('Sillage login v1:' + location.origin + ':' + user)
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt }, secret, 256)
  return b64(new Uint8Array(bits))
}

async function makePackage(user: string, identity: Identity): Promise<Package> {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const keys = await generateKeyPackageWithKey(
    { credentialType: 'basic', identity: encoder.encode(user) },
    defaultCapabilities(), { notBefore: now - 300n, notAfter: now + 7n * 86400n }, [],
    identity, await suite(),
  )
  return { id: crypto.randomUUID(), ...keys }
}
function publicPackage(pack: Package): PackageRecord {
  return { id: pack.id, data: b64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_key_package', keyPackage: pack.publicPackage })) }
}
function decodeWire(data: string) {
  const bytes = unb64(data)
  const decoded = decodeMlsMessage(bytes, 0)
  if (!decoded || decoded[1] !== bytes.length) throw new Error('Événement MLS invalide.')
  return decoded[0]
}

export async function authenticate(user: string, password: string, register: boolean) {
  return lock(user, async () => {
    const proof = await passwordProof(user, password)
    if (!register) {
      const account = await post<Account>('login', { user, proof })
      try { await loadIdentity(account) } catch (error) {
        await post('logout', {}).catch(() => {})
        throw error
      }
      return account
    }
    let identity = await readLocal<Identity>('identity:' + user)
    if (!identity) {
      const cs = await suite()
      identity = { ...await cs.signature.keygen(), packages: [], pins: {} }
      identity.packages = await Promise.all(Array.from({ length: 8 }, () => makePackage(user, identity!)))
      await writeLocal('identity:' + user, identity)
    }
    return post<Account>('signup', { user, proof, identity: b64(identity.publicKey), packages: identity.packages.slice(-8).map(publicPackage) })
  })
}

export async function loadIdentity(account: Account) {
  const identity = await readLocal<Identity>('identity:' + account.id)
  if (!identity || b64(identity.publicKey) !== account.identity) {
    throw new Error('Les clés de ce compte se trouvent dans son navigateur d’origine. Ouvre Sillage dans ce navigateur.')
  }
  return identity
}

export async function replenish(account: Account, current: number) {
  if (current >= 3) return
  await lock(account.id, async () => {
    const count = (await request<{ packages: number }>('directory')).packages
    if (count >= 3) return
    const identity = await loadIdentity(account)
    const next = await Promise.all(Array.from({ length: 8 }, () => makePackage(account.id, identity)))
    // Keep expired packages: a member can first open a previously delivered Welcome much later.
    identity.packages = [...identity.packages, ...next]
    await writeLocal('identity:' + account.id, identity)
    await post('packages', { packages: next.map(publicPackage) })
  })
}

async function config(account: Account, identity: Identity, directory: Account[]) {
  for (const contact of directory) {
    if (Object.hasOwn(identity.pins, contact.id)) continue
    Object.defineProperty(identity.pins, contact.id, { value: contact.identity, enumerable: true, writable: true, configurable: true })
  }
  await writeLocal('identity:' + account.id, identity)
  return {
    ...defaultClientConfig,
    authService: {
      async validateCredential(credential: { credentialType: string; identity?: Uint8Array }, publicKey: Uint8Array) {
        if (credential.credentialType !== 'basic' || !credential.identity) return false
        const user = decoder.decode(credential.identity)
        if (user === account.id) return b64(identity.publicKey) === b64(publicKey)
        return Object.hasOwn(identity.pins, user) && identity.pins[user] === b64(publicKey)
      },
    },
  }
}

function deserialize(record: LocalRoom, clientConfig: ClientState['clientConfig']): ClientState {
  const result = decodeGroupState(record.state, 0)
  if (!result || result[1] !== record.state.length) throw new Error('État chiffré local illisible.')
  return { ...result[0], clientConfig }
}
function checkGroup(state: GroupState, room: string) {
  if (decoder.decode(state.groupContext.groupId) !== room) throw new Error('Le groupe ne correspond pas à ce salon.')
}
function keyFor(account: Account, room: string) { return 'room:' + account.id + ':' + room }
function routes(room: string, endpoint: string) { return 'rooms/' + room + '/' + endpoint }

export async function createRoom(account: Account, name: string, kind: Room['kind'], space: string | null, directory: Account[]) {
  return lock(account.id, async () => {
    const identity = await loadIdentity(account)
    const id = crypto.randomUUID()
    const keys = await makePackage(account.id, identity)
    const state = await createGroup(encoder.encode(id), keys.publicPackage, keys.privatePackage, [], await suite(), await config(account, identity, directory))
    await writeLocal<LocalRoom>(keyFor(account, id), { state: encodeGroupState(state), seq: 0, messages: [] })
    await post('rooms', { id, name, kind, space })
    return { id, name, kind, space, owner: account.id, members: 1, joined: 0, welcome: null, packageId: null } satisfies Room
  })
}

async function loadRoom(account: Account, room: Room, identity: Identity, clientConfig: ClientState['clientConfig']) {
  const key = keyFor(account, room.id)
  const existing = await readLocal<LocalRoom>(key)
  if (existing) return existing
  const pack = identity.packages.find(p => p.id === room.packageId)
  if (!pack || !room.welcome) throw new Error('La clé de ce salon est indisponible dans ce navigateur.')
  const wire = decodeWire(room.welcome)
  if (wire.wireformat !== 'mls_welcome') throw new Error('Invitation chiffrée invalide.')
  const state = await joinGroup(wire.welcome, pack.publicPackage, pack.privatePackage, emptyPskIndex, await suite(), undefined, undefined, clientConfig)
  checkGroup(state, room.id)
  if (!getGroupMembers(state).some(member => member.credential.credentialType === 'basic' &&
      decoder.decode(member.credential.identity) === room.owner)) {
    throw new Error('L’identité du créateur manque dans cette invitation.')
  }
  const record = { state: encodeGroupState(state), seq: room.joined, messages: [] }
  await writeLocal(key, record)
  const stored = (await readLocal<Identity>('identity:' + account.id))!
  stored.packages = stored.packages.filter(p => p.id !== pack.id)
  await writeLocal('identity:' + account.id, stored)
  return record
}

async function flush(account: Account, room: Room, record: LocalRoom): Promise<LocalRoom> {
  if (!record.pending) return record
  const pending = record.pending
  let next: LocalRoom
  try {
    const event = await post<EventRecord>(routes(room.id, pending.kind), {
      id: pending.id, after: pending.after, data: pending.data, ...pending.target,
    })
    if (event.seq !== record.seq + 1 || event.sender !== account.id || event.id !== pending.id || event.data !== pending.data) {
      throw new Error('Le serveur a retourné un accusé de réception incohérent.')
    }
    next = { state: pending.state, seq: event.seq, messages: pending.payload
      ? [...record.messages, { id: event.id, at: event.at, payload: pending.payload }].slice(-500) : record.messages }
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error
    const events = await request<EventRecord[]>(routes(room.id, 'events?after=' + record.seq))
    if (events.some(event => event.id === pending.id)) throw new Error('L’accusé de réception du message doit être resynchronisé.')
    next = { ...record, state: pending.kind === 'events' ? pending.state : record.state, pending: undefined }
    await writeLocal(keyFor(account, room.id), next)
    throw error
  }
  await writeLocal(keyFor(account, room.id), next)
  return next
}

function signedBytes(room: string, id: string, payload: string) {
  return encoder.encode(JSON.stringify(['sillage-message-v1', room, id, payload]))
}

async function applyEvents(account: Account, room: Room, record: LocalRoom, identity: Identity, clientConfig: ClientState['clientConfig']) {
  const cs = await suite()
  let state = deserialize(record, clientConfig)
  checkGroup(state, room.id)
  let seq = record.seq
  const messages = [...record.messages]
  for (let batch = 0; batch < 5; batch++) {
    const events = await request<EventRecord[]>(routes(room.id, 'events?after=' + seq))
    for (const event of events) {
      if (event.seq !== seq + 1) throw new Error('Il manque un événement dans le salon.')
      const wire = decodeWire(event.data)
      if (wire.wireformat !== 'mls_private_message' && wire.wireformat !== 'mls_public_message') throw new Error('Événement MLS inattendu.')
      const result = await processMessage(wire, state, emptyPskIndex, incoming => {
        if (incoming.kind !== 'commit' || incoming.senderLeafIndex === undefined) return 'reject'
        const sender = state.ratchetTree[incoming.senderLeafIndex * 2]
        const credential = sender?.nodeType === 'leaf' ? sender.leaf.credential : undefined
        return credential?.credentialType === 'basic' && decoder.decode(credential.identity) === room.owner
          ? 'accept' : 'reject'
      }, cs)
      if (result.kind === 'applicationMessage') {
        if (wire.wireformat !== 'mls_private_message') throw new Error('Message non chiffré refusé.')
        const signed = JSON.parse(decoder.decode(result.message)) as { payload: string; signature: string }
        const payload = JSON.parse(signed.payload) as Payload
        const publicKey = payload.from === account.id ? b64(identity.publicKey) :
          Object.hasOwn(identity.pins, payload.from) ? identity.pins[payload.from] : ''
        if (!publicKey || payload.from !== event.sender || !await cs.signature.verify(unb64(publicKey), signedBytes(room.id, event.id, signed.payload), unb64(signed.signature))) {
          throw new Error('La signature du message est invalide.')
        }
        const senderInGroup = getGroupMembers(state).some(member =>
          member.credential.credentialType === 'basic' && decoder.decode(member.credential.identity) === payload.from &&
          b64(member.signaturePublicKey) === publicKey)
        if (!senderInGroup) throw new Error('L’expéditeur ne fait pas partie du groupe chiffré.')
        messages.push({ id: event.id, at: event.at, payload })
      } else if (result.actionTaken !== 'accept' || result.newState.groupActiveState.kind !== 'active') {
        throw new Error('La mise à jour du groupe a été refusée.')
      }
      state = result.newState
      for (const bytes of result.consumed) zeroOutUint8Array(bytes)
      seq = event.seq
    }
    if (events.length) await writeLocal<LocalRoom>(keyFor(account, room.id), { state: encodeGroupState(state), seq, messages: messages.slice(-500) })
    if (events.length < 100) break
  }
  return { state: encodeGroupState(state), seq, messages: messages.slice(-500) }
}

async function withRoom<T>(account: Account, room: Room, directory: Account[], action: (record: LocalRoom, identity: Identity, state: ClientState) => Promise<T>) {
  return lock(account.id, async () => {
    const identity = await loadIdentity(account)
    const clientConfig = await config(account, identity, directory)
    let record = await loadRoom(account, room, identity, clientConfig)
    record = await flush(account, room, record)
    record = await applyEvents(account, room, record, identity, clientConfig)
    return action(record, identity, deserialize(record, clientConfig))
  })
}

export function readMessages(account: Account, room: Room, directory: Account[]) {
  return withRoom(account, room, directory, async record => record.messages)
}

export function addMember(account: Account, room: Room, target: Account, directory: Account[]) {
  return withRoom(account, room, directory, async (record, identity, state) => {
    if (room.owner !== account.id) throw new Error('Seul le créateur du salon peut inviter.')
    const pinned = Object.hasOwn(identity.pins, target.id) ? identity.pins[target.id] : ''
    if (pinned !== target.identity) throw new Error('La clé connue de cette personne a changé.')
    const pack = await request<PackageRecord>('packages/' + target.id)
    const wire = decodeWire(pack.data)
    const cs = await suite()
    if (wire.wireformat !== 'mls_key_package' || wire.keyPackage.leafNode.credential.credentialType !== 'basic' ||
        decoder.decode(wire.keyPackage.leafNode.credential.identity) !== target.id ||
        b64(wire.keyPackage.leafNode.signaturePublicKey) !== pinned ||
        !await verifyKeyPackage(wire.keyPackage, cs.signature)) throw new Error('La clé publique reçue est invalide.')
    const result = await createCommit({ state, cipherSuite: cs }, {
      extraProposals: [{ proposalType: 'add', add: { keyPackage: wire.keyPackage } }],
      ratchetTreeExtension: true, wireAsPublicMessage: true,
    })
    if (!result.welcome || result.commit.wireformat !== 'mls_public_message') throw new Error('Impossible de préparer l’invitation MLS.')
    const pending: Pending = {
      kind: 'invite', id: crypto.randomUUID(), after: record.seq,
      data: b64(encodeMlsMessage(result.commit)), state: encodeGroupState(result.newState),
      target: { user: target.id, packageId: pack.id, welcome: b64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome: result.welcome })) },
    }
    for (const bytes of result.consumed) zeroOutUint8Array(bytes)
    const next = { ...record, pending }
    await writeLocal(keyFor(account, room.id), next)
    await flush(account, room, next)
  })
}

export function sendMessage(account: Account, room: Room, body: PayloadInput, directory: Account[]) {
  return withRoom(account, room, directory, async (record, identity, state) => {
    const cs = await suite()
    const id = crypto.randomUUID()
    const payload = { ...body, from: account.id } satisfies Payload
    const encoded = JSON.stringify(payload)
    const signature = await cs.signature.sign(identity.signKey, signedBytes(room.id, id, encoded))
    const result = await createApplicationMessage(state, encoder.encode(JSON.stringify({ payload: encoded, signature: b64(signature) })), cs)
    const next: LocalRoom = { ...record, pending: {
      kind: 'events', id, after: record.seq, payload,
      data: b64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_private_message', privateMessage: result.privateMessage })),
      state: encodeGroupState(result.newState),
    } }
    for (const bytes of result.consumed) zeroOutUint8Array(bytes)
    await writeLocal(keyFor(account, room.id), next)
    return (await flush(account, room, next)).messages
  })
}

export async function uploadFile(account: Account, room: Room, file: File, directory: Account[]) {
  if (file.size > maxAttachment) throw new Error('Taille maximale : 1 000 Kio.')
  const id = crypto.randomUUID()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = crypto.getRandomValues(new Uint8Array(32))
  const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(room.id + ':' + id) }, aes, await file.arrayBuffer())
  const res = await fetch('/api/' + routes(room.id, 'files/' + id), { method: 'PUT', body: ciphertext, redirect: 'error' })
  if (!res.ok) throw new Error((await res.json<{ error?: string }>().catch(() => ({} as { error?: string }))).error || 'Téléversement impossible.')
  const encodedKey = b64(key)
  key.fill(0)
  return sendMessage(account, room, { kind: 'file', name: file.name, id, key: encodedKey, iv: b64(iv), size: file.size }, directory)
}

export async function downloadFile(room: Room, file: Extract<Payload, { kind: 'file' }>) {
  if (!/^[a-f0-9-]{36}$/.test(file.id) || file.size < 0 || file.size > maxAttachment) throw new Error('Pièce jointe invalide.')
  const res = await fetch('/api/' + routes(room.id, 'files/' + file.id), { cache: 'no-store', redirect: 'error' })
  if (!res.ok) throw new Error('Fichier indisponible.')
  const key = await crypto.subtle.importKey('raw', unb64(file.key), 'AES-GCM', false, ['decrypt'])
  const cipher = await res.arrayBuffer()
  if (cipher.byteLength !== file.size + 16) throw new Error('Taille de la pièce jointe invalide.')
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv), additionalData: encoder.encode(room.id + ':' + file.id) }, key, cipher)
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = file.name || 'fichier'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
