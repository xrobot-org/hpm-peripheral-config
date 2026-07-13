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
    /finally\s*{[\s\S]*message\.command !== 'validate'[\s\S]*message\.command !== 'reloadFromHpmpc'[\s\S]*webview\.postMessage\(\{ command: 'operationComplete', requestId: message\.requestId \}\)/,
  );

  const operationComplete = handler.lastIndexOf("await webview.postMessage({ command: 'operationComplete', requestId: message.requestId });");
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
  assert.doesNotMatch(source, /const operationButtons =/);

  assert.match(source, /fs\.watchFile\(resolved, \{ interval: 300, persistent: false \}/);
  assert.match(source, /hpmpcReloadTask\.schedule\(\)/);
  assert.match(source, /webview\.postMessage\(\{ command: 'hpmpcChanged' \}\)/);
  assert.match(
    source,
    /function requestHpmpcReload\(\)[\s\S]*const requestId = \+\+reloadRequestId;[\s\S]*command: 'reloadFromHpmpc', config, requestId, revision: configRevision/,
  );
  assert.match(source, /message\.command === 'projectReloaded'/);
  assert.match(
    source,
    /message\.requestId !== reloadRequestId\) return;[\s\S]*message\.revision !== configRevision\) return;/,
  );
  assert.match(source, /requestId: message\.requestId,[\s\S]*revision: message\.revision,/);

  assert.match(source, /activeWebviews\.set\(webview, messageDisposable\)/);
  assert.match(source, /activeWebviews\.delete\(webview\)/);
  assert.match(source, /messageDisposable\.dispose\(\)/);
  assert.match(source, /panel\.onDidDispose\(unbind/);
  assert.match(source, /retainContextWhenHidden: true/);
  assert.match(source, /createFileSystemWatcher\('\*\*\/\*\.hpmpc'\)/);
  assert.match(source, /workspaceHpmpcWatcher\.onDidChange\(onWorkspaceHpmpcChanged\)/);
});

