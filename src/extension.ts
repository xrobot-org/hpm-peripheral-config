import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  assertValidConfig,
  configurationErrors,
  configurationWarnings,
  loadOrCreateConfig,
  normalizeConfig,
  writeConfig,
  writeLibxrConfig,
  type PeripheralConfig,
} from './configFile';
import { DebouncedTask } from './autoReload';
import { clockSourcesForSoc } from './clockConfig';
import { generate } from './generator';
import { disposeHpmpcWorkingCopyWatchers, prepareHpmpcForOpen } from './hpmpcWorkingCopy';
import { discoverProject } from './hpmProject';
import { currentLocale, setLocale, t, webviewMessages } from './i18n';

setLocale(vscode.env.language);

const output = vscode.window.createOutputChannel(t('extension.title'));
let activeSidebarProvider: HpmPeripheralViewProvider | undefined;
const activeWebviews = new Map<vscode.Webview, vscode.Disposable>();
let watchedHpmpcPath: string | undefined;

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error(t('error.workspaceRequired'));
  }
  return folder.uri.fsPath;
}

function extensionConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('hpmPeripheral');
}

function configPath(root: string): string {
  const configured = extensionConfig().get<string>('configPath', 'hpm_peripherals.yaml');
  return path.isAbsolute(configured) ? configured : path.join(root, configured);
}

function libxrConfigPath(root: string): string {
  return path.join(root, 'User', 'libxr_config.yaml');
}

function configuredHpmpcPath(): string {
  return extensionConfig().get<string>('hpmpcPath', '');
}

function workspaceRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function discoverCurrentProject() {
  return discoverProject(workspaceRoot(), configuredHpmpcPath());
}

function normalizedFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyHpmpcChanged(filePath: string): Promise<void> {
  output.appendLine(`[HPM Pinmux] detected update: ${filePath}`);
  await Promise.all(
    [...activeWebviews.keys()].map((webview) => webview.postMessage({ command: 'hpmpcChanged' })),
  );
}

function watchHpmpcFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (watchedHpmpcPath && normalizedFilePath(watchedHpmpcPath) === normalizedFilePath(resolved)) {
    return;
  }
  if (watchedHpmpcPath) {
    fs.unwatchFile(watchedHpmpcPath, onHpmpcFileChanged);
  }
  watchedHpmpcPath = resolved;
  fs.watchFile(resolved, { interval: 300, persistent: false }, onHpmpcFileChanged);
}

function clearHpmpcWatcher(): void {
  if (watchedHpmpcPath) {
    fs.unwatchFile(watchedHpmpcPath, onHpmpcFileChanged);
    watchedHpmpcPath = undefined;
  }
}

function onHpmpcFileChanged(current: fs.Stats, previous: fs.Stats): void {
  if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
    return;
  }
  hpmpcReloadTask.schedule();
}

async function reloadHpmpcViews(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const project = discoverCurrentProject();
      watchHpmpcFile(project.hpmpcPath);
      await notifyHpmpcChanged(project.hpmpcPath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await wait(120);
      }
    }
  }
  throw lastError;
}

const hpmpcReloadTask = new DebouncedTask(
  reloadHpmpcViews,
  350,
  (error) => output.appendLine(`[HPM Pinmux] automatic reload failed: ${error instanceof Error ? error.message : String(error)}`),
);

function rebindHpmpcWatcher(reloadViews = false): void {
  try {
    const project = discoverCurrentProject();
    watchHpmpcFile(project.hpmpcPath);
    if (reloadViews) {
      hpmpcReloadTask.schedule(0);
    }
  } catch {
    clearHpmpcWatcher();
  }
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.appendLine(`$ ${command} ${args.join(' ')}`);
    output.appendLine(`cwd: ${cwd}`);
    const child = childProcess.spawn(command, args, { cwd, shell: false });
    child.stdout.on('data', (data: Buffer | string) => output.append(data.toString()));
    child.stderr.on('data', (data: Buffer | string) => output.append(data.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      output.appendLine(`[exit] ${code ?? -1}`);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(t('error.commandExited', { command, code: code ?? -1 })));
      }
    });
  });
}

async function runLibxrGenerator(projectRoot: string, hpmpcPath: string): Promise<void> {
  if (!extensionConfig().get<boolean>('runLibxrGenerator', true)) {
    return;
  }
  await runCommand(
    'xr_hpm_cfg',
    [
      '-d',
      '.',
      '-i',
      `./${workspaceRelative(projectRoot, hpmpcPath)}`,
      '--config-output',
      './.config.yaml',
      '-o',
      './User/app_main.cpp',
      '--hw-cntr',
      '--libxr-config',
      './User/libxr_config.yaml',
    ],
    projectRoot,
  );
}

async function refreshConfig(): Promise<void> {
  const project = discoverCurrentProject();
  const target = configPath(project.root);
  const config = loadOrCreateConfig(target, project);
  writeConfig(target, config);
  await notifyHpmpcChanged(project.hpmpcPath);
  output.appendLine(`Refreshed ${target}`);
  output.show(true);
  void vscode.window.showInformationMessage(t('notification.configRefreshed', { file: path.basename(target) }));
}

