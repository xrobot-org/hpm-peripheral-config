const assert = require('node:assert/strict');
const test = require('node:test');

const { LatestRequestGuard } = require('../out/latestRequestGuard.js');

function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('keeps the newest watcher binding when requests complete B then A', async () => {
  const guard = new LatestRequestGuard();
  const releaseA = barrier();
  const releaseB = barrier();
  let watched;

  const bind = async (path, gate) => {
    const generation = guard.begin();
    await gate.promise;
    if (guard.isCurrent(generation)) watched = path;
  };

  const requestA = bind('A.hpmpc', releaseA);
  const requestB = bind('B.hpmpc', releaseB);
  releaseB.release();
  await requestB;
  releaseA.release();
  await requestA;

  assert.equal(watched, 'B.hpmpc');
});
