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

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for working-copy synchronization');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('repository hpmpc remains canonical when a signed working copy is newer', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpmpc-working-copy-'));
  const workspaceRoot = path.join(directory, 'project');
  const source = path.join(workspaceRoot, 'boards', 'test', 'pinmux.hpmpc');
  const workingCopy = path.join(
    directory,
    '.xrobot-local',
    'project',
    'boards',
    'test',
    'pinmux.hpmpc',
  );
  t.after(() => {
    disposeHpmpcWorkingCopyWatchers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  writeDocument(source, document('repository-canonical'));
  writeDocument(workingCopy, document('stale-signed-copy', true));
  const oldTime = new Date(Date.now() - 60_000);
  const newTime = new Date();
  fs.utimesSync(source, oldTime, oldTime);
  fs.utimesSync(workingCopy, newTime, newTime);

  assert.equal(prepareHpmpcForOpen(workspaceRoot, source), workingCopy);

  assert.equal(readName(source), 'repository-canonical');
  assert.equal(readName(workingCopy), 'repository-canonical');
  const signed = JSON.parse(fs.readFileSync(workingCopy, 'utf8'));
  assert.equal(signed.clientKey, 'TEST_CLIENT');
  assert.equal(signed.secretKey, 'TEST_SECRET');
});

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

  const unchangedMtime = fs.statSync(workingCopy).mtime;
  writeDocument(workingCopy, document('working-b-updated', true));
  fs.utimesSync(workingCopy, unchangedMtime, unchangedMtime);
  await waitFor(() => readName(sourceB) === 'working-b-updated');

  assert.equal(readName(sourceA), 'source-a');
  assert.equal(readName(sourceB), 'working-b-updated');
});

test('removes the temporary file when atomic working-copy replacement fails', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpmpc-working-copy-'));
  const workspaceRoot = path.join(directory, 'project');
  const source = path.join(workspaceRoot, 'boards', 'test', 'pinmux.hpmpc');
  const workingCopy = path.join(
    directory,
    '.xrobot-local',
    'project',
    'boards',
    'test',
    'pinmux.hpmpc',
  );
  const originalRenameSync = fs.renameSync;
  t.after(() => {
    fs.renameSync = originalRenameSync;
    disposeHpmpcWorkingCopyWatchers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  writeDocument(source, document('repository-canonical'));
  writeDocument(workingCopy, document('stale-signed-copy', true));
  fs.renameSync = (oldPath, newPath) => {
    if (path.resolve(newPath) === path.resolve(workingCopy)) {
      const error = new Error('simulated atomic rename failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalRenameSync(oldPath, newPath);
  };

  assert.throws(
    () => prepareHpmpcForOpen(workspaceRoot, source),
    /simulated atomic rename failure/,
  );
  assert.equal(readName(source), 'repository-canonical');
  assert.equal(readName(workingCopy), 'stale-signed-copy');
  assert.deepEqual(
    fs.readdirSync(path.dirname(workingCopy)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});