test('mutation commands and webview writes share one extension-level queue', () => {
  const refreshStart = source.indexOf('async function refreshConfig(');
  const generateStart = source.indexOf('async function generateBoardGlue(');
  const projectMetaStart = source.indexOf('function projectMeta(', generateStart);
  const refresh = source.slice(refreshStart, generateStart);
  const generate = source.slice(generateStart, projectMetaStart);
  assert.match(refresh, /projectMutationQueue\.run\(async \(\) => \{[\s\S]*inspectCurrentProject\(\)[\s\S]*validateProject/);
  assert.match(generate, /projectMutationQueue\.run\(async \(\) => \{[\s\S]*inspectCurrentProject\(\)[\s\S]*validateProject[\s\S]*generateProject/);

  const handlerStart = source.indexOf('function bindWebviewMessages(');
  const handlerEnd = source.indexOf('async function openConfigUi(', handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(
    handler,
    /message\.command === 'save'[\s\S]*message\.command === 'generate'[\s\S]*projectMutationQueue\.run\(async \(\) => \{[\s\S]*inspectCurrentProject\(\)/,
  );
  assert.match(handler, /command === 'save'[\s\S]*validateProject\(currentProject, requestedConfig, true\)/);
  assert.match(handler, /generateProject\(currentProject, requestedConfig\)/);
});

test('save proves the write completed before any saved state is published', () => {
  const handlerStart = source.indexOf('function bindWebviewMessages(');
  const saveStart = source.indexOf("if (command === 'save')", handlerStart);
  const generateStart = source.indexOf(
    'const validation = await validateProject(currentProject, requestedConfig);',
    saveStart,
  );
  const save = source.slice(saveStart, generateStart);

  const completionCheck = save.indexOf('savedNormalizedConfig(validation)');
  const postValidation = save.indexOf('webview.postMessage');
  const notification = save.indexOf('showWarningMessage');
  const savedLog = save.indexOf('output.appendLine(`Saved ${target}`)');
  const refresh = save.indexOf('refreshSidebar = true');
  for (const index of [completionCheck, postValidation, notification, savedLog, refresh]) {
    assert.notEqual(index, -1);
  }
  assert.ok(completionCheck < postValidation);
  assert.ok(completionCheck < notification);
  assert.ok(completionCheck < savedLog);
  assert.ok(completionCheck < refresh);
});

test('busy operations freeze the whole form and invalidate pending validation', () => {
  assert.match(source, /const busyDisabledState = new Map\(\)/);
  assert.match(source, /document\.querySelectorAll\('input, select, textarea, button'\)/);
  assert.match(source, /busyDisabledState\.set\(control, control\.disabled\)/);
  assert.match(source, /control\.disabled = true/);
  assert.match(source, /control\.disabled = wasDisabled/);
  assert.match(
    source,
    /if \(busy && !operationBusy\) \{[\s\S]*clearTimeout\(validationTimer\);[\s\S]*validationRequestId \+= 1;/,
  );
  assert.match(source, /renderValidation\(\);\s*syncBusyControls\(\);/);
  assert.equal((source.match(/if \(operationBusy\) return;/g) || []).length, 2);
});

test('watcher rebinding ignores stale reverse-order inspection results', () => {
  const start = source.indexOf('async function rebindHpmpcWatcher(');
  const end = source.indexOf('function peripheralConfigArgument(', start);
  const rebind = source.slice(start, end);
  assert.match(rebind, /const generation = watcherBindingGuard\.begin\(\)/);
  assert.match(
    rebind,
    /await inspectCurrentProject\(\);[\s\S]*if \(!watcherBindingGuard\.isCurrent\(generation\)\)[\s\S]*watchHpmpcFile/,
  );
  assert.match(
    rebind,
    /catch[\s\S]*if \(watcherBindingGuard\.isCurrent\(generation\)\)[\s\S]*clearHpmpcWatcher\(\)/,
  );
});

test('webview discards stale validation responses', () => {
  assert.match(source, /let validationRequestId = 0;/);
  assert.match(
    source,
    /const requestId = \+\+validationRequestId;[\s\S]*const revision = configRevision;[\s\S]*command: 'validate', config, requestId, revision/,
  );
  assert.match(
    source,
    /message\.command === 'validation'[\s\S]*message\.requestId !== validationRequestId\)[\s\S]*return;/,
  );
  assert.match(source, /command: 'validation',[\s\S]*requestId: message\.requestId,/);
  assert.match(source, /message\.revision !== configRevision\) return;/);
  assert.match(source, /configRevision \+= 1;[\s\S]*validationRequestId \+= 1;/);
  assert.match(source, /message\.revision !== configRevision\)[\s\S]*requestHpmpcReload\(\);/);
});

test('extension delegates project data, validation, and generation to the HPM CLI', () => {
  assert.match(source, /from '\.\/hpmCli';/);
  assert.match(source, /from '\.\/hpmProtocol';/);
  for (const retiredModule of ['hpmProject', 'clockConfig', 'configFile', 'generator']) {
    assert.doesNotMatch(source, new RegExp(`from ['"]\\./${retiredModule}['"]`));
  }

  assert.match(source, /cliClient\(\)\.inspect\(\{/);
  assert.match(source, /cliClient\(\)\.validate\(\{/);
  assert.match(source, /cliClient\(\)\.generate\(\{/);
  assert.match(source, /project\.inspection\.pinmux_functions/);
  assert.match(source, /project\.inspection\.clock_sources/);
  assert.match(source, /project\.inspection\.peripherals/);
  assert.match(source, /\[\.\.\.new Set\(peripheral\.functions\)\]/);
  assert.doesNotMatch(source, /`init_\$\{peripheral\.instance/);
  assert.match(source, /project\.inspection\.capabilities/);
  assert.match(source, /validation\.normalized_config/);
  assert.match(source, /capabilities\.uart\.parity/);
  assert.match(source, /capabilities\.i2c\.bus_rates/);
  assert.match(source, /capabilities\.spi\.modes/);
  assert.match(source, /capabilities\.mcan\.modes/);
  assert.doesNotMatch(source, /\[5, 6, 7, 8\]\.map/);

  const handlerStart = source.indexOf('function bindWebviewMessages(');
  const handlerEnd = source.indexOf('async function openConfigUi(', handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /validateProject\(currentProject, requestedConfig, true\)/);
  assert.match(
    handler,
    /message\.command === 'generate'[\s\S]*validateProject\(currentProject, requestedConfig\);[\s\S]*generateProject\(currentProject, requestedConfig\)/,
  );
  assert.doesNotMatch(handler, /\bnormalizeConfig\(/);
  assert.doesNotMatch(handler, /\bwriteConfig\(/);
  assert.doesNotMatch(handler, /\bwriteLibxrConfig\(/);

  assert.doesNotMatch(source, /function normalizeSpiConfig\(/);
  assert.doesNotMatch(source, /function recalculateSpiClock\(/);
  assert.doesNotMatch(source, /function configurationErrors\(/);
});

test('CLI setup and compatibility failures use localized blocking guidance', () => {
  assert.match(source, /error instanceof HpmCliNotFoundError/);
  assert.match(source, /t\('error\.cliNotFound'/);
  assert.match(source, /error instanceof HpmCliProtocolError/);
  assert.match(source, /t\('error\.cliProtocol', \{ protocol: PROTOCOL_VERSION \}\)/);
  assert.match(source, /isGeneratorVersionAtLeast\(version\)/);
  assert.match(source, /t\('warning\.generatorVersionUnknown'/);
  assert.match(source, /t\('warning\.generatorVersionOld'/);
  assert.match(source, /void vscode\.window\.showWarningMessage\(warning\)/);
});

test('protocol failures suppress stdout content and sanitize bounded stderr excerpts', () => {
  const start = source.indexOf('function appendProtocolErrorStreams(');
  const end = source.indexOf('async function invokeCli<', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = source.slice(start, end);

  assert.match(handler, /Buffer\.byteLength\(error\.stdout, 'utf8'\)/);
  assert.match(handler, /byte\(s\) suppressed/);
  assert.doesNotMatch(handler, /safeOutputExcerpt\(error\.stdout\)/);
  assert.doesNotMatch(handler, /appendLine\(error\.stdout/);
  assert.match(handler, /safeOutputExcerpt\(error\.stderr\)/);

  const resultLoggerStart = source.indexOf('function appendCliResult<');
  const resultLoggerEnd = source.indexOf('function diagnosticsError(', resultLoggerStart);
  const resultLogger = source.slice(resultLoggerStart, resultLoggerEnd);
  assert.match(resultLogger, /safeOutputExcerpt\(result\.stderr\)/);
  assert.doesNotMatch(resultLogger, /appendLine\(result\.stderr/);
  assert.match(resultLogger, /\.\.\.result\.envelope\.errors, \.\.\.result\.envelope\.warnings/);
  assert.match(resultLogger, /safeOutputExcerpt\(diagnostic\.message\)/);
  assert.doesNotMatch(resultLogger, /appendLine\(diagnostic\.message/);
});

test('keeps the command-palette refresh entry as a compatibility fallback', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(
    manifest.contributes.commands.some((command) => command.command === 'hpmPeripheral.refreshConfig'),
    true,
  );
  assert.match(source, /register\(context, 'hpmPeripheral\.refreshConfig', refreshConfig\)/);
});
