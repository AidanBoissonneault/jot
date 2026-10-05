import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DocumentContent, Project, ProjectPage } from '../src/types/capture.js';

const COOKIE_NAME = 'inkwell_session';
const DEFAULT_WORKER_URL = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const INITIAL_TEXT = [
  'Release smoke — café, 東京, and 🧪 keep their Unicode intact.',
  '',
  'A second paragraph exercises multi-block page content.',
  '',
  'The final paragraph ensures the latest full snapshot wins.',
].join('\n');
const RAPID_EDIT_ONE = [
  'Rapid edit one — naïve text, 東京, and 🧪.',
  '',
  'This first update should be superseded by the next version.',
].join('\n');
const RAPID_EDIT_TWO = [
  'Rapid edit two — the final café 東京 🧪 snapshot.',
  '',
  'The newest version must reach synced after consecutive edits.',
  '',
  'This third paragraph catches truncation and paragraph loss.',
].join('\n');

interface SmokeState {
  schemaVersion: 1;
  runId: string;
  workerUrl: string;
  createdAt: string;
  updatedAt: string;
  project: Project;
  page: ProjectPage;
  lastQueuedVersion: number;
  archivedAt?: string;
}

interface CliOptions {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
}

interface CliDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  output?: (message: string) => void;
}

interface ApiResult {
  [key: string]: unknown;
}

interface SyncStatus {
  status: string;
  localVersion: number;
  syncedVersion: number;
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = command === 'help' && argv[0]?.startsWith('--') ? 0 : 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf('=');
    const name = token.slice(2, separator === -1 ? undefined : separator);
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
    if (name === 'help') {
      flags.add('help');
      continue;
    }
    if (name === 'wait') {
      flags.add(name);
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      throw new Error(`Missing value for --${name}.`);
    }
    values.set(name, value);
    if (inlineValue === undefined) index += 1;
  }

  return { command, values, flags };
}

function option(options: CliOptions, name: string): string | undefined {
  return options.values.get(name);
}

function normalizeLocalWorkerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Worker URL must be a valid loopback URL.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(hostname) ||
    parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
  ) {
    throw new Error('Sync smoke writes are restricted to an HTTP loopback Worker.');
  }

  return parsed.origin;
}

function sessionCookieFromEnvironment(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Set INKWELL_SESSION_COOKIE to the local inkwell_session cookie before running this command.');
  }

  const raw = value.trim().replace(/^cookie\s*:\s*/i, '');
  if (/[\r\n\0]/.test(raw)) throw new Error('INKWELL_SESSION_COOKIE contains invalid characters.');

  const pairs = raw.split(';').map((part) => part.trim()).filter(Boolean);
  const matches = pairs.filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (matches.length > 1) throw new Error('INKWELL_SESSION_COOKIE contains multiple session cookies.');

  let cookiePair: string;
  if (matches.length === 1) {
    cookiePair = matches[0];
  } else if (pairs.length === 1 && !pairs[0].includes('=')) {
    cookiePair = `${COOKIE_NAME}=${pairs[0]}`;
  } else {
    throw new Error(`INKWELL_SESSION_COOKIE must contain the ${COOKIE_NAME} cookie pair.`);
  }

  if (!cookiePair.slice(COOKIE_NAME.length + 1)) {
    throw new Error(`INKWELL_SESSION_COOKIE has an empty ${COOKIE_NAME} value.`);
  }
  return cookiePair;
}