async function generateBoardGlue(): Promise<void> {
  const project = discoverCurrentProject();
  const target = configPath(project.root);
  const config = loadOrCreateConfig(target, project);
  assertValidConfig(config, project);
  writeLibxrConfig(libxrConfigPath(project.root), config);
  generate(project, config);
  await runLibxrGenerator(project.root, project.hpmpcPath);
  output.appendLine(`Generated board glue from ${target}`);
  output.appendLine(`Updated ${libxrConfigPath(project.root)}`);
  output.appendLine(`Updated ${project.pinmuxC}`);
  output.appendLine(`Updated ${project.pinmuxH}`);
  output.appendLine(`Updated ${project.boardC}`);
  output.appendLine(`Updated ${project.boardH}`);
  output.show(true);
  void vscode.window.showInformationMessage(t('notification.boardGlueGenerated'));
}

function projectMeta(project: ReturnType<typeof discoverCurrentProject>): string {
  return `${project.boardName} / ${project.socName} / ${workspaceRelative(project.root, project.hpmpcPath)}`;
}

function peripheralFunctionsForProject(
  project: ReturnType<typeof discoverCurrentProject>,
): Record<string, string[]> {
  return Object.fromEntries(
    project.peripherals.map((peripheral) => [
      peripheral.instance.toLowerCase(),
      [...new Set([...peripheral.functions, `init_${peripheral.instance.toLowerCase()}_pins`])],
    ]),
  );
}

function webviewHtml(config: PeripheralConfig, project: ReturnType<typeof discoverCurrentProject>, compact = false): string {
  const nonce = String(Date.now());
  const serialized = JSON.stringify(config).replace(/</g, '\\u003c');
  const serializedUi = JSON.stringify(webviewMessages()).replace(/</g, '\\u003c');
  const locale = currentLocale();
  const pinmuxFunctions = JSON.stringify(project.pinmuxFunctions).replace(/</g, '\\u003c');
  const clockSources = JSON.stringify(clockSourcesForSoc(project.socName, project.boardName)).replace(/</g, '\\u003c');
  const peripheralFunctions = JSON.stringify(peripheralFunctionsForProject(project)).replace(/</g, '\\u003c');
  const initialErrors = JSON.stringify(configurationErrors(config, project)).replace(/</g, '\\u003c');
  const initialWarnings = JSON.stringify(configurationWarnings(config, project)).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>${escapeHtmlText(t('webview.title'))}</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: ${compact ? '8px' : '16px'}; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h1 { font-size: ${compact ? '15px' : '20px'}; margin: 0 0 12px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid transparent; border-radius: 4px; padding: 6px 12px; cursor: pointer; font-weight: 500; }
    button.secondary { background: color-mix(in srgb, var(--vscode-textLink-foreground) 16%, var(--vscode-button-secondaryBackground)); color: var(--vscode-textLink-foreground); border-color: var(--vscode-textLink-foreground); }
    button.secondary:hover { background: color-mix(in srgb, var(--vscode-textLink-foreground) 26%, var(--vscode-button-secondaryBackground)); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(${compact ? '220px' : '280px'}, 1fr)); gap: 12px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-sideBar-background); }
    .card > summary { cursor: pointer; padding: 10px 12px; user-select: none; }
    .card[open] > summary { border-bottom: 1px solid var(--vscode-panel-border); }
    .card-body { padding: 4px 12px 12px; }
    .title { font-weight: 600; display: inline-flex; justify-content: space-between; align-items: center; gap: 8px; width: calc(100% - 18px); }
    label { display: grid; grid-template-columns: ${compact ? '95px' : '130px'} 1fr; align-items: center; gap: 8px; margin: 6px 0; }
    input, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; }
    .pins { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 8px; word-break: break-all; }
    .clock-status { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 6px 0; }
    .warning { color: var(--vscode-editorWarning-foreground); font-size: 12px; margin: 6px 0; }
    .validation { border-left: 3px solid var(--vscode-focusBorder); padding: 8px 10px; margin: 10px 0 14px; background: var(--vscode-textBlockQuote-background); }
    .validation.ok { border-left-color: var(--vscode-testing-iconPassed); }
    .validation.error { border-left-color: var(--vscode-testing-iconFailed); }
    .validation.warning { border-left-color: var(--vscode-editorWarning-foreground); }
    .validation-title { font-weight: 600; margin-bottom: 4px; }
    .validation ul { margin: 4px 0 0; padding-left: 20px; }
    button:disabled { opacity: 0.55; cursor: wait; }
    details.section { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 0; margin: 12px 0; }
    details.section summary { cursor: pointer; padding: 10px; user-select: none; }
    details.section summary .summary-row { display: inline-flex; justify-content: space-between; gap: 12px; width: calc(100% - 18px); }
    details.section summary .summary-count { color: var(--vscode-descriptionForeground); font-weight: 400; }
    details.section[open] .section-body { border-top: 1px solid var(--vscode-panel-border); padding: 10px; }
    .function-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 4px 12px; }
    .function-list label { display: flex; gap: 6px; align-items: center; margin: 2px 0; }
    .empty { color: var(--vscode-descriptionForeground); margin: 0; }
  </style>
