import { DurableObject } from 'cloudflare:workers'
import type { Account, Directory, EventRecord, PackageRecord, Room, Space } from '../src/types'

interface Env { SILLAGE: DurableObjectNamespace<Sillage> }
const encoder = new TextEncoder()
const maxAttachment = 1000 * 1024
const cookie = '__Host-sillage'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const username = /^[a-z0-9][a-z0-9_-]{2,30}$/
const base64 = /^[a-zA-Z0-9+/]+={0,2}$/
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } })

class RequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}
function text(value: unknown, max: number, format?: RegExp): string {
  if (typeof value !== 'string' || !value.length || value.length > max || (format && !format.test(value))) throw new RequestError('Valeur invalide.')
  return value
}
function id(value: unknown) { return text(value, 36, uuid) }
async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('')
}
function equal(a: string, b: string) {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
function setCookie(value: string, age: number) {
  return cookie + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + age
}
function sessionCookie(req: Request) {
  return req.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-sillage=([a-f0-9-]{36})(?:;|$)/)?.[1] || ''
}
async function limitedBytes(req: Request, max: number) {
  if (!req.body) throw new RequestError('Requête vide.')
  const reader = req.body.getReader()
  const parts: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { await reader.cancel(); throw new RequestError('Taille maximale dépassée.', 413) }
    parts.push(new Uint8Array(value))
  }
  return new Blob(parts).arrayBuffer()
}

export default {
  fetch(req: Request, env: Env) {
    return env.SILLAGE.getByName('service').fetch(req)
  },
} satisfies ExportedHandler<Env>

