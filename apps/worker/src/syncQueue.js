export class MergeableSyncQueue {
  constructor() {
    this.entries = new Map();
  }

  enqueue(key, payload, handler) {
    const entry = this.entries.get(key) ?? this.createEntry(key, handler);
    entry.handler = handler;

    if (!entry.inFlight) {
      entry.inFlight = this.run(key, entry, payload);
      return entry.inFlight;
    }

    entry.pendingPayload = payload;

    if (!entry.pendingDeferred) {
      entry.pendingDeferred = deferred();
    }

    return entry.pendingDeferred.promise;
  }

  createEntry(key, handler) {
    const entry = {
      handler,
      inFlight: undefined,
      pendingPayload: undefined,
      pendingDeferred: undefined,
    };
    this.entries.set(key, entry);
    return entry;
  }

  async run(key, entry, payload) {
    try {
      return await entry.handler(payload);
    } finally {
      entry.inFlight = undefined;
      this.drain(key, entry);
    }
  }

  drain(key, entry) {
    if (entry.pendingPayload === undefined) {
      this.entries.delete(key);
      return;
    }

    const payload = entry.pendingPayload;
    const pending = entry.pendingDeferred;
    entry.pendingPayload = undefined;
    entry.pendingDeferred = undefined;

    entry.inFlight = this.run(key, entry, payload);
    entry.inFlight.then(pending.resolve, pending.reject);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
