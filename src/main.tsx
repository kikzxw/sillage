import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { Command, Download, Hash, LockKeyhole, LogOut, Menu, MessageSquare, Paperclip, Plus, Send, Settings2, ShieldCheck, Users, X } from 'lucide-react'
import { ApiError, post, request } from './api'
import { addMember, createRoom, downloadFile, loadIdentity, readMessages, replenish, sendMessage, uploadFile } from './crypto'
import { AccountPage, Brand, Field, HeroArt, HomePage, accountPath, chatPath } from './pages'
import type { Account, Directory, Message, Room, Space } from './types'
import './style.css'

type Dialog = 'space' | 'room' | 'direct' | 'profile' | 'invite'
const dialogs: Record<Dialog, { title: string; label: string; action: string }> = {
  space: { title: 'Nouvelle communauté', label: 'Nom de la communauté', action: 'Créer' },
  room: { title: 'Nouveau salon chiffré', label: 'Nom du salon', action: 'Créer' },
  direct: { title: 'Nouveau message privé', label: 'Pseudo du destinataire', action: 'Ouvrir la conversation' },
  profile: { title: 'Mon profil', label: 'Nom d’affichage', action: 'Enregistrer' },
  invite: { title: 'Inviter dans ce salon', label: 'Pseudo du destinataire', action: 'Inviter' },
}
const emptyDirectory: Directory = { accounts: [], spaces: [], rooms: [], packages: 8 }

function currentRoute() {
  return { path: location.pathname.replace(/\/+$/, '') || '/', register: new URLSearchParams(location.search).get('mode') === 'inscription' }
}

function App() {
  const [route, setRoute] = useState(currentRoute)
  const [account, setAccount] = useState<Account | null>()
  const [notice, setNotice] = useState('')
  const navigate = useCallback((url: string, replace = false) => {
    if (location.pathname + location.search !== url) {
      if (replace) history.replaceState(null, '', url)
      else history.pushState(null, '', url)
    }
    setRoute(currentRoute())
    window.scrollTo(0, 0)
  }, [])

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute())
    window.addEventListener('popstate', onPopState)
    void request<Account>('session').then(async session => {
      await loadIdentity(session)
      setAccount(session)
    }).catch(error => {
      if (!(error instanceof ApiError && error.status === 401)) setNotice(error.message)
      setAccount(null)
    })
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (route.path === chatPath && account === null) navigate(accountPath, true)
    const title = route.path === chatPath ? 'Messagerie' : route.path === accountPath ? (route.register ? 'Inscription' : 'Connexion') : 'Messagerie chiffrée'
    document.title = title + ' · Sillage'
  }, [route, account, navigate])

  if (route.path === chatPath && account === undefined) return <main className="welcome public-page">Ouverture de Sillage…</main>
  if (route.path === accountPath || route.path === chatPath && !account) {
    return <AccountPage key={String(route.register)} navigate={navigate} register={route.register}
      connected={!!account} notice={notice} onAuthenticated={next => {
        setAccount(next)
        setNotice('')
        navigate(chatPath, true)
      }}/>
  }
  if (route.path !== chatPath || !account) return <HomePage navigate={navigate} connected={!!account}/>

  return <Chat account={account} navigate={navigate} onProfile={setAccount} onLogout={message => {
    setAccount(null)
    setNotice(message)
    navigate(accountPath, true)
  }}/>
}