export class Sillage extends DurableObject<Env> {
  private get sql() { return this.ctx.storage.sql }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, identity TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user TEXT NOT NULL, expiry INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, expires INTEGER NOT NULL, hits INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS packages (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS packages_owner ON packages(owner);
      CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS space_members (space TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY(space,user));
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, space TEXT, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (room TEXT NOT NULL, user TEXT NOT NULL, joined INTEGER NOT NULL, welcome TEXT, packageId TEXT, PRIMARY KEY(room,user));
      CREATE INDEX IF NOT EXISTS members_user ON members(user);
      CREATE TABLE IF NOT EXISTS events (room TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, sender TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(room,seq), UNIQUE(room,id));
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, room TEXT NOT NULL, owner TEXT NOT NULL, data BLOB NOT NULL);
    `)
  }
  private limit(bucket: string, quota: number) {
    const now = Date.now()
    const hit = this.sql.exec<{ hits: number }>(`INSERT INTO limits VALUES(?,?,1)
      ON CONFLICT(bucket) DO UPDATE SET
        hits=CASE WHEN expires<=? THEN 1 ELSE hits+1 END,
        expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING hits`,
      bucket, now + 15 * 60_000, now, now).one()
    if (hit.hits > quota) throw new RequestError('Trop de tentatives. Réessaie dans quelques minutes.', 429)
  }
  private member(room: string, user: string) {
    const row = this.sql.exec<{ joined: number }>('SELECT joined FROM members WHERE room=? AND user=?', room, user).toArray()[0]
    if (!row) throw new RequestError('Salon inaccessible.', 403)
    return row
  }
  private notify(users: string[]) {
    for (const user of new Set(users)) {
      for (const socket of this.ctx.getWebSockets(user)) {
        try { socket.send('sync') } catch { /* disconnected */ }
      }
    }
  }
  private users(room: string) {
    return this.sql.exec<{ user: string }>('SELECT user FROM members WHERE room=?', room).toArray().map(row => row.user)
  }
  private packages(user: string, input: unknown) {
    if (!Array.isArray(input) || input.length > 8) throw new RequestError('Clés publiques invalides.')
    this.sql.exec('DELETE FROM packages WHERE owner=? AND expires<=?', user, Date.now())
    const count = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM packages WHERE owner=?', user).one().n
    if (count + input.length > 16) throw new RequestError('Trop de clés en attente.')
    for (const item of input) {
      if (!item || typeof item !== 'object') throw new RequestError('Clé publique invalide.')
      this.sql.exec('INSERT INTO packages VALUES(?,?,?,?)', id(item.id), user, text(item.data, 10000, base64), Date.now() + 6 * 86400_000)
    }
  }

  async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method
      if ((method !== 'GET' || path === '/api/live') && req.headers.get('Origin') !== url.origin) throw new RequestError('Origine invalide.', 403)
      const readJson = async () => {
        if (req.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new RequestError('Format attendu : JSON.', 415)
        try {
          const obj = JSON.parse(new TextDecoder().decode(await limitedBytes(req, 128 * 1024)))
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error()
          return obj as Record<string, unknown>
        } catch (err) {
          if (err instanceof RequestError) throw err
          throw new RequestError('Requête JSON invalide.')
        }
      }
      if (method === 'POST' && (path === '/api/login' || path === '/api/signup')) {
        const form = await readJson()
        const user = text(form.user, 31, username)
        const proof = text(form.proof, 44, /^[A-Za-z0-9+/]{43}=$/)
        const ip = req.headers.get('CF-Connecting-IP') || 'local'
        this.limit('ip:' + ip, 80)
        this.limit('account:' + user, 15)
        const existing = this.sql.exec<Account & { salt: string; hash: string }>('SELECT * FROM accounts WHERE id=?', user).toArray()[0]
        let account: Account
        if (path === '/api/signup') {
          this.limit('register:' + ip, 8)
          if (existing) throw new RequestError('Ce pseudo est déjà utilisé.', 409)
          const salt = crypto.randomUUID()
          const hash = await digest(salt + ':' + proof)
          account = { id: user, name: user, identity: text(form.identity, 128, base64) }
          this.ctx.storage.transactionSync(() => {
            if (this.sql.exec('SELECT id FROM accounts WHERE id=?', user).toArray().length) throw new RequestError('Ce pseudo est déjà utilisé.', 409)
            if (this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM accounts').one().n >= 500) throw new RequestError('Ce déploiement a atteint sa limite de 500 comptes.', 409)
            this.sql.exec('INSERT INTO accounts VALUES(?,?,?,?,?)', account.id, account.name, account.identity, salt, hash)
            this.packages(user, form.packages)
          })
        } else {
          const hash = await digest((existing?.salt || 'invalid') + ':' + proof)
          if (!existing || !equal(existing.hash, hash)) throw new RequestError('Pseudo ou mot de passe incorrect.', 401)
          account = { id: existing.id, name: existing.name, identity: existing.identity }
        }
        const token = crypto.randomUUID()
        const maxAge = 86400 * 7
        const hash = await digest(token)
        this.sql.exec('DELETE FROM sessions WHERE expiry<=?', Date.now())
        this.sql.exec('DELETE FROM limits WHERE expires<=?', Date.now())
        this.sql.exec('INSERT INTO sessions VALUES(?,?,?)', hash, user, Date.now() + maxAge * 1000)
        return json(account, 200, { 'Set-Cookie': setCookie(token, maxAge) })
      }
      const token = sessionCookie(req)
      const tokenHash = token ? await digest(token) : ''
      const me = this.sql.exec<Account>('SELECT id,name,identity FROM accounts JOIN sessions ON id=user WHERE token=? AND expiry>?', tokenHash, Date.now()).toArray()[0]
      if (!me) throw new RequestError('Connecte-toi pour continuer.', 401)
      if (path === '/api/session' && method === 'GET') return json(me)
      if (path === '/api/logout' && method === 'POST') {
        this.sql.exec('DELETE FROM sessions WHERE token=?', tokenHash)
        for (const socket of this.ctx.getWebSockets(me.id)) if (socket.deserializeAttachment() === tokenHash) socket.close(1000, 'Déconnexion')
        return json(true, 200, { 'Set-Cookie': setCookie('', 0) })
      }
      if (path === '/api/live' && method === 'GET' && req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        if (this.ctx.getWebSockets(me.id).length >= 8) throw new RequestError('Trop de connexions simultanées.', 429)
        const pair = new WebSocketPair()
        this.ctx.acceptWebSocket(pair[1], [me.id])
        pair[1].serializeAttachment(tokenHash)
        return new Response(null, { status: 101, webSocket: pair[0] })
      }
      if (path === '/api/directory' && method === 'GET') {
        const value: Directory = {
          accounts: this.sql.exec<Account>('SELECT id,name,identity FROM accounts ORDER BY id LIMIT 500').toArray(),
          spaces: this.sql.exec<Space>('SELECT id,name,owner FROM spaces JOIN space_members ON id=space WHERE user=? ORDER BY name', me.id).toArray(),
          rooms: this.sql.exec<Room>('SELECT id,name,kind,space,owner,joined,welcome,packageId,(SELECT count(*) FROM members AS others WHERE others.room=rooms.id) AS members FROM rooms JOIN members ON id=room WHERE user=? ORDER BY name', me.id).toArray(),
          packages: this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM packages WHERE owner=? AND expires>?', me.id, Date.now()).one().n,
        }
        return json(value)
      }
      if (path === '/api/profile' && method === 'POST') {
        const name = text((await readJson()).name, 64).trim()
        if (!name) throw new RequestError('Saisis un nom.')
        this.sql.exec('UPDATE accounts SET name=? WHERE id=?', name, me.id)
        this.notify([me.id])
        return json(true)
      }
      if (path === '/api/packages' && method === 'POST') {
        const { packages } = await readJson()
        this.ctx.storage.transactionSync(() => this.packages(me.id, packages))
        return json(true)
      }
      if (path.startsWith('/api/packages/') && method === 'GET') {
        const user = text(path.split('/')[3], 31, username)
        const pkg = this.sql.exec<PackageRecord>('SELECT id,data FROM packages WHERE owner=? AND expires>? LIMIT 1', user, Date.now()).toArray()[0]
        if (!pkg) throw new RequestError('Cette personne doit ouvrir Sillage pour publier de nouvelles clés.', 409)
        return json(pkg)
      }
      if (path === '/api/spaces' && method === 'POST') {
        const { name } = await readJson()
        const space = { id: crypto.randomUUID(), name: text(name, 64), owner: me.id }
        this.ctx.storage.transactionSync(() => {
          this.sql.exec('INSERT INTO spaces VALUES(?,?,?)', space.id, space.name, me.id)
          this.sql.exec('INSERT INTO space_members VALUES(?,?)', space.id, me.id)
        })
        this.notify([me.id])
        return json(space)
      }
      if (path === '/api/rooms' && method === 'POST') {
        const form = await readJson()
        const room = id(form.id)
        const name = text(form.name, 64)
        const kind = text(form.kind, 7, /^(channel|direct)$/)
        const space = form.space == null ? null : id(form.space)
        if ((space && kind === 'direct') || (space && !this.sql.exec('SELECT 1 FROM space_members WHERE space=? AND user=?', space, me.id).toArray().length)) throw new RequestError('Communauté inaccessible.', 403)
        this.ctx.storage.transactionSync(() => {
          const prior = this.sql.exec<{ owner: string }>('SELECT owner FROM rooms WHERE id=?', room).toArray()[0]
          if (prior?.owner === me.id) return
          if (prior) throw new RequestError('Ce salon existe déjà.', 409)
          this.sql.exec('INSERT INTO rooms VALUES(?,?,?,?,?)', room, name, kind, space, me.id)
          this.sql.exec('INSERT INTO members VALUES(?,?,0,NULL,NULL)', room, me.id)
        })
        this.notify([me.id])
        return json(room)
      }
      const route = path.match(/^\/api\/rooms\/([^/]+)\/(events|invite|files)(?:\/([^/]+))?$/)
      if (route) {
        const room = id(route[1])
        const membership = this.member(room, me.id)
        if (route[2] === 'events' && method === 'GET') {
          const after = Number(url.searchParams.get('after') || 0)
          if (!Number.isSafeInteger(after) || after < 0) throw new RequestError('Position invalide.')
          return json(this.sql.exec<EventRecord>('SELECT id,seq,sender,at,data FROM events WHERE room=? AND seq>? ORDER BY seq LIMIT 100', room, Math.max(after, membership.joined)).toArray())
        }
        if (route[2] === 'events' && method === 'POST') {
          const form = await readJson()
          const sequence = this.append(room, me.id, form)
          this.notify(this.users(room))
          return json(sequence)
        }
        if (route[2] === 'invite' && method === 'POST') {
          const form = await readJson()
          const target = text(form.user, 31, username)
          const pack = id(form.packageId)
          const welcome = text(form.welcome, 50000, base64)
          const info = this.sql.exec<Room>('SELECT owner,kind,space FROM rooms WHERE id=?', room).one()
          if (info.owner !== me.id) throw new RequestError('Seul le créateur peut inviter.', 403)
          const result = this.ctx.storage.transactionSync(() => {
            const prior = this.sql.exec<EventRecord>('SELECT id,seq,sender,at,data FROM events WHERE room=? AND id=?', room, id(form.id)).toArray()[0]
            if (prior?.sender === me.id) return prior
            if (this.users(room).includes(target)) throw new RequestError('Cette personne est déjà dans le salon.', 409)
            if (info.kind === 'direct' && this.users(room).length !== 1) throw new RequestError('Cette conversation a déjà deux membres.', 409)
            if (this.users(room).length >= 24) throw new RequestError('Le salon a atteint 24 membres.', 409)
            if (!this.sql.exec('SELECT 1 FROM packages WHERE id=? AND owner=? AND expires>?', pack, target, Date.now()).toArray().length) throw new RequestError('Cette clé a déjà été utilisée. Réessaie.', 409)
            const event = this.append(room, me.id, form)
            this.sql.exec('DELETE FROM packages WHERE id=?', pack)
            this.sql.exec('INSERT INTO members VALUES(?,?,?,?,?)', room, target, event.seq, welcome, pack)
            if (info.space) this.sql.exec('INSERT OR IGNORE INTO space_members VALUES(?,?)', info.space, target)
            return event
          })
          this.notify(this.users(room))
          return json(result)
        }
        if (route[2] === 'files' && route[3]) {
          const fileId = id(route[3])
          if (method === 'PUT') {
            this.limit('upload:' + me.id, 20)
            const buffer = await limitedBytes(req, maxAttachment + 16)
            if (buffer.byteLength < 16) throw new RequestError('Pièce jointe invalide.')
            const total = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM files WHERE owner=?', me.id).one().n
            if (total >= 100) throw new RequestError('Quota de fichiers atteint.', 413)
            this.sql.exec('INSERT OR IGNORE INTO files VALUES(?,?,?,?)', fileId, room, me.id, buffer)
            return json(true)
          }
          if (method === 'GET') {
            const file = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM files WHERE id=? AND room=?', fileId, room).toArray()[0]
            if (!file) throw new RequestError('Fichier indisponible.', 404)
            return new Response(file.data, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
          }
        }
      }
      throw new RequestError('Page inconnue.', 404)
    } catch (error) {
      if (error instanceof RequestError) return json({ error: error.message }, error.status)
      console.error('Sillage: internal request failure', error instanceof Error ? error.name : '')
      return json({ error: 'Le service est temporairement indisponible.' }, 500)
    }
  }

  private append(room: string, sender: string, form: Record<string, unknown>): EventRecord {
    const eventId = id(form.id)
    const data = text(form.data, 50000, base64)
    const prior = this.sql.exec<EventRecord>('SELECT id,seq,sender,at,data FROM events WHERE room=? AND id=?', room, eventId).toArray()[0]
    if (prior) {
      if (prior.sender !== sender || prior.data !== data) throw new RequestError('Événement en conflit.', 409)
      return prior
    }
    const latest = this.sql.exec<{ seq: number }>('SELECT coalesce(max(seq),0) AS seq FROM events WHERE room=?', room).one().seq
    if (form.after !== latest) throw new RequestError('Le salon a été mis à jour. Réessaie.', 409)
    const event = { id: eventId, sender, data, seq: latest + 1, at: Date.now() }
    this.sql.exec('INSERT INTO events VALUES(?,?,?,?,?,?)', room, event.seq, event.id, sender, event.at, data)
    return event
  }
}
