/**
 * Small IndexedDB key-value wrapper for local-only data: the offline scene library, autosave drafts
 * and local-mode sessions. When IndexedDB is unavailable (Vitest/Node, some private modes) it falls
 * back to an in-memory store with the same semantics (values are structured-cloned on the way in
 * and out, so callers never alias stored objects).
 */

export const STORE_NAMES = ["scenes", "sceneVersions", "drafts", "sessions"] as const
export type StoreName = (typeof STORE_NAMES)[number]

export interface LocalStore {
  readonly backend: "indexeddb" | "memory"
  get<T>(store: StoreName, key: string): Promise<T | undefined>
  put<T>(store: StoreName, key: string, value: T): Promise<void>
  delete(store: StoreName, key: string): Promise<void>
  /** Keys in ascending order, optionally only those starting with `prefix`. */
  keys(store: StoreName, prefix?: string): Promise<string[]>
  /** [key, value] pairs in ascending key order, optionally only keys starting with `prefix`. */
  entries<T>(store: StoreName, prefix?: string): Promise<Array<[string, T]>>
  /** Delete every key starting with `prefix`; returns how many were deleted. */
  deletePrefix(store: StoreName, prefix: string): Promise<number>
  close(): void
}

const DB_NAME = "atlas-vtt"
const DB_VERSION = 1

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

export function createMemoryStore(): LocalStore {
  const stores = new Map<StoreName, Map<string, unknown>>(STORE_NAMES.map((n) => [n, new Map()]))
  const table = (name: StoreName) => {
    const t = stores.get(name)
    if (!t) throw new Error(`unknown store ${name}`)
    return t
  }
  const sortedKeys = (name: StoreName, prefix?: string) =>
    [...table(name).keys()].filter((k) => prefix === undefined || k.startsWith(prefix)).sort(compareKeys)

  return {
    backend: "memory",
    async get<T>(store: StoreName, key: string) {
      const t = table(store)
      return t.has(key) ? (structuredClone(t.get(key)) as T) : undefined
    },
    async put<T>(store: StoreName, key: string, value: T) {
      table(store).set(key, structuredClone(value))
    },
    async delete(store, key) {
      table(store).delete(key)
    },
    async keys(store, prefix) {
      return sortedKeys(store, prefix)
    },
    async entries<T>(store: StoreName, prefix?: string) {
      const t = table(store)
      return sortedKeys(store, prefix).map((k) => [k, structuredClone(t.get(k)) as T] as [string, T])
    },
    async deletePrefix(store, prefix) {
      const keys = sortedKeys(store, prefix)
      for (const k of keys) table(store).delete(k)
      return keys.length
    },
    close() {},
  }
}

/** IndexedDB orders string keys by UTF-16 code units, which is what `<` does on JS strings. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------------------------------------------------------------------------
// IndexedDB backend
// ---------------------------------------------------------------------------

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"))
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"))
  })
}

/** Keys starting with `prefix`: [prefix, prefix + U+FFFF]. */
function prefixRange(prefix: string | undefined): IDBKeyRange | undefined {
  return prefix === undefined || prefix === "" ? undefined : IDBKeyRange.bound(prefix, `${prefix}￿`)
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const store of STORE_NAMES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // Another tab wants to upgrade the schema: step aside so it is not blocked forever.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"))
    req.onblocked = () => reject(new Error("IndexedDB open blocked by another tab"))
  })
}

function createIdbStore(db: IDBDatabase): LocalStore {
  const run = async <T>(store: StoreName, mode: IDBTransactionMode, body: (s: IDBObjectStore) => Promise<T>): Promise<T> => {
    const tx = db.transaction(store, mode)
    const done = transactionDone(tx)
    try {
      const result = await body(tx.objectStore(store))
      await done
      return result
    } catch (err) {
      done.catch(() => {})
      try {
        tx.abort()
      } catch {
        // already finished or aborted
      }
      throw err
    }
  }

  return {
    backend: "indexeddb",
    get<T>(store: StoreName, key: string) {
      return run(store, "readonly", (s) => request(s.get(key)) as Promise<T | undefined>)
    },
    put<T>(store: StoreName, key: string, value: T) {
      return run(store, "readwrite", async (s) => {
        await request(s.put(value, key))
      })
    },
    delete(store, key) {
      return run(store, "readwrite", async (s) => {
        await request(s.delete(key))
      })
    },
    keys(store, prefix) {
      return run(store, "readonly", async (s) => (await request(s.getAllKeys(prefixRange(prefix)))).map(String))
    },
    entries<T>(store: StoreName, prefix?: string) {
      return run(store, "readonly", async (s) => {
        const range = prefixRange(prefix)
        // getAllKeys and getAll over the same range in one transaction return matching orders.
        const [keys, values] = await Promise.all([request(s.getAllKeys(range)), request(s.getAll(range))])
        return keys.map((k, i) => [String(k), values[i] as T] as [string, T])
      })
    },
    deletePrefix(store, prefix) {
      return run(store, "readwrite", async (s) => {
        const range = prefixRange(prefix)
        if (!range) throw new Error("deletePrefix needs a non-empty prefix")
        const count = await request(s.count(range))
        await request(s.delete(range))
        return count
      })
    },
    close() {
      db.close()
    },
  }
}

export interface OpenLocalStoreOptions {
  name?: string
  /** Override (tests) or disable (null) IndexedDB. Default: globalThis.indexedDB. */
  indexedDB?: IDBFactory | null
}

/** Open the IndexedDB store, or the in-memory fallback when IndexedDB is unavailable or broken. */
export async function openLocalStore(opts: OpenLocalStoreOptions = {}): Promise<LocalStore> {
  const factory = opts.indexedDB === undefined ? (globalThis.indexedDB as IDBFactory | undefined) : opts.indexedDB
  if (!factory) return createMemoryStore()
  try {
    return createIdbStore(await openDatabase(factory, opts.name ?? DB_NAME))
  } catch {
    return createMemoryStore()
  }
}

let appStore: Promise<LocalStore> | null = null

/** The app-wide local store (opened once). */
export function getLocalStore(): Promise<LocalStore> {
  appStore ??= openLocalStore()
  return appStore
}

// ---------------------------------------------------------------------------
// Autosave drafts
// ---------------------------------------------------------------------------

export interface Draft<T> {
  key: string
  savedAt: string
  data: T
}

export async function saveDraft<T>(store: LocalStore, key: string, data: T): Promise<Draft<T>> {
  const draft: Draft<T> = { key, savedAt: new Date().toISOString(), data }
  await store.put("drafts", key, draft)
  return draft
}

export function loadDraft<T>(store: LocalStore, key: string): Promise<Draft<T> | undefined> {
  return store.get<Draft<T>>("drafts", key)
}

export function deleteDraft(store: LocalStore, key: string): Promise<void> {
  return store.delete("drafts", key)
}

/** Draft metadata, newest first. */
export async function listDrafts(store: LocalStore): Promise<Array<{ key: string; savedAt: string }>> {
  const all = await store.entries<Draft<unknown>>("drafts")
  return all.map(([key, d]) => ({ key, savedAt: d.savedAt })).sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}
