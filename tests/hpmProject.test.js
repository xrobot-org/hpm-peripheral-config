const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { discoverProject } = require('../out/hpmProject.js');

test('an explicit missing hpmpc path does not fall back to another board', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const boardDir = path.join(root, 'boards', 'other');
  fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(path.join(boardDir, 'pinmux.hpmpc'), JSON.stringify({ content: {} }));

  assert.throws(
    () => discoverProject(root, 'boards/selected/pinmux.hpmpc'),
    /Pinmux file not found/,
  );
});
