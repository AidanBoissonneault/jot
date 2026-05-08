import { vi } from 'vitest';

type StorageData = Record<string, unknown>;

// --- IndexedDB mock ---

const idbData: StorageData = {};

function makeIdbObjectStore() {
  return {
    get: vi.fn((key: string) => {
      const result = { result: idbData[key] };
      const req: Record<string, unknown> = { ...result };
      Promise.resolve().then(() => {
        if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
      });
      return req;
    }),
    put: vi.fn((value: unknown, key: string) => {
      idbData[key] = value;
      const req: Record<string, unknown> = {};
      Promise.resolve().then(() => {
        if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
      });
      return req;
    }),
  };
}

function makeIdbTransaction(mode: string) {
  const store = makeIdbObjectStore();
  const tx: Record<string, unknown> = {
    objectStore: vi.fn(() => store),
  };
  if (mode === 'readwrite') {
    Promise.resolve().then(() => {
      if (typeof tx.oncomplete === 'function') (tx.oncomplete as () => void)();
    });
  }
  return tx;
}

function makeIdbDatabase() {
  return {
    transaction: vi.fn((_, mode: string) => makeIdbTransaction(mode)),
    objectStoreNames: { contains: vi.fn(() => true) },
    createObjectStore: vi.fn(),
  };
}

vi.stubGlobal('indexedDB', {
  open: vi.fn(() => {
    const db = makeIdbDatabase();
    const req: Record<string, unknown> = {
      result: db,
    };
    Promise.resolve().then(() => {
      if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
    });
    return req;
  }),
});

export function resetIdbStorage(values: StorageData = {}) {
  for (const key of Object.keys(idbData)) {
    delete idbData[key];
  }
  Object.assign(idbData, values);
}

export function readIdbStorage() {
  return { ...idbData };
}

// --- browser.storage.local mock ---

const storageData: StorageData = {};

function pickStorage(keys?: string | string[] | Record<string, unknown> | null) {
  if (Array.isArray(keys)) {
    return keys.reduce<StorageData>((result, key) => {
      if (key in storageData) {
        result[key] = storageData[key];
      }
      return result;
    }, {});
  }

  if (typeof keys === 'string') {
    return keyValue(keys);
  }

  if (keys && typeof keys === 'object') {
    return Object.keys(keys).reduce<StorageData>((result, key) => {
      result[key] = key in storageData ? storageData[key] : keys[key];
      return result;
    }, {});
  }

  return { ...storageData };
}

function keyValue(key: string) {
  return key in storageData ? { [key]: storageData[key] } : {};
}

vi.stubGlobal('browser', {
  runtime: {
    onMessage: {
      addListener: vi.fn(),
    },
    sendMessage: vi.fn(),
  },
  storage: {
    local: {
      get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) =>
        pickStorage(keys),
      ),
      set: vi.fn(async (values: StorageData) => {
        Object.assign(storageData, values);
      }),
    },
  },
  tabs: {
    create: vi.fn(),
  },
});

export function resetBrowserStorage(values: StorageData = {}) {
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
  Object.assign(storageData, values);

  // Seed IDB directly and mark migration done so readStorage() skips migration
  for (const key of Object.keys(idbData)) {
    delete idbData[key];
  }
  Object.assign(idbData, values);
  idbData['__idb_migrated__'] = true;
}

export function readBrowserStorage() {
  // notionClient writes to IDB now — read from there
  return idbData;
}