function Chat({ account, navigate, onProfile, onLogout }: {
  account: Account
  navigate: (url: string, replace?: boolean) => void
  onProfile: (account: Account) => void
  onLogout: (message: string) => void
}) {
  const [directory, setDirectory] = useState(emptyDirectory)
  const [roomId, setRoomId] = useState('')
  const [spaceId, setSpaceId] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [roomReady, setRoomReady] = useState(false)
  const [dialog, setDialog] = useState<Dialog>()
  const [sidebar, setSidebar] = useState(false)
  const [details, setDetails] = useState(true)
  const [mobileDetails, setMobileDetails] = useState(false)
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState(false)
  const [notice, setNotice] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const modal = useRef<HTMLDialogElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const currentRoom = useRef('')
  const selected = directory.rooms.find(room => room.id === roomId)
  const space = directory.spaces.find(item => item.id === spaceId)
  const activeRooms = directory.rooms.filter(room => room.kind === 'channel' && (space ? room.space === space.id : true))
  const directs = directory.rooms.filter(room => room.kind === 'direct')
  const directoryRequest = useRef<Promise<Directory> | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (directoryRequest.current) return directoryRequest.current
    const operation = request<Directory>('directory')
    directoryRequest.current = operation
    try {
      const updated = await operation
      setDirectory(updated)
      return updated
    } finally {
      if (directoryRequest.current === operation) directoryRequest.current = undefined
    }
  }, [])

  function report(error: unknown) {
    const message = error instanceof Error ? error.message : 'Action impossible.'
    if (error instanceof ApiError && error.status === 401) onLogout(message)
    else setNotice(message)
  }

  useEffect(() => {
    let stopped = false
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      void refresh().then(next => replenish(account, next.packages)).catch(error => { if (!stopped) report(error) })
    }
    function connect() {
      if (stopped) return
      socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/live')
      socket.onopen = () => { setLive(true); update() }
      socket.onmessage = update
      socket.onclose = () => {
        if (stopped) return
        setLive(false)
        retry = setTimeout(connect, 3000)
      }
      socket.onerror = () => socket?.close()
    }
    update()
    connect()
    const timer = setInterval(update, 45_000)
    return () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(retry)
      socket?.close()
    }
  }, [account, refresh])

  useEffect(() => {
    if (!selected) return
    let stopped = false
    void readMessages(account, selected, directory.accounts).then(value => {
      if (!stopped) {
        setMessages(value)
        setRoomReady(true)
      }
    }).catch(error => {
      if (!stopped) {
        setRoomReady(false)
        report(error)
      }
    })
    return () => { stopped = true }
  }, [account, selected, directory])

  useEffect(() => {
    const element = modal.current
    if (dialog && !element?.open) element?.showModal()
    if (!dialog && element?.open) element.close()
  }, [dialog])

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [roomId, messages.length])

  function select(id: string) {
    if (id !== roomId) {
      setMessages([])
      setDraft('')
      setRoomReady(false)
    }
    currentRoom.current = id
    setRoomId(id)
    setSidebar(false)
    setMobileDetails(false)
  }

  function open(target: Dialog) {
    setFormError('')
    setDialog(target)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const value = String(new FormData(event.currentTarget).get('value') || '').trim()
    setBusy(true)
    setFormError('')
    try {
      if (!value) throw new Error('Renseigne ce champ.')
      if (dialog === 'space') {
        const created = await post<Space>('spaces', { name: value })
        setSpaceId(created.id)
        select('')
      } else if (dialog === 'room') {
        const created = await createRoom(account, value, 'channel', space?.id || null, directory.accounts)
        select(created.id)
      } else if (dialog === 'direct' || dialog === 'invite') {
        const target = directory.accounts.find(user => user.id === value.toLowerCase() && user.id !== account.id)
        if (!target) throw new Error('Ce pseudo ne correspond pas à un autre compte Sillage.')
        const existing = dialog === 'direct' ? directs.find(room => room.owner === account.id && room.name === target.id) : selected
        const room = existing || await createRoom(account, target.id, 'direct', null, directory.accounts)
        if (dialog === 'invite' || room.members < 2) await addMember(account, room, target, directory.accounts)
        select(room.id)
      } else if (dialog === 'profile') {
        await post('profile', { name: value })
        onProfile({ ...account, name: value })
      }
      await refresh()
      setDialog(undefined)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Action impossible.')
      void refresh().catch(() => {})
    } finally { setBusy(false) }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    if (!selected || !roomReady || sending || !draft.trim()) return
    setSending(true)
    setNotice('')
    try {
      const next = await sendMessage(account, selected, { kind: 'text', text: draft.trim() }, directory.accounts)
      if (currentRoom.current === selected.id) {
        setMessages(next)
        setDraft(value => value === draft ? '' : value)
      }
    } catch (error) { report(error) }
    finally { setSending(false) }
  }

  async function attach(file: File) {
    if (!selected || !roomReady || sending) return
    setSending(true)
    try {
      const next = await uploadFile(account, selected, file, directory.accounts)
      if (currentRoom.current === selected.id) setMessages(next)
    } catch (error) { report(error) }
    finally { setSending(false) }
  }

  async function signOut() {
    try { await post('logout', {}); onLogout('Tu es déconnecté.') }
    catch (error) { setFormError(error instanceof Error ? error.message : 'Déconnexion impossible.') }
  }

  function roomName(room: Room) {
    if (room.kind === 'channel') return room.name
    const contact = room.owner === account.id ? room.name : room.owner
    return directory.accounts.find(user => user.id === contact)?.name || contact
  }
  function roomButton(room: Room) {
    return <button className={'channel ' + (room.id === roomId ? 'selected' : '')} key={room.id} onClick={() => select(room.id)}>
      {room.kind === 'direct' ? <MessageSquare size={16}/> : <Hash size={17}/>} <span>{roomName(room)}</span><LockKeyhole className="mini-lock" size={12}/>
    </button>
  }

  return <div className="shell">
    <header className="topbar">
      <button className="icon menu-button" aria-label="Ouvrir la navigation" onClick={() => setSidebar(!sidebar)}><Menu size={21}/></button>
      <Brand navigate={navigate}/><span className="top-divider"/><span className="network"><ShieldCheck size={15}/> Messagerie chiffrée</span>
      <div className="top-end"><span className="status"><i className={live ? 'online' : ''}/>{live ? 'En ligne' : 'Connexion au service'}</span></div>
    </header>
    {sidebar && <button className="scrim" onClick={() => setSidebar(false)} aria-label="Fermer la navigation"/>}
    <div className={'navigation ' + (sidebar ? 'nav-open' : '')}>
      <nav className="rail" aria-label="Communautés">
        <button title="Tous les salons" aria-label="Tous les salons" className={'rail-button ' + (!spaceId ? 'active' : '')} onClick={() => { setSpaceId(''); select('') }}><Command size={21}/></button>
        <div className="rail-line"/>
        {directory.spaces.map(item => <button key={item.id} title={item.name} className={'rail-button ' + (item.id === spaceId ? 'active' : '')}
          onClick={() => { setSpaceId(item.id); select('') }}>{initials(item.name)}</button>)}
        <button className="rail-button dashed" aria-label="Créer une communauté" title="Créer une communauté" onClick={() => open('space')}><Plus size={22}/></button>
      </nav>
      <aside className="sidebar">
        <div className="side-title"><span><strong>{space?.name || 'Mon espace'}</strong><small>{space ? 'Communauté Sillage' : 'Messagerie Sillage'}</small></span></div>
        <div className="side-body">
          <div className="section-title">Salons textuels <button className="icon" aria-label="Créer un salon" onClick={() => open('room')}><Plus size={17}/></button></div>
          {activeRooms.length ? activeRooms.map(roomButton) : <p className="side-empty">Aucun salon pour le moment</p>}
          <div className="section-title">Messages privés <button className="icon" aria-label="Créer un message privé" onClick={() => open('direct')}><Plus size={17}/></button></div>
          {directs.length ? directs.map(roomButton) : <p className="side-empty">Aucune conversation privée</p>}
        </div>
        <div className="profile"><span className="avatar">{initials(account.name)}</span><div><strong>{account.name}</strong><small>@{account.id}</small></div>
          <button className="icon" aria-label="Profil et déconnexion" onClick={() => open('profile')}><Settings2 size={18}/></button></div>
      </aside>
    </div>

    <main className="main">
      <div className="room-header"><span className="room-icon">{selected ? <Hash size={21}/> : <MessageSquare size={18}/>}</span>
        <div className="room-heading"><strong>{selected ? roomName(selected) : space?.name || 'Accueil'}</strong><small>{selected ? 'Salon chiffré' : 'Espace de messagerie'}</small></div>
        {selected?.kind === 'channel' && selected.owner === account.id &&
          <button className="icon" title="Inviter" aria-label="Inviter" onClick={() => open('invite')}><Users size={18}/></button>}
        <button className={'icon info-toggle ' + (details ? 'on' : '')} aria-label="Confidentialité" onClick={() => { setDetails(!details); setMobileDetails(!mobileDetails) }}><ShieldCheck size={20}/></button>
      </div>
      {notice && <div className="notice" role="alert"><span>{notice}</span><button className="icon" aria-label="Fermer le message" onClick={() => setNotice('')}><X size={16}/></button></div>}
      {selected ? <>
        <div className="messages" aria-busy={!roomReady}>
          {!messages.length && <div className="empty-messages"><MessageSquare size={30}/><p>{roomReady ? 'Aucun message dans ce salon.' : 'Synchronisation du salon chiffré…'}</p></div>}
          {messages.map(message => {
            const payload = message.payload
            const name = directory.accounts.find(user => user.id === payload.from)?.name || payload.from
            return <article className="message" key={message.id}><span className="avatar">{initials(name)}</span><div>
              <div className="message-meta"><strong>{name}</strong><time>{new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(message.at)}</time></div>
              <div className="message-body">{payload.kind === 'text' ? payload.text : <button className="secondary file-button" onClick={() => void downloadFile(selected, payload).catch(report)}><Download size={17}/>{payload.name}</button>}</div>
            </div></article>
          })}
          <div ref={bottom}/>
        </div>
        <div className="compose-wrap"><form className="compose" onSubmit={send}>
          <input ref={fileInput} hidden type="file" onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void attach(file)
          }}/>
          <button type="button" className="icon" aria-label="Joindre un fichier chiffré" disabled={!roomReady || sending} onClick={() => fileInput.current?.click()}><Paperclip size={19}/></button>
          <input aria-label="Message" placeholder={'Écrire dans ' + roomName(selected)} value={draft} maxLength={4000} onChange={event => setDraft(event.target.value)} disabled={!roomReady}/>
          <button className="send" disabled={!roomReady || !draft.trim() || sending} aria-label="Envoyer"><Send size={17}/></button>
        </form></div>
      </> : <div className="welcome"><HeroArt/><h1>{space?.name || 'Votre espace de discussion'}</h1>
        <p>{space ? 'Choisis un salon de la communauté ou crée-en un.' : 'Crée une communauté ou lance une conversation privée.'}</p>
        <div className="welcome-actions">
          <button className="primary" onClick={() => open(space ? 'room' : 'direct')}><Plus size={17}/>{space ? 'Créer un salon' : 'Nouveau message privé'}</button>
          {!space && <button className="secondary" onClick={() => open('space')}>Créer une communauté</button>}
        </div>
      </div>}
    </main>
    <aside className={'details ' + (details ? '' : 'details-hidden ') + (mobileDetails ? 'details-open' : '')}>
      <div className="details-title"><ShieldCheck size={18}/> Confidentialité<button className="icon mobile-close" aria-label="Fermer les informations" onClick={() => setMobileDetails(false)}><X size={17}/></button></div>
      <div className="details-body"><div className="security-card"><span className="security-icon"><LockKeyhole size={21}/></span>
        <strong>Chiffrement de bout en bout</strong><p>Les messages sont chiffrés dans ton navigateur avec MLS. Les fichiers sont chiffrés avant le téléversement.</p></div>
        <div className="detail-row"><Paperclip size={17}/><div><strong>Pièces jointes</strong><small>1 000 Kio par fichier</small></div></div>
        <div className="detail-row"><ShieldCheck size={17}/><div><strong>Clés du navigateur</strong><small>Conserve les données du site pour retrouver tes conversations.</small></div></div>
      </div>
    </aside>
    <dialog ref={modal} className="dialog" aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); if (!busy) setDialog(undefined) }}>
      {dialog && <><div className="dialog-top"><h2 id="dialog-title">{dialogs[dialog].title}</h2><button className="icon" aria-label="Fermer" disabled={busy} onClick={() => setDialog(undefined)}><X size={20}/></button></div>
        <form key={dialog} onSubmit={submit}>
          <Field name="value" label={dialogs[dialog].label} disabled={busy} maxLength={64} defaultValue={dialog === 'profile' ? account.name : undefined}/>
          {dialog === 'profile' && <p className="device-code">Clé publique de cet appareil <code>{account.identity}</code></p>}
          {(dialog === 'invite' || dialog === 'direct') && <p>Le destinataire doit déjà avoir un compte Sillage dans son navigateur.</p>}
          {formError && <p className="error" role="alert">{formError}</p>}
          <div className="dialog-actions">
            {dialog === 'profile' && <button type="button" className="secondary" onClick={() => void signOut()} disabled={busy}><LogOut size={16}/> Déconnexion</button>}
            <button className="primary" disabled={busy}>{busy ? 'Patiente…' : dialogs[dialog].action}</button>
          </div>
        </form>
      </>}
    </dialog>
  </div>
}
function initials(name: string) { return name.trim().slice(0, 2).toLocaleUpperCase() || '?' }
createRoot(document.getElementById('root')!).render(<App/>)
