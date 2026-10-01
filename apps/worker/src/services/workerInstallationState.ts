/** @file Resolves authenticated installations and serializes per-installation state updates. */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { AuthService, AuthSessionResult } from '../auth.js';
import type { ConnectedWorkerStore, Identifier, WorkerEnv, WorkerStore } from '../types.js';

type ApiContext = Context<{ Bindings: WorkerEnv }>;

/** State accessors required to resolve an authenticated Notion installation. */
interface WorkerInstallationStateDependencies {
  auth: AuthService;
  cookieName: string;
  readInkwellSyncState: (installationId: Identifier) => Promise<WorkerStore>;
  readStore: () => WorkerStore;
}

/** Shared isolate locks prevent concurrent writes to one installation. */
const installationMutationLocks = new Map<string, Promise<unknown>>();

/** Creates session, connected-store, and installation-lock operations. */
export function createWorkerInstallationState({
  auth,
  cookieName,
  readInkwellSyncState,
  readStore,
}: WorkerInstallationStateDependencies) {
  /** Reads the application session cookie from an API request. */
  async function getInkwellSession(context: ApiContext): Promise<AuthSessionResult | null> {
    return auth.getCustomSession(getCookie(context, cookieName));
  }

  /** Requires an application session or sets an unauthorized response. */
  async function requireInkwellSession(context: ApiContext): Promise<AuthSessionResult | null> {
    const session = await getInkwellSession(context);

    if (!session) {
      context.res = context.json(
        { error: 'Unauthorized', message: 'Log in to Inkwell first.' },
        401,
      );
      return null;
    }

    return session;
  }

  /** Resolves active Notion credentials and normalized state for an API request. */
  async function requireConnectedStore(context: ApiContext): Promise<ConnectedWorkerStore> {
    const session = await getInkwellSession(context);
    if (!session) {
      throw new HTTPException(401, {
        res: context.json({
          error: 'Unauthorized',
          message: 'Log in to Inkwell first.',
        }, 401),
      });
    }

    const [store, installation] = await Promise.all([
      readStore(),
      auth.getActiveInstallationWithTokens(session.user.id),
    ]);

    if (!installation?.tokens?.access_token || !installation.id) {
      throw new HTTPException(409, {
        res: context.json({
          error: 'NotionNotConnected',
          message: 'Notion is not connected.',
        }, 409),
      });
    }

    const syncState = await readInkwellSyncState(installation.id);
    return {
      ...store,
      ...syncState,
      installationId: installation.id,
      tokens: installation.tokens,
    };
  }

  /** Serializes one mutating operation behind prior work for the same installation. */
  function withInstallationLock<Result>(
    lockKey: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = installationMutationLocks.get(lockKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    let tracked: Promise<unknown>;
    const releaseLock = () => {
      if (installationMutationLocks.get(lockKey) === tracked) {
        installationMutationLocks.delete(lockKey);
      }
    };
    // Consume both outcomes on the lock-tracking promise while returning the
    // original promise so callers still observe their operation's failure.
    tracked = current.then(releaseLock, releaseLock);

    installationMutationLocks.set(lockKey, tracked);
    return current;
  }

  /** Reloads installation state under its lock before a mutation runs. */
  async function withFreshInstallationStore<Result>(
    store: WorkerStore,
    operation: (freshStore: WorkerStore) => Promise<Result>,
  ): Promise<Result> {
    const lockKey = store.installationId ? String(store.installationId) : 'local';
    return withInstallationLock(lockKey, async () => {
      const freshStore = await freshConnectedStore(store);
      if (!store.installationId) {
        return operation(freshStore);
      }

      const installation = await auth.getActiveInstallationWithTokensById(store.installationId);
      if (!installation?.tokens?.access_token) {
        const error = new HTTPException(409, { message: 'Notion is no longer connected.' });
        Object.assign(error, { code: 'installation_revoked' });
        throw error;
      }

      return operation({ ...freshStore, tokens: installation.tokens });
    });
  }

  /** Reloads persisted state and preserves the active installation credentials. */
  async function freshConnectedStore(store: WorkerStore): Promise<WorkerStore> {
    if (!store.installationId) return store;

    const [localStore, syncState] = await Promise.all([
      readStore(),
      readInkwellSyncState(store.installationId),
    ]);
    return {
      ...localStore,
      ...syncState,
      installationId: store.installationId,
      tokens: store.tokens,
    };
  }

  return {
    freshConnectedStore,
    getInkwellSession,
    requireConnectedStore,
    requireInkwellSession,
    withFreshInstallationStore,
  };
}
