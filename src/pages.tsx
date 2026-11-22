import { useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { AudioLines, Globe2, Hash, LockKeyhole, MessageSquare, Server, ShieldCheck, Users } from 'lucide-react'
import { authenticate } from './crypto'
import type { Account } from './types'

export type Navigate = (url: string, replace?: boolean) => void
export const accountPath = '/connexion'
export const registerPath = '/connexion?mode=inscription'
export const chatPath = '/messagerie'

export function RouteLink({ href, navigate, className, current, children }: {
  href: string; navigate: Navigate; className?: string; current?: boolean; children: ReactNode
}) {
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return
    event.preventDefault()
    navigate(href)
  }
  return <a href={href} className={className} onClick={follow} aria-current={current ? 'page' : undefined}>{children}</a>
}

export function Brand({ navigate }: { navigate: Navigate }) {
  return <RouteLink href="/" navigate={navigate} className="brand"><span className="brand-icon"><AudioLines size={21}/></span>Sillage</RouteLink>
}

export function HeroArt() {
  return <div className="hero-art" aria-hidden="true">
    <div className="orbit outer"/><div className="orbit inner"/><div className="orbit core"/>
    <span className="spark s1"/><span className="spark s2"/><span className="spark s3"/><span className="spark s4"/>
    <div className="hero-logo"><AudioLines size={44} strokeWidth={1.7}/></div>
    <div className="hero-shield"><ShieldCheck size={18}/></div>
  </div>
}

export function HomePage({ navigate }: { navigate: Navigate }) {
  return <div className="public-page">
    <header className="public-header">
      <span className="brand"><span className="brand-icon"><AudioLines size={21}/></span>Sillage</span>
    </header>
    <main className="landing">
      <div className="landing-hero">
        <HeroArt/>
        <div className="landing-kicker"><Globe2 size={15}/> Messagerie chiffrée</div>
        <h1>Retrouve tes communautés.<br/><span>Discute en privé.</span></h1>
        <p>Des salons pour te retrouver en groupe, et des messages privés chiffrés de bout en bout.</p>
        <div className="welcome-actions">
          <RouteLink className="primary" href={accountPath} navigate={navigate}>Commencer</RouteLink>
        </div>
      </div>
      <section className="landing-features" aria-label="Fonctionnalités">
        <div><Users size={22}/><h2>Communautés</h2><p>Regroupe tes salons et invite tes membres dans ta communauté.</p></div>
        <div><MessageSquare size={22}/><h2>Messages privés</h2><p>Échange des messages et des fichiers chiffrés depuis ton navigateur.</p></div>
        <div><Server size={22}/><h2>Ton compte Sillage</h2><p>Choisis un pseudo et retrouve tes conversations dans ton navigateur.</p></div>
      </section>
    </main>
  </div>
}

export function AccountPage({ navigate, register, connected, notice, onAuthenticated }: {
  navigate: Navigate; register: boolean; connected: boolean; notice: string; onAuthenticated: (account: Account) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const values = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const user = String(values.get('value')).trim().toLowerCase()
      const password = String(values.get('password'))
      if (!/^[a-z0-9][a-z0-9_-]{2,30}$/.test(user)) throw new Error('Choisis un pseudo de 3 à 31 caractères avec des lettres sans accents, chiffres, tirets ou underscores.')
      if (password.length < 12 || password.length > 256) throw new Error('Utilise un mot de passe de 12 à 256 caractères.')
      onAuthenticated(await authenticate(user, password, register))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sillage n’a pas pu terminer la demande.')
    } finally {
      setBusy(false)
    }
  }
  return <div className="public-page">
    <header className="public-header"><Brand navigate={navigate}/><RouteLink className="secondary" href="/" navigate={navigate}>Accueil</RouteLink></header>
    <main className="account-layout">
      <section className="account-card">
        <span className="security-icon"><LockKeyhole size={21}/></span>
        <h1>{connected ? 'Ton compte Sillage' : register ? 'Créer un compte' : 'Connexion à Sillage'}</h1>
        {notice && <p role="status">{notice}</p>}
        {connected ? <><p>Ta session est déjà ouverte dans ce navigateur.</p><RouteLink className="primary" href={chatPath} navigate={navigate}>Ouvrir la messagerie</RouteLink></> :
          <>
            <nav aria-label="Accès au compte" className="account-tabs">
              {busy ? <><span>Connexion</span><span>Inscription</span></> : <>
                <RouteLink href={accountPath} navigate={navigate} current={!register}>Connexion</RouteLink>
                <RouteLink href={registerPath} navigate={navigate} current={register}>Inscription</RouteLink>
              </>}
            </nav>
            <form onSubmit={submit}>
              <Field name="value" label="Pseudo" placeholder="alice" autoComplete="username" disabled={busy} minLength={3} maxLength={31}/>
              <Field name="password" label="Mot de passe" type="password" autoComplete={register ? 'new-password' : 'current-password'} disabled={busy} minLength={12} maxLength={256}/>
              {register && <small className="field-hint">12 caractères minimum. Garde ce navigateur pour retrouver tes clés.</small>}
              {error && <p className="account-error" role="alert">{error}</p>}
              <button className="primary" disabled={busy}>{busy ? 'Connexion au serveur…' : register ? 'Créer mon compte' : 'Se connecter'}</button>
            </form>
          </>}
      </section>
      <aside className="tutorial">
        <span className="security-icon"><Hash size={21}/></span>
        <h2>Comment créer ton compte</h2>
        <ol>
          <li><div><strong>Choisis « Inscription »</strong><p>Entre un pseudo, par exemple <code>alice_27</code>. Les autres membres pourront t’envoyer une demande d’ami avec ce pseudo.</p></div></li>
          <li><div><strong>Crée ton mot de passe</strong><p>Utilise au moins 12 caractères, puis clique sur « Créer mon compte ». Dans la messagerie, ajoute un ami par son pseudo et attends qu’il accepte avant de lui écrire.</p></div></li>
          <li><div><strong>Reviens avec le même navigateur</strong><p>Les clés qui ouvrent tes conversations restent sur cet appareil. Évite la navigation privée et conserve les données du site.</p></div></li>
        </ol>
        <details><summary>Je change de navigateur ou d’appareil</summary><p>Ce prototype associe un compte à un seul navigateur. Il ne permet pas de déplacer les clés ni de récupérer les conversations après effacement des données locales.</p></details>
      </aside>
    </main>
  </div>
}

export function Field({ label, required = true, ...props }: {
  label: string; name: string; required?: boolean; placeholder?: string; defaultValue?: string; type?: string; autoComplete?: string; disabled?: boolean; minLength?: number; maxLength?: number
}) {
  return <label className="field">{label}<input {...props} required={required}/></label>
}
