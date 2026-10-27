/** Browser extension APIs scoped to this local marketing preview. */
type RuntimeListener = (message: any, sender?: any, sendResponse?: any) => any;
type ChangeListener = (changes: Record<string, unknown>, areaName: string) => void;

declare global {
  interface Window {
    browser: {
      runtime: {
        id: string;
        onMessage: {
          addListener(listener: RuntimeListener): void;
          removeListener(listener: RuntimeListener): void;
        };
        sendMessage(message: unknown): Promise<unknown>;
        getURL(path: string): string;
      };
      storage: {
        local: {
          get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
          set(items: Record<string, unknown>): Promise<void>;
          remove(keys: string | string[]): Promise<void>;
          clear(): Promise<void>;
        };
        onChanged: {
          addListener(listener: ChangeListener): void;
          removeListener(listener: ChangeListener): void;
        };
      };
      tabs: {
        query(queryInfo: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
        create(createProperties: Record<string, unknown>): Promise<undefined>;
      };
    };
  }
}

const storagePrefix = 'jottathing-marketing-extension:';
const runtimeListeners = new Set<RuntimeListener>();
const storageListeners = new Set<ChangeListener>();

function storageValue(key: string): unknown {
  const stored = localStorage.getItem(`${storagePrefix}${key}`);
  if (stored === null) return undefined;

  try {
    return JSON.parse(stored) as unknown;
  } catch {
    return undefined;
  }
}

function allStorageValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(storagePrefix)) continue;
    const value = storageValue(key.slice(storagePrefix.length));
    if (value !== undefined) values[key.slice(storagePrefix.length)] = value;
  }
  return values;
}

function keysForGet(keys?: string | string[] | Record<string, unknown> | null): string[] {
  if (keys == null) return Object.keys(allStorageValues());
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys;
  return Object.keys(keys);
}

const localStorageArea = {
  async get(keys?: string | string[] | Record<string, unknown> | null) {
    const result: Record<string, unknown> = {};
    for (const key of keysForGet(keys)) {
      const value = storageValue(key);
      if (value !== undefined) result[key] = value;
      else if (keys && !Array.isArray(keys) && typeof keys === 'object' && key in keys) {
        result[key] = keys[key];
      }
    }
    return result;
  },
  async set(items: Record<string, unknown>) {
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(items)) {
      const oldValue = storageValue(key);
      localStorage.setItem(`${storagePrefix}${key}`, JSON.stringify(value));
      changes[key] = { ...(oldValue === undefined ? {} : { oldValue }), newValue: value };
    }
    for (const listener of storageListeners) listener(changes, 'local');
  },
  async remove(keys: string | string[]) {
    const changes: Record<string, unknown> = {};
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      const oldValue = storageValue(key);
      localStorage.removeItem(`${storagePrefix}${key}`);
      if (oldValue !== undefined) changes[key] = { oldValue };
    }
    for (const listener of storageListeners) listener(changes, 'local');
  },
  async clear() {
    const oldValues = allStorageValues();
    for (const key of Object.keys(oldValues)) localStorage.removeItem(`${storagePrefix}${key}`);
    const changes = Object.fromEntries(
      Object.entries(oldValues).map(([key, oldValue]) => [key, { oldValue }]),
    );
    for (const listener of storageListeners) listener(changes, 'local');
  },
};

const browserApi: Window['browser'] = {
  runtime: {
    id: 'jottathing-local-marketing-preview',
    onMessage: {
      addListener(listener) {
        runtimeListeners.add(listener);
      },
      removeListener(listener) {
        runtimeListeners.delete(listener);
      },
    },
    async sendMessage(message) {
      const results = await Promise.all(
        [...runtimeListeners].map((listener) =>
          Promise.resolve(listener(message, { tab: { id: 1, url: location.href } })),
        ),
      );
      return results.find((result) => result !== false && result !== undefined) ?? false;
    },
    getURL(path) {
      return new URL(path, location.origin).href;
    },
  },
  storage: {
    local: localStorageArea,
    onChanged: {
      addListener(listener) {
        storageListeners.add(listener);
      },
      removeListener(listener) {
        storageListeners.delete(listener);
      },
    },
  },
  tabs: {
    async query() {
      return [{ id: 1, active: true, url: location.href, title: document.title }];
    },
    async create() {
      return undefined;
    },
  },
};

window.browser = browserApi;

// The editor should open as an offline local workspace and cannot sync or call external services.
Object.defineProperty(navigator, 'onLine', {
  configurable: true,
  get: () => false,
});

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin === location.origin || url.protocol === 'blob:' || url.protocol === 'data:') {
    return nativeFetch(input, init);
  }
  return Promise.reject(new TypeError('External requests are disabled in the local preview.'));
};

export {};