</head>
<body>
  <h1>${escapeHtmlText(t('webview.title'))}</h1>
  <div id="meta"></div>
  <div id="validation" class="validation"></div>
  <details class="section">
    <summary><span class="summary-row"><span>${escapeHtmlText(t('webview.pinmuxFunctions'))}</span><span class="summary-count" id="functionHint"></span></span></summary>
    <div class="section-body function-list" id="functionList"></div>
  </details>
  <div class="toolbar">
    <button id="save">${escapeHtmlText(t('webview.saveYaml'))}</button>
    <button id="generate">${escapeHtmlText(t('webview.saveGenerate'))}</button>
    <button class="secondary" id="openPinmux">${escapeHtmlText(t('webview.openPinmux'))}</button>
    <button class="secondary" id="openProjectGenerator">${escapeHtmlText(t('webview.openProjectGenerator'))}</button>
  </div>
  <div id="content"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const config = ${serialized};
    const ui = ${serializedUi};
    const numberFormatter = new Intl.NumberFormat('${locale}');
    let pinmuxFunctions = ${pinmuxFunctions};
    let clockSources = ${clockSources};
    let peripheralFunctions = ${peripheralFunctions};
    let validationErrors = ${initialErrors};
    let validationWarnings = ${initialWarnings};
    let clockSourceHz = Object.fromEntries(clockSources.map(source => [source.id, source.hz]));
    const groups = [
      ['uart', 'UART'],
      ['i2c', 'I2C'],
      ['spi', 'SPI'],
      ['mcan', 'MCAN / FDCAN'],
    ];
    const operationButtons = ['save', 'generate', 'openPinmux', 'openProjectGenerator'];
    const sectionOpenState = new Map();
    const cardOpenState = new Map();
    document.getElementById('meta').textContent = config.project.board + ' / ' + config.project.soc + ' / ' + config.project.hpmpc;
    if (!Array.isArray(config.project.pinmux_functions)) config.project.pinmux_functions = [];
    function input(type, path, value, extra = '') {
      const checked = type === 'checkbox' && value ? 'checked' : '';
      return '<input type="' + type + '" data-path="' + path + '" value="' + value + '" ' + checked + ' ' + extra + '>';
    }
    function select(path, value) {
      return '<select data-path="' + path + '"><option value="can"' + (value === 'can' ? ' selected' : '') + '>CAN</option><option value="fdcan"' + (value === 'fdcan' ? ' selected' : '') + '>FDCAN</option></select>';
    }
    function field(label, html) {
      return '<label><span>' + escapeHtml(label) + '</span>' + html + '</label>';
    }
    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
    function formatMessage(key, params = {}) {
      const template = ui[key] || key;
      return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder);
    }
    function countMessage(one, many, count) {
      return formatMessage(count === 1 ? one : many, { count });
    }
    function renderValidation() {
      const element = document.getElementById('validation');
      const selected = new Set(config.project.pinmux_functions || []);
      const selectionHasPeripheral = !selected.size || Object.values(peripheralFunctions)
        .some(functions => functions.some(name => selected.has(name)));
      const warnings = selectionHasPeripheral
        ? validationWarnings
        : [...validationWarnings, ui.noCommunicationPeripheral];
      if (validationErrors.length) {
        element.className = 'validation error';
        element.innerHTML = '<div class="validation-title">' +
          escapeHtml(countMessage('errorsBlockedOne', 'errorsBlockedMany', validationErrors.length)) + '</div><ul>' +
          validationErrors.map(item => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>';
      } else if (warnings.length) {
        element.className = 'validation warning';
        element.innerHTML = '<div class="validation-title">' +
          escapeHtml(countMessage('validLimitationsOne', 'validLimitationsMany', warnings.length)) + '</div><ul>' +
          warnings.map(item => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>';
      } else {
        element.className = 'validation ok';
        element.innerHTML = '<div class="validation-title">' + escapeHtml(ui.configurationValid) + '</div>';
      }
    }
    function setBusy(busy) {
      for (const id of operationButtons) document.getElementById(id).disabled = busy;
    }
    let validationTimer;
    function scheduleValidation() {
      clearTimeout(validationTimer);
      validationTimer = setTimeout(() => vscode.postMessage({ command: 'validate', config }), 250);
    }
    function enumSelect(path, value, options) {
      return '<select data-path="' + path + '">' + options.map(option => {
        const selected = value === option.value ? ' selected' : '';
        return '<option value="' + option.value + '"' + selected + '>' + escapeHtml(option.label) + '</option>';
      }).join('') + '</select>';
    }
    function getPath(path) {
      const parts = path.split('.');
      let target = config;
      for (const part of parts) target = target[part];
      return target;
    }
    function getParentPath(path) {
      const parts = path.split('.');
      let target = config;
      for (const part of parts.slice(0, -1)) target = target[part];
      return target;
    }
    function normalizeSpiConfig(value) {
      if (!['LOW', 'HIGH'].includes(value.clock_polarity)) value.clock_polarity = 'LOW';
      if (!['EDGE_1', 'EDGE_2'].includes(value.clock_phase)) value.clock_phase = 'EDGE_1';
      value.spi_mode = (value.clock_polarity === 'HIGH' ? 2 : 0) + (value.clock_phase === 'EDGE_2' ? 1 : 0);
      value.cs_active_low = value.cs_active_low !== false;
    }
    function applySpiMode(value) {
      const mode = Number(value.spi_mode);
      value.clock_polarity = mode >= 2 ? 'HIGH' : 'LOW';
      value.clock_phase = mode % 2 ? 'EDGE_2' : 'EDGE_1';
    }
    function recalculateSpiClock(value) {
      if (!value.auto_clock) {
        const sourceHz = clockSourceHz[value.clock_source] || 0;
        value.peripheral_clock_hz = Math.floor(sourceHz / Math.max(1, Number(value.clock_divider) || 1));
      }
      if (value.auto_clock) {
        let best;
        for (const source of clockSources) {
          for (let divider = 1; divider <= 256; divider++) {
            const clockHz = Math.floor(source.hz / divider);
            if (clockHz <= 0 || clockHz > 200000000) continue;
            for (const prescaler of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
              if (clockHz % prescaler !== 0) continue;
              const actual = Math.floor(clockHz / prescaler);
              if (actual <= 0 || actual > value.sclk_hz) continue;
              if (!best || actual > best.actual || (actual === best.actual && clockHz < best.clockHz)) {
                best = { source: source.id, divider, clockHz, prescaler, actual };
              }
            }
          }
        }
        if (best) {
          value.clock_source = best.source;
          value.clock_divider = best.divider;
          value.peripheral_clock_hz = best.clockHz;
          value.prescaler = 'DIV_' + best.prescaler;
          value.actual_sclk_hz = best.actual;
        }
      } else {
        for (const prescaler of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
          if (value.peripheral_clock_hz % prescaler !== 0) continue;
          const actual = Math.floor(value.peripheral_clock_hz / prescaler);
          if (actual <= value.sclk_hz) {
            value.prescaler = 'DIV_' + prescaler;
            value.actual_sclk_hz = actual;
            break;
          }
        }
      }
    }
    function clockFields(group, name, value) {
      const prefix = group + '.' + name + '.';
      let html = field(ui.fieldAutoClock, input('checkbox', prefix + 'auto_clock', value.auto_clock));
      if (!value.auto_clock) {
        html += field(ui.fieldClockSource, enumSelect(prefix + 'clock_source', value.clock_source,
          clockSources.map(source => ({ value: source.id, label: source.id + ' (' + source.hz + ' Hz)' }))));
        html += field(ui.fieldClockDivider, input('number', prefix + 'clock_divider', value.clock_divider, 'min="1" max="256"'));
      }
      html += '<div class="clock-status">' + escapeHtml(formatMessage('peripheralClock', {
        hz: numberFormatter.format(Number(value.peripheral_clock_hz || 0)),
      })) + '</div>';
      return html;
    }
    function card(group, name, value) {
      const cardKey = group + '.' + name;
      const isOpen = cardOpenState.has(cardKey) ? cardOpenState.get(cardKey) : Boolean(value.enabled);
      let html = '<details class="card" data-card="' + escapeHtml(cardKey) + '"' + (isOpen ? ' open' : '') +
        '><summary><span class="title"><span>' + escapeHtml(name) + '</span>' + input('checkbox', group + '.' + name + '.enabled', value.enabled) + '</span></summary><div class="card-body">';
      if (group === 'uart') {
        html += field(ui.fieldBaudrate, input('number', group + '.' + name + '.baudrate', value.baudrate, 'min="200"'));
        html += field(ui.fieldParity, enumSelect(group + '.' + name + '.parity', value.parity, [
          { value: 'NO_PARITY', label: ui.optionParityNone },
          { value: 'EVEN', label: ui.optionParityEven },
          { value: 'ODD', label: ui.optionParityOdd },
        ]));
        html += field(ui.fieldDataBits, enumSelect(group + '.' + name + '.data_bits', value.data_bits, [5, 6, 7, 8].map(value => ({ value, label: String(value) }))));
        html += field(ui.fieldStopBits, enumSelect(group + '.' + name + '.stop_bits', value.stop_bits, [1, 2].map(value => ({ value, label: String(value) }))));
        html += field(ui.fieldRxBufferSize, input('number', group + '.' + name + '.rx_buffer_size', value.rx_buffer_size, 'min="1"'));
        html += field(ui.fieldTxBufferSize, input('number', group + '.' + name + '.tx_buffer_size', value.tx_buffer_size, 'min="2"'));
        html += field(ui.fieldTxQueueSize, input('number', group + '.' + name + '.tx_queue_size', value.tx_queue_size, 'min="1"'));
        html += clockFields(group, name, value);
        html += '<div class="clock-status">' + escapeHtml(ui.uartDmaAutomatic) + '</div>';
      } else if (group === 'i2c') {
        html += field(ui.fieldBusHz, enumSelect(group + '.' + name + '.bus_hz', value.bus_hz, [
          { value: 100000, label: ui.optionI2cStandard },
          { value: 400000, label: ui.optionI2cFast },
          { value: 1000000, label: ui.optionI2cFastPlus },
        ]));
        html += field(ui.fieldAddressMode, enumSelect(group + '.' + name + '.address_mode', value.address_mode, [
          { value: '7bit', label: ui.option7BitMaster },
          { value: '10bit', label: ui.option10BitMaster },
        ]));
        html += clockFields(group, name, value);
        html += '<div class="clock-status">' + escapeHtml(ui.i2cRuntimeDma) + '</div>';
      } else if (group === 'spi') {
        normalizeSpiConfig(value);
        recalculateSpiClock(value);
        html += field(ui.fieldSclkHz, input('number', group + '.' + name + '.sclk_hz', value.sclk_hz, 'min="1"'));
        html += field(ui.fieldBufferSize, input('number', group + '.' + name + '.buffer_size', value.buffer_size, 'min="1"'));
        html += field(ui.fieldDoubleBuffer, input('checkbox', group + '.' + name + '.double_buffer', value.double_buffer));
        html += field(ui.fieldSpiMode, enumSelect(group + '.' + name + '.spi_mode', value.spi_mode, [
          { value: 0, label: 'Mode 0 (CPOL 0, CPHA 0)' },
          { value: 1, label: 'Mode 1 (CPOL 0, CPHA 1)' },
          { value: 2, label: 'Mode 2 (CPOL 1, CPHA 0)' },
          { value: 3, label: 'Mode 3 (CPOL 1, CPHA 1)' },
        ]));
        html += field(ui.fieldClockPolarity, enumSelect(group + '.' + name + '.clock_polarity', value.clock_polarity, [
          { value: 'LOW', label: ui.optionPolarityLow },
          { value: 'HIGH', label: ui.optionPolarityHigh },
        ]));
        html += field(ui.fieldClockPhase, enumSelect(group + '.' + name + '.clock_phase', value.clock_phase, [
          { value: 'EDGE_1', label: ui.optionPhaseFirst },
          { value: 'EDGE_2', label: ui.optionPhaseSecond },
        ]));
        if (value.use_gpio_cs) {
          html += field(ui.fieldCsActiveLow, input('checkbox', group + '.' + name + '.cs_active_low', value.cs_active_low));
        } else {
          html += '<div class="warning">' + escapeHtml(ui.hardwareCsFixed) + '</div>';
        }
        html += clockFields(group, name, value);
        html += '<div class="clock-status">' + escapeHtml(formatMessage('actualSclk', {
          hz: numberFormatter.format(Number(value.actual_sclk_hz || 0)),
          prescaler: value.prescaler,
        })) + '</div>';
        html += field(ui.fieldUseGpioCs, input('checkbox', group + '.' + name + '.use_gpio_cs', value.use_gpio_cs));
      } else if (group === 'mcan') {
        html += field(ui.fieldMode, select(group + '.' + name + '.mode', value.mode));
        html += field(ui.fieldBitrate, input('number', group + '.' + name + '.bitrate', value.bitrate, 'min="1"'));
        html += field(ui.fieldSamplePoint, input('number', group + '.' + name + '.sample_point', value.sample_point ?? 0.875, 'min="0.5" max="0.95" step="0.001"'));
        html += field(ui.fieldQueueSize, input('number', group + '.' + name + '.queue_size', value.queue_size ?? 8, 'min="1"'));
        html += field(ui.fieldLoopback, input('checkbox', group + '.' + name + '.loopback', value.loopback));
        html += field(ui.fieldListenOnly, input('checkbox', group + '.' + name + '.listen_only', value.listen_only));
        html += field(ui.fieldOneShot, input('checkbox', group + '.' + name + '.one_shot', value.one_shot));
        if (value.mode === 'fdcan') {
          html += field(ui.fieldDataBitrate, input('number', group + '.' + name + '.data_bitrate', value.data_bitrate ?? 2000000, 'min="1"'));
          html += field(ui.fieldDataSamplePoint, input('number', group + '.' + name + '.data_sample_point', value.data_sample_point ?? 0.75, 'min="0.5" max="0.95" step="0.001"'));
          html += field(ui.fieldBrs, input('checkbox', group + '.' + name + '.brs', value.brs ?? true));
          html += field(ui.fieldEsi, input('checkbox', group + '.' + name + '.esi', value.esi ?? false));
        }
        html += clockFields(group, name, value);
      }
      html += '<div class="pins">' + escapeHtml(formatMessage('pins', {
        pins: JSON.stringify(value.pins || {}),
      })) + '</div></div></details>';
      return html;
    }
    function peripheralIsVisible(name) {
      const selected = new Set(config.project.pinmux_functions || []);
      if (!selected.size) return true;
      return (peripheralFunctions[name.toLowerCase()] || []).some(name => selected.has(name));
    }
    function render() {
      for (const element of document.querySelectorAll('details.section[data-group]')) {
        sectionOpenState.set(element.dataset.group, element.open);
      }
      for (const element of document.querySelectorAll('details.card[data-card]')) {
        cardOpenState.set(element.dataset.card, element.open);
      }
      const selected = new Set(config.project.pinmux_functions || []);
      document.getElementById('functionHint').textContent = selected.size
        ? countMessage('selectedOne', 'selectedMany', selected.size)
        : ui.allFunctions;
      document.getElementById('functionList').innerHTML = pinmuxFunctions.length
        ? pinmuxFunctions.map(name => {
            const checked = selected.has(name) ? 'checked' : '';
            return '<label><input type="checkbox" data-function="' + escapeHtml(name) + '" ' + checked + '><span>' + escapeHtml(name) + '</span></label>';
          }).join('')
        : '<p class="empty">' + escapeHtml(ui.noPinmuxFunctions) + '</p>';
      document.getElementById('content').innerHTML = groups.map(([key, title]) => {
        const entries = Object.entries(config[key] || {}).filter(([name]) => peripheralIsVisible(name));
        const enabledCount = entries.filter(([, value]) => value.enabled).length;
        const countText = entries.length
          ? formatMessage('enabledDetected', { enabled: enabledCount, detected: entries.length })
          : ui.none;
        const isOpen = sectionOpenState.has(key) ? sectionOpenState.get(key) : enabledCount > 0;
        const open = isOpen ? ' open' : '';
        const body = entries.length
          ? '<div class="grid">' + entries.map(([name, value]) => card(key, name, value)).join('') + '</div>'
          : '<p class="empty">' + escapeHtml(formatMessage('noGroupPinmux', { group: title })) + '</p>';
        return '<details class="section" data-group="' + key + '"' + open + '><summary><span class="summary-row"><span>' + escapeHtml(title) + '</span><span class="summary-count">' + escapeHtml(countText) + '</span></span></summary><div class="section-body">' + body + '</div></details>';
      }).join('');
      renderValidation();
    }
    function setPath(path, raw, isCheckbox) {
      const parts = path.split('.');
      let target = config;
      for (const part of parts.slice(0, -1)) target = target[part];
      const key = parts[parts.length - 1];
      if (isCheckbox) target[key] = Boolean(raw);
      else if (!Number.isNaN(Number(raw)) && raw !== '') target[key] = Number(raw);
      else target[key] = raw;
    }
    document.addEventListener('input', event => {
      const el = event.target;
      if (!el.dataset || !el.dataset.path) return;
      setPath(el.dataset.path, el.type === 'checkbox' ? el.checked : el.value, el.type === 'checkbox');
    });
    document.addEventListener('click', event => {
      if (event.target.closest('summary') && event.target.matches('input, select')) event.stopPropagation();
    });
    document.addEventListener('change', event => {
      const el = event.target;
      if (el.dataset && el.dataset.function) {
        const selected = new Set(config.project.pinmux_functions || []);
        if (el.checked) selected.add(el.dataset.function);
        else selected.delete(el.dataset.function);
        config.project.pinmux_functions = Array.from(selected);
        document.getElementById('functionHint').textContent = selected.size
          ? countMessage('selectedOne', 'selectedMany', selected.size)
          : ui.allFunctions;
        scheduleValidation();
        return;
      }
      if (!el.dataset || !el.dataset.path) return;
      setPath(el.dataset.path, el.type === 'checkbox' ? el.checked : el.value, el.type === 'checkbox');
      if (el.dataset.path.endsWith('.spi_mode')) {
        const spi = getParentPath(el.dataset.path);
        applySpiMode(spi);
      } else if (el.dataset.path.endsWith('.clock_polarity') || el.dataset.path.endsWith('.clock_phase')) {
        const spi = getParentPath(el.dataset.path);
        normalizeSpiConfig(spi);
      }
      if (
        el.dataset.path.endsWith('.mode') ||
        el.dataset.path.endsWith('.enabled') ||
        el.dataset.path.endsWith('.auto_clock') ||
        el.dataset.path.endsWith('.use_gpio_cs') ||
        el.dataset.path.endsWith('.clock_source') ||
        el.dataset.path.endsWith('.clock_divider') ||
        el.dataset.path.endsWith('.sclk_hz') ||
        el.dataset.path.endsWith('.spi_mode') ||
        el.dataset.path.endsWith('.clock_polarity') ||
        el.dataset.path.endsWith('.clock_phase')
      ) {
        render();
      }
      scheduleValidation();
    });
    function runOperation(command, includeConfig = true) {
      setBusy(true);
      vscode.postMessage(includeConfig ? { command, config } : { command });
    }
    document.getElementById('save').onclick = () => runOperation('save');
    document.getElementById('generate').onclick = () => runOperation('generate');
    document.getElementById('openPinmux').onclick = () => runOperation('openPinmux', false);
    document.getElementById('openProjectGenerator').onclick = () => runOperation('openProjectGenerator', false);
    window.addEventListener('message', event => {
      const message = event.data || {};
      if (message.command === 'hpmpcChanged') {
        vscode.postMessage({ command: 'reloadFromHpmpc', config });
      } else if (message.command === 'projectReloaded') {
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, message.config || {});
        pinmuxFunctions = message.pinmuxFunctions || [];
        clockSources = message.clockSources || [];
        peripheralFunctions = message.peripheralFunctions || {};
        clockSourceHz = Object.fromEntries(clockSources.map(source => [source.id, source.hz]));
        validationErrors = message.errors || [];
        validationWarnings = message.warnings || [];
        document.getElementById('meta').textContent = message.meta || '';
        render();
      } else if (message.command === 'validation') {
        if (message.config) {
          for (const key of Object.keys(config)) delete config[key];
          Object.assign(config, message.config);
        }
        validationErrors = message.errors || [];
        validationWarnings = message.warnings || [];
        render();
      } else if (message.command === 'operationComplete') {
        setBusy(false);
      }
    });
    render();
  </script>
</body>
</html>`;
}

function bindWebviewMessages(
  webview: vscode.Webview,
): () => void {
  activeWebviews.get(webview)?.dispose();
  const messageDisposable = webview.onDidReceiveMessage(async (message: { command?: string; config?: PeripheralConfig }) => {
    let refreshSidebar = false;
    try {
      const currentProject = discoverCurrentProject();
      const target = configPath(currentProject.root);
      if (message.command === 'validate' && message.config) {
        const config = normalizeConfig(currentProject, message.config);
        await webview.postMessage({
          command: 'validation',
          config,
          errors: configurationErrors(config, currentProject),
          warnings: configurationWarnings(config, currentProject),
        });
      } else if (message.command === 'reloadFromHpmpc' && message.config) {
        const config = normalizeConfig(currentProject, message.config);
        await webview.postMessage({
          command: 'projectReloaded',
          config,
          meta: projectMeta(currentProject),
          pinmuxFunctions: currentProject.pinmuxFunctions,
          clockSources: clockSourcesForSoc(currentProject.socName, currentProject.boardName),
          peripheralFunctions: peripheralFunctionsForProject(currentProject),
          errors: configurationErrors(config, currentProject),
          warnings: configurationWarnings(config, currentProject),
        });
      } else if (message.command === 'save' && message.config) {
        const config = normalizeConfig(currentProject, message.config);
        writeConfig(target, config);
        const errors = configurationErrors(config, currentProject);
        if (errors.length === 0) {
          writeLibxrConfig(libxrConfigPath(currentProject.root), config);
        }
        await webview.postMessage({
          command: 'validation',
          config,
          errors,
          warnings: configurationWarnings(config, currentProject),
        });
        if (errors.length > 0) {
          const key = errors.length === 1
            ? 'notification.savedWithErrorsOne'
            : 'notification.savedWithErrorsMany';
          void vscode.window.showWarningMessage(t(key, { count: errors.length }));
          errors.forEach((error) => output.appendLine(`[config] ${error}`));
          output.show(true);
        } else {
          void vscode.window.showInformationMessage(t('notification.configSavedChecked'));
        }
        refreshSidebar = true;
      } else if (message.command === 'generate' && message.config) {
        const config = normalizeConfig(currentProject, message.config);
        assertValidConfig(config, currentProject);
        writeConfig(target, config);
        writeLibxrConfig(libxrConfigPath(currentProject.root), config);
        generate(currentProject, config);
        await runLibxrGenerator(currentProject.root, currentProject.hpmpcPath);
        await webview.postMessage({
          command: 'validation',
          config,
          errors: [],
          warnings: configurationWarnings(config, currentProject),
        });
        refreshSidebar = true;
        void vscode.window.showInformationMessage(t('notification.configGenerated'));
      } else if (message.command === 'openPinmux') {
        await openPinmux();
      } else if (message.command === 'openProjectGenerator') {
        openProjectGenerator();
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      output.appendLine(`[error] ${messageText}`);
      output.show(true);
      void vscode.window.showErrorMessage(messageText);
    } finally {
      if (message.command !== 'validate' && message.command !== 'reloadFromHpmpc') {
        await webview.postMessage({ command: 'operationComplete' });
      }
      if (refreshSidebar) {
        activeSidebarProvider?.refresh(webview);
      }
    }
  });
  activeWebviews.set(webview, messageDisposable);
  return () => {
    if (activeWebviews.get(webview) === messageDisposable) {
      activeWebviews.delete(webview);
    }
    messageDisposable.dispose();
  };
}

async function openConfigUi(context: vscode.ExtensionContext): Promise<void> {
  const project = discoverCurrentProject();
  const target = configPath(project.root);
  const config = loadOrCreateConfig(target, project);
  const panel = vscode.window.createWebviewPanel(
    'hpmPeripheralConfig',
    t('extension.title'),
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = webviewHtml(config, project);
  const unbind = bindWebviewMessages(panel.webview);
  panel.onDidDispose(unbind, undefined, context.subscriptions);
}

class HpmPeripheralViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private unbind?: () => void;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.unbind?.();
    this.view = view;
    view.webview.options = { enableScripts: true };
    this.refresh();
    const unbind = bindWebviewMessages(view.webview);
    this.unbind = unbind;
    view.onDidDispose(() => {
      unbind();
      if (this.view === view) {
        this.view = undefined;
        this.unbind = undefined;
      }
    }, undefined, this.context.subscriptions);
  }

  refresh(sender?: vscode.Webview): void {
    if (!this.view || this.view.webview === sender) {
      return;
    }
    try {
      const project = discoverCurrentProject();
      const config = loadOrCreateConfig(configPath(project.root), project);
      this.view.webview.html = webviewHtml(config, project, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view.webview.html = `<!doctype html><html lang="${currentLocale()}"><body style="font-family: var(--vscode-font-family); padding: 8px;"><h3>${escapeHtmlText(t('extension.title'))}</h3><p>${escapeHtmlText(message)}</p></body></html>`;
    }
  }
}

async function openPinmux(): Promise<void> {
  const project = discoverCurrentProject();
  if (!fs.existsSync(project.hpmpcPath)) {
    throw new Error(t('error.pinmuxFileNotFound', { path: project.hpmpcPath }));
  }
  const extension = vscode.extensions.getExtension('hpmicro.hpm-pinmux-tool');
  if (!extension) {
    throw new Error(t('error.pinmuxExtensionMissing'));
  }
  if (!extension.isActive) {
    await extension.activate();
  }
  const openPath = prepareHpmpcForOpen(project.root, project.hpmpcPath);
  output.appendLine(`[HPM Pinmux] opening ${openPath}`);
  try {
    await vscode.commands.executeCommand('hpmicro.pinmux.openProject', openPath.replace(/\\/g, '/'));
  } catch (error) {
    output.appendLine(
      `[HPM Pinmux] official openProject failed, fallback to custom editor: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(openPath), 'pinmux-tool');
  }
}

