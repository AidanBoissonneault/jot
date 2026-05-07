import assert from 'node:assert/strict';
import test from 'node:test';
import { MergeableSyncQueue } from '../src/syncQueue.js';

test('MergeableSyncQueue coalesces rapid saves for one page to the latest pending payload', async () => {
  const queue = new MergeableSyncQueue();
  const firstRun = deferred();
  const calls = [];
  const handler = async (payload) => {
    calls.push(payload);

    if (calls.length === 1) {
      await firstRun.promise;
    }

    return { savedTitle: payload.title };
  };

  const first = queue.enqueue('page:project-1:page-1', { title: 'First' }, handler);
  const second = queue.enqueue('page:project-1:page-1', { title: 'Second' }, handler);
  const third = queue.enqueue('page:project-1:page-1', { title: 'Third' }, handler);

  assert.equal(second, third);
  assert.deepEqual(calls, [{ title: 'First' }]);

  firstRun.resolve();

  assert.deepEqual(await first, { savedTitle: 'First' });
  assert.deepEqual(await second, { savedTitle: 'Third' });
  assert.deepEqual(await third, { savedTitle: 'Third' });
  assert.deepEqual(calls, [{ title: 'First' }, { title: 'Third' }]);
});

test('MergeableSyncQueue isolates different page and project keys', async () => {
  const queue = new MergeableSyncQueue();
  const blocked = deferred();
  const calls = [];

  const first = queue.enqueue('page:project-1:page-1', 'blocked', async (payload) => {
    calls.push(['page-1', payload]);
    await blocked.promise;
    return payload;
  });
  const second = queue.enqueue('page:project-1:page-2', 'free', async (payload) => {
    calls.push(['page-2', payload]);
    return payload;
  });
  const third = queue.enqueue('project:project-1', 'project', async (payload) => {
    calls.push(['project', payload]);
    return payload;
  });

  assert.equal(await second, 'free');
  assert.equal(await third, 'project');
  assert.deepEqual(calls, [
    ['page-1', 'blocked'],
    ['page-2', 'free'],
    ['project', 'project'],
  ]);

  blocked.resolve();
  assert.equal(await first, 'blocked');
});

test('MergeableSyncQueue resolves superseded callers with final merged result', async () => {
  const queue = new MergeableSyncQueue();
  const firstRun = deferred();
  let calls = 0;
  const handler = async (payload) => {
    calls += 1;

    if (calls === 1) {
      await firstRun.promise;
    }

    return payload;
  };

  const first = queue.enqueue('page:project-1:page-1', { version: 1 }, handler);
  const second = queue.enqueue('page:project-1:page-1', { version: 2 }, handler);
  const third = queue.enqueue('page:project-1:page-1', { version: 3 }, handler);

  firstRun.resolve();

  assert.deepEqual(await first, { version: 1 });
  assert.deepEqual(await second, { version: 3 });
  assert.deepEqual(await third, { version: 3 });
});

test('MergeableSyncQueue does not poison a key after a rejected in-flight task', async () => {
  const queue = new MergeableSyncQueue();
  let calls = 0;
  const handler = async (payload) => {
    calls += 1;

    if (calls === 1) {
      throw new Error('temporary failure');
    }

    return payload;
  };

  await assert.rejects(
    queue.enqueue('page:project-1:page-1', { version: 1 }, handler),
    /temporary failure/,
  );

  assert.deepEqual(
    await queue.enqueue('page:project-1:page-1', { version: 2 }, handler),
    { version: 2 },
  );
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
