import { vi } from 'vitest';

type StorageData = Record<string, unknown>;

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
}

export function readBrowserStorage() {
  return storageData;
}
