let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('sillage-mls', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('secure')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

export async function readLocal<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction('secure').objectStore('secure').get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

export async function writeLocal<T>(key: string, value: T) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('secure', 'readwrite')
    transaction.objectStore('secure').put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}

export function lock<T>(name: string, action: () => Promise<T>) {
  if (!navigator.locks) throw new Error('Ce navigateur ne permet pas de protéger la session entre plusieurs onglets.')
  return navigator.locks.request('sillage:' + name, action)
}


export async function legacyRooms(user: string) {
  const db = await openDatabase()
  const prefix = 'room:' + user + ':'
  return new Promise<string[]>((resolve, reject) => {
    const request = db.transaction('secure').objectStore('secure').getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff'))
    request.onsuccess = () => resolve(request.result.flatMap(key => typeof key === 'string' && key.startsWith(prefix) ? [key] : []))
    request.onerror = () => reject(request.error)
  })
}

export async function forgetLocal(key: string) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('secure', 'readwrite')
    transaction.objectStore('secure').delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}
