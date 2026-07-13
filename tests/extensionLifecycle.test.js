const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');

test('webview operations do not wait for notification dismissal before clearing busy state', () => {
  assert.doesNotMatch(
    source,
    /await\s+vscode\.window\.show(?:Information|Warning|Error)Message/,
  );

  const handlerStart = source.indexOf('function bindWebviewMessages(');
  const handlerEnd = source.indexOf('async function openConfigUi(', handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);

  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(
    handler,
    /finally\s*{[\s\S]*message\.command !== 'validate'[\s\S]*message\.command !== 'reloadFromHpmpc'[\s\S]*webview\.postMessage\(\{ command: 'operationComplete' \}\)/,
  );

  const operationComplete = handler.lastIndexOf("await webview.postMessage({ command: 'operationComplete' });");
  const refreshSidebar = handler.lastIndexOf('activeSidebarProvider?.refresh(webview);');
  assert.notEqual(operationComplete, -1);
  assert.notEqual(refreshSidebar, -1);
  assert.ok(operationComplete < refreshSidebar);
  assert.match(source, /if \(!this\.view \|\| this\.view\.webview === sender\)/);
});

test('hpmpc changes reload every open webview without a manual toolbar control', () => {
  assert.doesNotMatch(source, /id="refresh"/);
  assert.doesNotMatch(source, /getElementById\('refresh'\)/);
  assert.doesNotMatch(source, /message\.command === 'refresh'/);
  assert.match(source, /const operationButtons = \['save', 'generate', 'openPinmux', 'openProjectGenerator'\]/);

  assert.match(source, /fs\.watchFile\(resolved, \{ interval: 300, persistent: false \}/);
  assert.match(source, /hpmpcReloadTask\.schedule\(\)/);
  assert.match(source, /webview\.postMessage\(\{ command: 'hpmpcChanged' \}\)/);
  assert.match(source, /vscode\.postMessage\(\{ command: 'reloadFromHpmpc', config \}\)/);
  assert.match(source, /message\.command === 'projectReloaded'/);
  assert.match(source, /normalizeConfig\(currentProject, message\.config\)/);

  assert.match(source, /activeWebviews\.set\(webview, messageDisposable\)/);
  assert.match(source, /activeWebviews\.delete\(webview\)/);
  assert.match(source, /messageDisposable\.dispose\(\)/);
  assert.match(source, /panel\.onDidDispose\(unbind/);
  assert.match(source, /retainContextWhenHidden: true/);
  assert.match(source, /createFileSystemWatcher\('\*\*\/\*\.hpmpc'\)/);
});

test('keeps the command-palette refresh entry as a compatibility fallback', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(
    manifest.contributes.commands.some((command) => command.command === 'hpmPeripheral.refreshConfig'),
    true,
  );
  assert.match(source, /register\(context, 'hpmPeripheral\.refreshConfig', refreshConfig\)/);
});