function textToDocument(text: string): DocumentContent {
  return {
    type: 'doc',
    content: text.replace(/\\n/g, '\n').replace(/\\r/g, '\r').split(/\r?\n/).map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

function statePaths(cwd: string, runId: string): { directory: string; stateFile: string; latestFile: string } {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Run ID contains invalid characters.');
  const directory = join(cwd, '.tmp', 'inkwell-sync-smoke');
  return {
    directory,
    stateFile: join(directory, `${runId}.json`),
    latestFile: join(directory, 'latest.txt'),
  };
}

async function saveState(cwd: string, state: SmokeState): Promise<void> {
  const paths = statePaths(cwd, state.runId);
  state.updatedAt = new Date().toISOString();
  await mkdir(paths.directory, { recursive: true });
  const nextStateFile = `${paths.stateFile}.pending`;
  const nextLatestFile = `${paths.latestFile}.pending`;
  await writeFile(nextStateFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(nextStateFile, paths.stateFile);
  await writeFile(nextLatestFile, `${state.runId}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(nextLatestFile, paths.latestFile);
}

async function loadState(cwd: string, runIdOption?: string): Promise<SmokeState> {
  const directory = join(cwd, '.tmp', 'inkwell-sync-smoke');
  let runId = runIdOption;
  if (!runId) {
    try {
      runId = (await readFile(join(directory, 'latest.txt'), 'utf8')).trim();
    } catch {
      throw new Error('No smoke run state found. Run the create command first.');
    }
  }

  const paths = statePaths(cwd, runId);
  let state: SmokeState;
  try {
    state = JSON.parse(await readFile(paths.stateFile, 'utf8')) as SmokeState;
  } catch {
    throw new Error(`Unable to read smoke run state for ${runId}.`);
  }
  if (
    state?.schemaVersion !== 1 ||
    state.runId !== runId ||
    typeof state.workerUrl !== 'string' ||
    !state.project?.id || !state.page?.id ||
    state.page.projectId !== state.project.id
  ) {
    throw new Error(`Smoke run state for ${runId} is incomplete.`);
  }
  state.workerUrl = normalizeLocalWorkerUrl(state.workerUrl);
  return state;
}

function asApiResult(value: unknown): ApiResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Worker returned an invalid JSON response.');
  }
  return value as ApiResult;
}

function assertApiSuccess(result: ApiResult, operation: string): void {
  if (result.status === 'error' || typeof result.error === 'string') {
    throw new Error(`${operation} was rejected by the Worker.`);
  }
}

function responseVersion(result: ApiResult): number {
  const version = Number(result.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('Worker did not return a queued sync version.');
  }
  return version;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
  return parsed;
}

function readSyncStatus(result: ApiResult): SyncStatus {
  const localVersion = Number(result.localVersion ?? 0);
  const syncedVersion = Number(result.syncedVersion ?? 0);
  return {
    status: typeof result.status === 'string' ? result.status : 'unknown',
    localVersion: Number.isFinite(localVersion) ? localVersion : 0,
    syncedVersion: Number.isFinite(syncedVersion) ? syncedVersion : 0,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function makeApiClient(workerUrl: string, cookie: string, fetchImpl: typeof fetch) {
  return async (method: 'GET' | 'POST', route: string, body?: unknown): Promise<ApiResult> => {
    const headers = new Headers({ cookie });
    const request: RequestInit = { method, headers, redirect: 'error', signal: AbortSignal.timeout(20_000) };
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      request.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetchImpl(new URL(route, `${workerUrl}/`), request);
    } catch {
      throw new Error(`${method} ${route.split('?')[0]} could not reach the local Worker.`);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error(`${method} ${route.split('?')[0]} returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(`${method} ${route.split('?')[0]} failed with HTTP ${response.status}.`);
    }
    return asApiResult(parsed);
  };
}

function createProjectAndPage(text: string, workerUrl: string): SmokeState {
  const now = new Date().toISOString();
  const suffix = randomBytes(4).toString('hex');
  const runId = `${now.replace(/[^0-9]/g, '').slice(0, 14)}-${suffix}`;
  const projectId = randomUUID();
  const projectName = `Release smoke ${now.slice(0, 16)} ${suffix}`;
  const project: Project = {
    id: projectId,
    name: projectName,
    status: 'active',
    category: 'Test',
    createdAt: now,
    updatedAt: now,
    stateContent: { type: 'doc', content: [] },
    tags: ['Test'],
  };
  const page: ProjectPage = {
    id: randomUUID(),
    projectId,
    title: `${projectName} page`,
    status: 'active',
    content: textToDocument(text),
    createdAt: now,
    updatedAt: now,
    localSyncVersion: 1,
  };
  return {
    schemaVersion: 1,
    runId,
    workerUrl,
    createdAt: now,
    updatedAt: now,
    project,
    page,
    lastQueuedVersion: 1,
  };
}

async function createRun(
  cwd: string,
  workerUrl: string,
  api: ReturnType<typeof makeApiClient>,
  output: (message: string) => void,
  initialText?: string,
): Promise<SmokeState> {
  const state = createProjectAndPage(initialText ?? INITIAL_TEXT, workerUrl);
  await saveState(cwd, state);
  output(`Prepared Test smoke run ${state.runId}; recovery state saved before Worker writes.`);

  const projectResult = await api('POST', '/sync/project', { project: state.project });
  assertApiSuccess(projectResult, 'Project creation');
  if (projectResult.status !== 'saved') throw new Error('Worker did not confirm project creation.');

  const queuedResult = await api('POST', '/sync/push', { page: state.page, project: state.project });
  assertApiSuccess(queuedResult, 'Page creation');
  if (queuedResult.queued !== true) throw new Error('Worker did not confirm page queueing.');
  state.lastQueuedVersion = responseVersion(queuedResult);
  await saveState(cwd, state);

  output(`Created Test project ${state.project.name} (${state.project.id}) and page ${state.page.id}; run ${state.runId}, sync v${state.lastQueuedVersion}.`);
  return state;
}

async function editRun(
  cwd: string,
  state: SmokeState,
  api: ReturnType<typeof makeApiClient>,
  output: (message: string) => void,
  text: string,
): Promise<number> {
  if (state.page.status === 'archived' || state.project.status === 'archived') {
    throw new Error('This smoke run is archived; create a new run before editing.');
  }

  const targetVersion = Math.max(state.page.localSyncVersion ?? 0, state.lastQueuedVersion) + 1;
  state.page = {
    ...state.page,
    content: textToDocument(text),
    updatedAt: new Date().toISOString(),
    localSyncVersion: targetVersion,
  };
  state.lastQueuedVersion = targetVersion;
  await saveState(cwd, state);

  const result = await api('POST', '/sync/push', { page: state.page, project: state.project });
  assertApiSuccess(result, 'Page edit');
  if (result.queued !== true) throw new Error('Worker did not confirm page edit queueing.');
  const queuedVersion = responseVersion(result);
  if (queuedVersion < targetVersion) throw new Error('Worker returned an older sync version than this edit.');
  state.lastQueuedVersion = queuedVersion;
  await saveState(cwd, state);

  output(`Queued page ${state.page.id} edit at sync v${queuedVersion}.`);
  return queuedVersion;
}

async function getStatus(
  state: SmokeState,
  api: ReturnType<typeof makeApiClient>,
): Promise<SyncStatus> {
  const query = new URLSearchParams({ pageId: state.page.id });
  const result = await api('GET', `/sync/status?${query.toString()}`);
  assertApiSuccess(result, 'Sync status');
  return readSyncStatus(result);
}

async function waitForSync(
  state: SmokeState,
  api: ReturnType<typeof makeApiClient>,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<SyncStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: SyncStatus = { status: 'unknown', localVersion: 0, syncedVersion: 0 };
  do {
    last = await getStatus(state, api);
    if (last.status === 'failed') {
      throw new Error(`Worker reported sync failure at local v${last.localVersion}, synced v${last.syncedVersion}.`);
    }
    if (last.status === 'synced' && last.localVersion >= state.lastQueuedVersion && last.syncedVersion >= state.lastQueuedVersion) {
      return last;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(pollIntervalMs, remaining));
  } while (Date.now() < deadline);

  throw new Error(
    `Sync v${state.lastQueuedVersion} did not reach synced before timeout (last status ${last.status}, local v${last.localVersion}, synced v${last.syncedVersion}).`,
  );
}

async function archiveRun(
  cwd: string,
  state: SmokeState,
  api: ReturnType<typeof makeApiClient>,
  output: (message: string) => void,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const targetVersion = Math.max(state.page.localSyncVersion ?? 0, state.lastQueuedVersion) + 1;
  state.page = {
    ...state.page,
    status: 'archived',
    updatedAt: new Date().toISOString(),
    localSyncVersion: targetVersion,
  };
  state.lastQueuedVersion = targetVersion;
  await saveState(cwd, state);

  const pageResult = await api('POST', '/sync/push', { page: state.page, project: state.project });
  assertApiSuccess(pageResult, 'Page archival');
  if (pageResult.queued !== true) throw new Error('Worker did not confirm page archival queueing.');
  state.lastQueuedVersion = responseVersion(pageResult);
  await saveState(cwd, state);
  const pageStatus = await waitForSync(state, api, timeoutMs, pollIntervalMs);

  state.project = {
    ...state.project,
    status: 'archived',
    updatedAt: new Date().toISOString(),
  };
  await saveState(cwd, state);
  const projectResult = await api('POST', '/sync/project', { project: state.project });
  assertApiSuccess(projectResult, 'Project archival');
  if (projectResult.status !== 'saved') throw new Error('Worker did not confirm project archival.');
  state.archivedAt = new Date().toISOString();
  await saveState(cwd, state);

  output(`Archived page ${state.page.id} at synced v${pageStatus.syncedVersion} and project ${state.project.id} in Notion.`);
}

function helpText(): string {
  return [
    'Inkwell local sync smoke driver',
    '',
    'Commands:',
    '  create                         Create a unique Test project and page',
    '  edit --text <text>              Queue a new page snapshot (\\n becomes a paragraph break)',
    '  status [--wait]                 Read sync status or wait for the latest queued version',
    '  archive                         Archive the page, wait for sync, then archive its project',
    '  smoke                           Create, rapidly edit twice, verify sync, and archive',
    '',
    'Options:',
    `  --base-url <url>                Loopback Worker URL (default ${DEFAULT_WORKER_URL})`,
    '  --run-id <id>                   Select a prior run instead of the latest run',
    `  --timeout-ms <ms>               Sync wait limit (default ${DEFAULT_TIMEOUT_MS})`,
    `  --poll-interval-ms <ms>         Status polling interval (default ${DEFAULT_POLL_INTERVAL_MS})`,
    '',
    'Set INKWELL_SESSION_COOKIE to the local inkwell_session cookie pair. The CLI never prints or stores it.',
    'Run state is stored under .tmp/inkwell-sync-smoke/ for recovery after an interrupted run.',
  ].join('\n');
}

export async function runSmokeCli(argv: string[], dependencies: CliDependencies = {}): Promise<void> {
  const options = parseArgs(argv);
  const output = dependencies.output ?? ((message: string) => console.log(message));
  if (options.command === 'help' || options.flags.has('help')) {
    output(helpText());
    return;
  }

  const knownCommands = new Set(['create', 'edit', 'update', 'status', 'archive', 'smoke']);
  if (!knownCommands.has(options.command)) throw new Error(`Unknown command: ${options.command}. Run help for usage.`);

  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const cookie = sessionCookieFromEnvironment((dependencies.env ?? process.env).INKWELL_SESSION_COOKIE);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = parsePositiveInteger(option(options, 'timeout-ms'), DEFAULT_TIMEOUT_MS, 'timeout-ms');
  const pollIntervalMs = parsePositiveInteger(option(options, 'poll-interval-ms'), DEFAULT_POLL_INTERVAL_MS, 'poll-interval-ms');

  let state: SmokeState | undefined;
  let workerUrl: string;
  if (options.command === 'create' || options.command === 'smoke') {
    workerUrl = normalizeLocalWorkerUrl(option(options, 'base-url') ?? DEFAULT_WORKER_URL);
  } else {
    state = await loadState(cwd, option(options, 'run-id'));
    workerUrl = state.workerUrl;
    const requestedUrl = option(options, 'base-url');
    if (requestedUrl && normalizeLocalWorkerUrl(requestedUrl) !== workerUrl) {
      throw new Error('The requested Worker URL does not match the URL saved for this smoke run.');
    }
  }

  const api = makeApiClient(workerUrl, cookie, fetchImpl);
  if (options.command === 'create') {
    await createRun(cwd, workerUrl, api, output, option(options, 'text'));
    return;
  }
  if (options.command === 'smoke') {
    state = await createRun(cwd, workerUrl, api, output);
    await editRun(cwd, state, api, output, RAPID_EDIT_ONE);
    await editRun(cwd, state, api, output, RAPID_EDIT_TWO);
    const latest = await waitForSync(state, api, timeoutMs, pollIntervalMs);
    output(`Latest edit reached synced v${latest.syncedVersion} (local v${latest.localVersion}).`);
    await archiveRun(cwd, state, api, output, timeoutMs, pollIntervalMs);
    return;
  }

  if (!state) throw new Error('Smoke run state was not loaded.');
  if (options.command === 'edit' || options.command === 'update') {
    const text = option(options, 'text');
    if (text === undefined) throw new Error('Pass --text with the new page content.');
    await editRun(cwd, state, api, output, text);
    return;
  }
  if (options.command === 'status') {
    const status = options.flags.has('wait')
      ? await waitForSync(state, api, timeoutMs, pollIntervalMs)
      : await getStatus(state, api);
    output(`Page ${state.page.id}: ${status.status}, local v${status.localVersion}, synced v${status.syncedVersion}; expected v${state.lastQueuedVersion}.`);
    return;
  }

  await archiveRun(cwd, state, api, output, timeoutMs, pollIntervalMs);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runSmokeCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'The sync smoke command failed.';
    console.error(message);
    process.exitCode = 1;
  });
}
