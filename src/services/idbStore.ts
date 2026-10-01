const DB_NAME = 'inkwell';
const STORE_NAME = 'kv';
const DB_VERSION = 2;
const WRITE_CONTROL_KEY = '__inkwell_write_control__';

let dbPromise: Promise<IDBDatabase> | null = null;
let writesPaused = false;
let writerEpochPromise: Promise<number> | null = null;
let writerEpoch = 0;
const pendingWrites = new Set<Promise<void>>();

type WriteControl = {
  epoch: number;
  paused: boolean;
};

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  return trackWrite(async () => {
    await writeIfCurrent((store) => {
      store.put(cloneableProjectState(value), key);
    });
  });
}

export async function idbGetMany(keys: string[]): Promise<Record<string, unknown>> {
  if (keys.length === 0) return {};
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const result: Record<string, unknown> = {};
    let pending = keys.length;
    for (const key of keys) {
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result !== undefined) result[key] = req.result;
        if (--pending === 0) resolve(result);
      };
      req.onerror = () => reject(req.error);
    }
  });
}

export async function idbSetMany(items: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(items);
  if (entries.length === 0) return;
  return trackWrite(async () => {
    await writeIfCurrent((store) => {
      for (const [key, value] of entries) {
        store.put(cloneableProjectState(value), key);
      }
    });
  });
}

/**
 * Fences every extension context from writing while connection deletion runs.
 * The pause and each write share the same IndexedDB transaction queue, so a
 * writer in another sidepanel or the service worker cannot slip a write past
 * the deletion fence.
 */
export async function pauseIdbWrites(): Promise<void> {
  writesPaused = true;
  await Promise.allSettled([...pendingWrites]);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(WRITE_CONTROL_KEY);
    request.onsuccess = () => {
      const control = normalizeWriteControl(request.result);
      store.put({ ...control, paused: true }, WRITE_CONTROL_KEY);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Re-enables writes after an aborted deletion, or adopts the new epoch after a successful wipe. */
export async function resumeIdbWrites(options: { adoptCurrentEpoch?: boolean } = {}): Promise<void> {
  const db = await openDb();
  let nextEpoch = writerEpoch;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(WRITE_CONTROL_KEY);
    request.onsuccess = () => {
      const control = normalizeWriteControl(request.result);
      nextEpoch = control.epoch;
      store.put({ ...control, paused: false }, WRITE_CONTROL_KEY);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  if (options.adoptCurrentEpoch) {
    writerEpoch = nextEpoch;
    writerEpochPromise = Promise.resolve(nextEpoch);
  }
  writesPaused = false;
}

async function trackWrite(write: () => Promise<void>): Promise<void> {
  if (writesPaused) return;

  const pending = write();
  pendingWrites.add(pending);
  try {
    await pending;
  } finally {
    pendingWrites.delete(pending);
  }
}

async function writeIfCurrent(write: (store: IDBObjectStore) => void): Promise<void> {
  const epoch = await getWriterEpoch();
  if (writesPaused) return;

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(WRITE_CONTROL_KEY);
    request.onsuccess = () => {
      const control = normalizeWriteControl(request.result);
      if (control.paused || control.epoch !== epoch) return;
      write(store);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getWriterEpoch(): Promise<number> {
  if (!writerEpochPromise) {
    writerEpochPromise = (async () => {
      const db = await openDb();
      return new Promise<number>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(WRITE_CONTROL_KEY);
        let epoch = 1;
        request.onsuccess = () => {
          const control = request.result as WriteControl | undefined;
          if (control && Number.isSafeInteger(control.epoch) && control.epoch > 0) {
            epoch = control.epoch;
          } else {
            store.put({ epoch, paused: false } satisfies WriteControl, WRITE_CONTROL_KEY);
          }
        };
        tx.oncomplete = () => resolve(epoch);
        tx.onerror = () => reject(tx.error);
      });
    })().then((epoch) => {
      writerEpoch = epoch;
      return epoch;
    }).catch((error) => {
      writerEpochPromise = null;
      throw error;
    });
  }
  return writerEpochPromise;
}

/** Removes every Inkwell document, preference, and pending sync item in IndexedDB. */
export async function idbClear(): Promise<void> {
  await getWriterEpoch();
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(WRITE_CONTROL_KEY);
    let allowed = false;
    request.onsuccess = () => {
      const control = normalizeWriteControl(request.result);
      if (!control.paused) return;
      allowed = true;
      store.clear();
      store.put({ epoch: control.epoch + 1, paused: true } satisfies WriteControl, WRITE_CONTROL_KEY);
    };
    tx.oncomplete = () => allowed
      ? resolve()
      : reject(new Error('IndexedDB must be paused by the current context before clearing data.'));
    tx.onerror = () => reject(tx.error);
  });
}

function normalizeWriteControl(value: unknown): WriteControl {
  if (
    value && typeof value === 'object' &&
    Number.isSafeInteger((value as WriteControl).epoch) &&
    (value as WriteControl).epoch > 0
  ) {
    return {
      epoch: (value as WriteControl).epoch,
      paused: (value as WriteControl).paused === true,
    };
  }
  return { epoch: 1, paused: false };
}

/** Vue can proxy nested project state after it enters Pinia. IndexedDB cannot
 * structured-clone proxies, while all values in this KV store are JSON state.
 * A JSON round trip unwraps those proxies before they reach IDB. */
export function cloneableProjectState<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}
