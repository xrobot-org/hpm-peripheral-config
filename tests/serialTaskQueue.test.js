const assert = require('node:assert/strict');
const test = require('node:test');

const { SerialTaskQueue } = require('../out/serialTaskQueue.js');

function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('serializes mutation tasks across an asynchronous barrier', async () => {
  const queue = new SerialTaskQueue();
  const firstBarrier = barrier();
  const firstEntered = barrier();
  let active = 0;
  let maximumActive = 0;
  const order = [];

  const task = (name, waitFor) => queue.run(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push(`${name}:start`);
    if (name === 'first') firstEntered.release();
    if (waitFor) await waitFor;
    order.push(`${name}:end`);
    active -= 1;
  });

  const first = task('first', firstBarrier.promise);
  await firstEntered.promise;
  const second = task('second');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ['first:start']);
  firstBarrier.release();
  await Promise.all([first, second]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('continues with the next mutation after a rejected task', async () => {
  const queue = new SerialTaskQueue();
  await assert.rejects(queue.run(async () => {
    throw new Error('expected failure');
  }), /expected failure/);
  assert.equal(await queue.run(async () => 'next'), 'next');
});
