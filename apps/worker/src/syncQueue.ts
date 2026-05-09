// TODO: replace with Cloudflare Queues for durable cross-instance queuing

/**
 * SyncQueue interface: enqueue(key, payload, handler) → Promise<result>
 * - key: deduplication key (e.g. "page:projectId:pageId")
 * - payload: latest data for the operation (merged if enqueued while in-flight)
 * - handler: (payload) => Promise<result>
 */
export function createSyncQueue() {
  return new MergeableSyncQueue();
}

type SyncHandler<TPayload, TResult> = (payload: TPayload) => Promise<TResult> | TResult;

type Deferred<TResult> = {
  promise: Promise<TResult>;
  resolve: (value: TResult | PromiseLike<TResult>) => void;
  reject: (reason?: unknown) => void;
};

type QueueEntry<TPayload = unknown, TResult = unknown> = {
  handler: SyncHandler<TPayload, TResult>;
  inFlight?: Promise<TResult>;
  pendingPayload?: TPayload;
  pendingDeferred?: Deferred<TResult>;
};

export class MergeableSyncQueue {
  private entries = new Map<string, QueueEntry>();

  constructor() {
  }

  enqueue<TPayload, TResult>(
    key: string,
    payload: TPayload,
    handler: SyncHandler<TPayload, TResult>,
  ): Promise<TResult> {
    const entry = (this.entries.get(key) as QueueEntry<TPayload, TResult> | undefined)
      ?? this.createEntry(key, handler);
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

  private createEntry<TPayload, TResult>(
    key: string,
    handler: SyncHandler<TPayload, TResult>,
  ): QueueEntry<TPayload, TResult> {
    const entry: QueueEntry<TPayload, TResult> = {
      handler,
      inFlight: undefined,
      pendingPayload: undefined,
      pendingDeferred: undefined,
    };
    this.entries.set(key, entry as QueueEntry);
    return entry;
  }

  private async run<TPayload, TResult>(
    key: string,
    entry: QueueEntry<TPayload, TResult>,
    payload: TPayload,
  ): Promise<TResult> {
    try {
      return await entry.handler(payload);
    } finally {
      entry.inFlight = undefined;
      this.drain(key, entry);
    }
  }

  private drain<TPayload, TResult>(
    key: string,
    entry: QueueEntry<TPayload, TResult>,
  ): void {
    if (entry.pendingPayload === undefined) {
      this.entries.delete(key);
      return;
    }

    const payload = entry.pendingPayload;
    const pending = entry.pendingDeferred;
    entry.pendingPayload = undefined;
    entry.pendingDeferred = undefined;

    entry.inFlight = this.run(key, entry, payload);
    entry.inFlight.then(pending?.resolve, pending?.reject);
  }
}

function deferred<TResult>(): Deferred<TResult> {
  let resolve: Deferred<TResult>['resolve'] = () => undefined;
  let reject: Deferred<TResult>['reject'] = () => undefined;
  const promise = new Promise<TResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
