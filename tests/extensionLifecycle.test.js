const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');

function sourceFragment(startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, startMarker);
  assert.notEqual(end, -1, endMarker);
  return source.slice(start, end);
}

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

test('webview renders every inspect pinmux function as an independent checkbox', () => {
  const pinmuxFunctions = [
    'init_all_pins',
    'init_uart0_pins',
    'init_uart3_pins',
    'init_i2c2_pins',
    'init_i2c3_pins',
    'init_spi1_pins',
    'init_mcan0_pins',
    'init_mcan2_pins',
  ];
  const functionList = { innerHTML: '' };
  const statement = sourceFragment(
    "document.getElementById('functionList').innerHTML = pinmuxFunctions.length",
    "document.getElementById('content').innerHTML = groups.map",
  );

  vm.runInNewContext(statement, {
    document: { getElementById: () => functionList },
    escapeHtml: String,
    pinmuxFunctions,
    selected: new Set(['init_all_pins', 'init_mcan2_pins']),
    ui: { noPinmuxFunctions: 'none' },
  });

  const renderedFunctions = [...functionList.innerHTML.matchAll(/data-function="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(renderedFunctions, pinmuxFunctions);
  assert.equal((functionList.innerHTML.match(/type="checkbox"/g) || []).length, pinmuxFunctions.length);
  assert.doesNotMatch(functionList.innerHTML, /type="radio"/);
  assert.match(functionList.innerHTML, /data-function="init_all_pins" checked/);
  assert.match(functionList.innerHTML, /data-function="init_mcan2_pins" checked/);
  assert.match(
    source,
    /if \(el\.checked\) selected\.add\(el\.dataset\.function\);[\s\S]*else selected\.delete\(el\.dataset\.function\);[\s\S]*config\.project\.pinmux_functions = Array\.from\(selected\);/,
  );
});

test('init_all_pins visibility follows inspect peripheral function membership across groups', () => {
  const peripherals = [
    { instance: 'UART0', functions: ['init_uart0_pins'] },
    { instance: 'UART3', functions: ['init_all_pins'] },
    { instance: 'I2C2', functions: ['init_i2c2_pins'] },
    { instance: 'I2C3', functions: ['init_all_pins'] },
    { instance: 'SPI1', functions: ['init_all_pins'] },
    { instance: 'MCAN0', functions: ['init_all_pins'] },
    { instance: 'MCAN2', functions: ['init_all_pins'] },
  ];
  const config = {
    project: { pinmux_functions: ['init_all_pins'] },
    uart: { UART0: {}, UART3: {} },
    i2c: { I2C2: {}, I2C3: {} },
    spi: { SPI1: {} },
    mcan: { MCAN0: {}, MCAN2: {} },
  };
  const mappingFunction = sourceFragment(
    'function peripheralFunctionsForProject(',
    '\nfunction webviewHtml(',
  );
  const returnExpression = /return ([\s\S]*);\s*}/.exec(mappingFunction);
  assert.ok(returnExpression);
  const peripheralFunctions = vm.runInNewContext(returnExpression[1], {
    project: { inspection: { peripherals } },
  });
  const visibilityFunction = sourceFragment(
    'function peripheralIsVisible(name) {',
    '\n    function render()',
  );
  const candidates = ['UART0', 'UART3', 'I2C2', 'I2C3', 'SPI1', 'MCAN0', 'MCAN2'];
  const context = { candidates, config, peripheralFunctions };
  vm.runInNewContext(`${visibilityFunction}\nvisible = candidates.filter(peripheralIsVisible);`, context);

  assert.deepEqual(Array.from(context.visible), ['UART3', 'I2C3', 'SPI1', 'MCAN0', 'MCAN2']);
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

test('hardware CS fixed warning stays local to the SPI card', () => {
  const filterFunction = sourceFragment(
    'function overallValidationWarnings(warnings) {',
    '\n    function renderValidation()',
  );
  const context = {
    warnings: [
      { code: 'HPM_SPI_HARDWARE_CS_FIXED', message: 'local SPI warning' },
      { code: 'HPM_SPI_CLOCK_ADJUSTED', message: 'overall warning' },
      'legacy warning',
    ],
  };
  vm.runInNewContext(
    `${filterFunction}\nresult = overallValidationWarnings(warnings);`,
    context,
  );

  assert.deepEqual(Array.from(context.result, (item) => (
    typeof item === 'object' ? { ...item } : item
  )), [
    { code: 'HPM_SPI_CLOCK_ADJUSTED', message: 'overall warning' },
    'legacy warning',
  ]);
  assert.match(
    source,
    /const warnings = overallValidationWarnings\(validationWarnings\);/,
  );
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

test('UART status follows RX mode and defaults legacy capabilities to RX/TX DMA', () => {
  const statusFunction = sourceFragment(
    'function uartDmaStatus() {',
    '\n    function card(',
  );
  const ui = {
    uartDmaAutomatic: 'DMA/DMA',
    uartRxInterruptTxDma: 'IRQ/DMA',
  };
  const renderStatus = (rxMode) => {
    const context = {
      capabilities: { uart: { dma: { rx_mode: rxMode } } },
      ui,
    };
    vm.runInNewContext(`${statusFunction}\nstatus = uartDmaStatus();`, context);
    return context.status;
  };

  assert.equal(renderStatus('irq'), 'IRQ/DMA');
  assert.equal(renderStatus('dma'), 'DMA/DMA');
  assert.equal(renderStatus(undefined), 'DMA/DMA');
});

test('SPI hardware chip-select options are deduplicated, sorted, and bound as a number', () => {
  const optionsFunction = sourceFragment(
    'function hardwareChipSelectOptions(pins) {',
    '\n    function card(',
  );
  const optionsContext = {
    pins: {
      CS3: 'PB03',
      CSN: 'PB00',
      CS1: 'PB01',
      CS: 'PB04',
      CS0: 'PA26',
      MOSI: 'PA29',
    },
  };
  vm.runInNewContext(
    `${optionsFunction}\nresult = hardwareChipSelectOptions(pins);`,
    optionsContext,
  );
  assert.deepEqual(Array.from(optionsContext.result, (option) => ({ ...option })), [
    { value: 0, label: 'CS0 — PA26' },
    { value: 1, label: 'CS1 — PB01' },
    { value: 3, label: 'CS3 — PB03' },
  ]);

  assert.deepEqual(
    Array.from((() => {
      const context = { pins: { SCLK: 'PA27', MISO: 'PA28' } };
      vm.runInNewContext(
        `${optionsFunction}\nresult = hardwareChipSelectOptions(pins);`,
        context,
      );
      return context.result;
    })()),
    [],
  );
  assert.match(
    source,
    /if \(hardwareCsOptions\.length\)[\s\S]*ui\.fieldHardwareChipSelect[\s\S]*\.hardware_cs_index/,
  );
  assert.match(
    source,
    /if \(value\.use_gpio_cs\)[\s\S]*else \{[\s\S]*hardwareChipSelectOptions\(value\.pins\)/,
  );

  const setPathFunction = sourceFragment(
    'function setPath(path, raw, isCheckbox) {',
    '\n    document.addEventListener(\'input\'',
  );
  const pathContext = {
    config: { spi: { SPI1: {} } },
    configRevision: 0,
  };
  vm.runInNewContext(
    `${setPathFunction}\nsetPath('spi.SPI1.hardware_cs_index', '2', false);`,
    pathContext,
  );
  assert.equal(pathContext.config.spi.SPI1.hardware_cs_index, 2);
});

test('GPIO chip-select toggle updates pinmux selection without losing init_all_pins', () => {
  const helpers = sourceFragment(
    'function pinmuxFunctionsForPeripheral(name) {',
    '\n    function card(',
  );
  const gpioFunction = 'init_spi1_pins_with_gpio_as_cs';
  const context = {
    peripheralFunctions: {
      spi1: ['init_all_pins', 'init_spi1_pins', gpioFunction],
      mcan0: ['init_all_pins'],
    },
    peripheralFunctionPins: {
      spi1: {
        init_all_pins: { CS0: 'PA26' },
        init_spi1_pins: { CS0: 'PA26' },
        [gpioFunction]: { CS0: 'PA26' },
      },
    },
    config: {
      project: { pinmux_functions: ['init_all_pins'] },
      spi: { SPI1: { use_gpio_cs: false } },
    },
    configRevision: 0,
  };
  vm.runInNewContext(
    `${helpers}\n` +
    `enabled = toggleSpiGpioChipSelect('SPI1', true);\n` +
    'afterEnable = [...config.project.pinmux_functions];\n' +
    `enabledAgain = toggleSpiGpioChipSelect('SPI1', true);\n` +
    'afterEnableAgain = [...config.project.pinmux_functions];\n' +
    `disabled = toggleSpiGpioChipSelect('SPI1', false);\n` +
    'afterDisable = [...config.project.pinmux_functions];',
    context,
  );

  assert.equal(context.enabled, true);
  assert.deepEqual(Array.from(context.afterEnable), ['init_all_pins', gpioFunction]);
  assert.equal(context.enabledAgain, true);
  assert.deepEqual(Array.from(context.afterEnableAgain), ['init_all_pins', gpioFunction]);
  assert.equal(context.disabled, true);
  assert.deepEqual(Array.from(context.afterDisable), ['init_all_pins']);
  assert.equal(context.config.spi.SPI1.use_gpio_cs, false);
  assert.equal(context.configRevision, 3);
});

test('GPIO chip-select toggle moves the override last and does not guess ambiguous functions', () => {
  const helpers = sourceFragment(
    'function pinmuxFunctionsForPeripheral(name) {',
    '\n    function card(',
  );
  const gpioFunction = 'init_spi1_pins_with_gpio_as_cs';
  const reorderContext = {
    peripheralFunctions: {
      spi1: [gpioFunction, 'init_all_pins', 'init_spi1_pins'],
      mcan0: ['init_all_pins'],
    },
    peripheralFunctionPins: {
      spi1: {
        [gpioFunction]: { CS0: 'PA26' },
        init_all_pins: { CS0: 'PA26' },
        init_spi1_pins: { CS0: 'PA26' },
      },
    },
    config: {
      project: { pinmux_functions: [gpioFunction, 'init_all_pins'] },
      spi: { SPI1: { use_gpio_cs: true } },
    },
    configRevision: 0,
  };
  vm.runInNewContext(
    `${helpers}\nresult = toggleSpiGpioChipSelect('SPI1', true);`,
    reorderContext,
  );
  assert.equal(reorderContext.result, true);
  assert.deepEqual(
    Array.from(reorderContext.config.project.pinmux_functions),
    ['init_all_pins', gpioFunction],
  );

  const ambiguousContext = {
    peripheralFunctions: {
      spi1: [
        'init_spi1_pins_with_gpio_as_cs_a',
        'init_spi1_pins_with_gpio_as_cs_b',
      ],
    },
    peripheralFunctionPins: {
      spi1: {
        init_spi1_pins_with_gpio_as_cs_a: { CS0: 'PA26' },
        init_spi1_pins_with_gpio_as_cs_b: { CS0: 'PB10' },
      },
    },
    config: {
      project: { pinmux_functions: [] },
      spi: { SPI1: { use_gpio_cs: false } },
    },
    configRevision: 0,
  };
  vm.runInNewContext(
    `${helpers}\nresult = toggleSpiGpioChipSelect('SPI1', true);`,
    ambiguousContext,
  );
  assert.equal(ambiguousContext.result, false);
  assert.deepEqual(Array.from(ambiguousContext.config.project.pinmux_functions), []);
  assert.equal(ambiguousContext.config.spi.SPI1.use_gpio_cs, false);
  assert.equal(ambiguousContext.configRevision, 0);
});

test('GPIO chip-select toggle restores a verified custom hardware function when needed', () => {
  const helpers = sourceFragment(
    'function pinmuxFunctionsForPeripheral(name) {',
    '\n    function card(',
  );
  const gpioFunction = 'board_spi1_pins_with_gpio_as_cs';
  const hardwareFunction = 'board_spi1_bus_pins';
  const context = {
    peripheralFunctions: {
      spi1: [hardwareFunction, gpioFunction],
    },
    peripheralFunctionPins: {
      spi1: {
        [hardwareFunction]: { CSN: 'PA26', SCLK: 'PA27' },
        [gpioFunction]: { CS0: 'PA26', SCLK: 'PA27' },
      },
    },
    config: {
      project: { pinmux_functions: [gpioFunction] },
      spi: { SPI1: { use_gpio_cs: true } },
    },
    configRevision: 0,
  };
  vm.runInNewContext(
    `${helpers}\nresult = toggleSpiGpioChipSelect('SPI1', false);`,
    context,
  );

  assert.equal(context.result, true);
  assert.deepEqual(Array.from(context.config.project.pinmux_functions), [hardwareFunction]);
  assert.equal(context.config.spi.SPI1.use_gpio_cs, false);
});

test('GPIO chip-select toggle does not mistake SPI data pins for hardware CS', () => {
  const helpers = sourceFragment(
    'function pinmuxFunctionsForPeripheral(name) {',
    '\n    function card(',
  );
  const gpioFunction = 'init_spi1_pins_with_gpio_as_cs';
  const dataFunction = 'init_spi1_data_pins';
  const context = {
    peripheralFunctions: { spi1: [dataFunction, gpioFunction] },
    peripheralFunctionPins: {
      spi1: {
        [dataFunction]: { SCLK: 'PA27', MISO: 'PA28', MOSI: 'PA29' },
        [gpioFunction]: { CS0: 'PA26', SCLK: 'PA27' },
      },
    },
    config: {
      project: { pinmux_functions: [dataFunction, gpioFunction] },
      spi: { SPI1: { use_gpio_cs: true } },
    },
    configRevision: 0,
  };
  vm.runInNewContext(
    `${helpers}\nresult = toggleSpiGpioChipSelect('SPI1', false);`,
    context,
  );

  assert.equal(context.result, false);
  assert.deepEqual(
    Array.from(context.config.project.pinmux_functions),
    [dataFunction, gpioFunction],
  );
  assert.equal(context.config.spi.SPI1.use_gpio_cs, true);
  assert.equal(context.configRevision, 0);
  assert.match(
    source,
    /const changed = parts\.length === 3[\s\S]*render\(\);[\s\S]*if \(changed\) scheduleValidation\(\);/,
  );
});

test('shared GPIO chip-select functions are not changed by one SPI card', () => {
  const helpers = sourceFragment(
    'function pinmuxFunctionsForPeripheral(name) {',
    '\n    function card(',
  );
  const shared = 'init_shared_spi_pins_with_gpio_as_cs';
  const context = {
    peripheralFunctions: {
      spi1: [shared],
      spi2: [shared],
    },
    peripheralFunctionPins: {
      spi1: { [shared]: { CS0: 'PA26' } },
      spi2: { [shared]: { CS0: 'PB10' } },
    },
    config: {
      project: { pinmux_functions: [shared] },
      spi: {
        SPI1: { use_gpio_cs: true },
        SPI2: { use_gpio_cs: true },
      },
    },
    configRevision: 0,
  };
  vm.runInNewContext(
    `${helpers}\nresult = toggleSpiGpioChipSelect('SPI1', false);`,
    context,
  );

  assert.equal(context.result, false);
  assert.deepEqual(Array.from(context.config.project.pinmux_functions), [shared]);
  assert.equal(context.config.spi.SPI1.use_gpio_cs, true);
  assert.equal(context.configRevision, 0);
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
