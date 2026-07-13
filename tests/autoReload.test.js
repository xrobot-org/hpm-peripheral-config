const assert = require('node:assert/strict');
const test = require('node:test');

const { DebouncedTask } = require('../out/autoReload.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await delay(5);
  }
}

test('debounces repeated hpmpc change events', async () => {
  let calls = 0;
  const task = new DebouncedTask(() => {
    calls += 1;
  }, 20);

  task.schedule();
  task.schedule();
  task.schedule();
  await delay(60);

  assert.equal(calls, 1);
  task.dispose();
});

test('runs once more when hpmpc changes during reload', async () => {
  let calls = 0;
  let releaseFirst;
  const task = new DebouncedTask(async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
  }, 0);

  task.schedule();
  await waitFor(() => calls === 1);
  task.schedule();
  task.schedule();
  releaseFirst();
  await waitFor(() => calls === 2);
  await delay(20);

  assert.equal(calls, 2);
  task.dispose();
});

test('dispose cancels a pending reload', async () => {
  let calls = 0;
  const task = new DebouncedTask(() => {
    calls += 1;
  }, 20);

  task.schedule();
  task.dispose();
  await delay(50);

  assert.equal(calls, 0);
});
