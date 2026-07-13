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
    /finally\s*{[\s\S]*message\.command !== 'validate'[\s\S]*webview\.postMessage\(\{ command: 'operationComplete' \}\)/,
  );

  const operationComplete = handler.lastIndexOf("await webview.postMessage({ command: 'operationComplete' });");
  const refreshSidebar = handler.lastIndexOf('activeSidebarProvider?.refresh(webview);');
  assert.notEqual(operationComplete, -1);
  assert.notEqual(refreshSidebar, -1);
  assert.ok(operationComplete < refreshSidebar);
  assert.match(source, /if \(!this\.view \|\| this\.view\.webview === sender\)/);
});