function openProjectGenerator(): void {
  const sdkEnvPath = extensionConfig().get<string>('sdkEnvPath', 'D:/HPM/sdk_env');
  const startGui = path.join(sdkEnvPath, 'start_gui.exe');
  const projGen = path.join(sdkEnvPath, 'tools', 'project_generator', 'proj_gen.exe');
  const tool = fs.existsSync(startGui) ? startGui : projGen;
  if (!fs.existsSync(tool)) {
    throw new Error(t('error.projectGeneratorNotFound', { path: sdkEnvPath }));
  }
  const child = childProcess.spawn(tool, {
    cwd: path.dirname(tool),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

function register(context: vscode.ExtensionContext, command: string, handler: () => Promise<void> | void): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(command, async () => {
      try {
        await handler();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[error] ${message}`);
        output.show(true);
        void vscode.window.showErrorMessage(message);
      }
    }),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  setLocale(vscode.env.language);
  activeSidebarProvider = new HpmPeripheralViewProvider(context);
  const workspaceHpmpcWatcher = vscode.workspace.createFileSystemWatcher('**/*.hpmpc');
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hpmPeripheral.configView', activeSidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('hpmPeripheral.hpmpcPath')) {
        rebindHpmpcWatcher(true);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => rebindHpmpcWatcher(true)),
    workspaceHpmpcWatcher,
    workspaceHpmpcWatcher.onDidCreate(() => rebindHpmpcWatcher(true)),
    workspaceHpmpcWatcher.onDidDelete(() => rebindHpmpcWatcher(true)),
    {
      dispose: () => {
        clearHpmpcWatcher();
        hpmpcReloadTask.dispose();
        disposeHpmpcWorkingCopyWatchers();
        for (const disposable of activeWebviews.values()) {
          disposable.dispose();
        }
        activeWebviews.clear();
      },
    },
  );
  rebindHpmpcWatcher();
  register(context, 'hpmPeripheral.openConfig', () => openConfigUi(context));
  register(context, 'hpmPeripheral.refreshConfig', refreshConfig);
  register(context, 'hpmPeripheral.generate', generateBoardGlue);
  register(context, 'hpmPeripheral.openPinmux', openPinmux);
  register(context, 'hpmPeripheral.openProjectGenerator', openProjectGenerator);
}

export function deactivate(): void {
  output.dispose();
}
