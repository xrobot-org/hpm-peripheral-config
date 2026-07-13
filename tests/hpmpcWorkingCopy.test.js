const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  disposeHpmpcWorkingCopyWatchers,
  prepareHpmpcForOpen,
} = require('../out/hpmpcWorkingCopy.js');

function document(name, signed = false) {
  return {
    ...(signed ? { clientKey: 'TEST_CLIENT', secretKey: 'TEST_SECRET' } : {}),
    content: { name },
  };
}

function writeDocument(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readName(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')).content.name;
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for working-copy synchronization');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('rebinds a shared signed working copy to the newly opened source hpmpc', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpmpc-working-copy-'));
  const workspaceRoot = path.join(directory, 'project');
  const sourceA = path.join(workspaceRoot, 'boards', 'a', 'pinmux.hpmpc');
  const sourceB = path.join(workspaceRoot, 'boards', 'b', 'pinmux.hpmpc');
  const workingCopy = path.join(directory, '.xrobot-local', 'project', 'pinmux.hpmpc');
  t.after(() => {
    disposeHpmpcWorkingCopyWatchers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  writeDocument(sourceA, document('source-a'));
  writeDocument(sourceB, document('source-b'));
  writeDocument(workingCopy, document('source-a', true));

  assert.equal(prepareHpmpcForOpen(workspaceRoot, sourceA), workingCopy);
  assert.equal(prepareHpmpcForOpen(workspaceRoot, sourceB), workingCopy);
  assert.equal(readName(workingCopy), 'source-b');

  writeDocument(workingCopy, document('working-b-updated', true));
  await waitFor(() => readName(sourceB) === 'working-b-updated');

  assert.equal(readName(sourceA), 'source-a');
  assert.equal(readName(sourceB), 'working-b-updated');
});
