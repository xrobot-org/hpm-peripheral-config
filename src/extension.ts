import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { DebouncedTask } from './autoReload';
import {
  HpmCli,
  HpmCliError,
  HpmCliNotFoundError,
  HpmCliOutputLimitError,
  HpmCliProtocolError,
  HpmCliTimeoutError,
  type HpmCliResponse,
} from './hpmCli';
import type {
  Diagnostic,
  GenerateEnvelope,
  InspectEnvelope,
  PeripheralConfigDto,
  ValidateEnvelope,
} from './hpmProtocol';
import {
  isGeneratorVersionAtLeast,
  isKnownGeneratorVersion,
  MIN_GENERATOR_VERSION,
  PROTOCOL_VERSION,
} from './hpmProtocol';
import { disposeHpmpcWorkingCopyWatchers, prepareHpmpcForOpen } from './hpmpcWorkingCopy';
import { LatestRequestGuard } from './latestRequestGuard';
import {
  currentLocale,
  diagnosticMessage,
  setLocale,
  t,
  webviewMessages,
} from './i18n';
import { safeOutputExcerpt } from './safeOutput';
import { SerialTaskQueue } from './serialTaskQueue';
import { isValidateOperationFailure } from './validationOutcome';

setLocale(vscode.env.language);

const output = vscode.window.createOutputChannel(t('extension.title'));
let activeSidebarProvider: HpmPeripheralViewProvider | undefined;
const activeWebviews = new Map<vscode.Webview, vscode.Disposable>();
const warnedGeneratorVersions = new Set<string>();
const projectMutationQueue = new SerialTaskQueue();
const watcherBindingGuard = new LatestRequestGuard();
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

function configuredHpmpcPath(): string {
  return extensionConfig().get<string>('hpmpcPath', '');
}

function cliExecutable(): string {
  return extensionConfig().get<string>('cliPath', 'xr_hpm_cfg');
}

function cliTimeoutMs(): number {
  return extensionConfig().get<number>('cliTimeoutMs', 30_000);
}

function workspaceRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

type CurrentProject = {
  root: string;
  hpmpcPath: string;
  inspection: InspectEnvelope;
};

function cliClient(): HpmCli {
  return new HpmCli({ executable: cliExecutable(), timeoutMs: cliTimeoutMs() });
}

function generatorVersionWarning(version: string): string | undefined {
  if (!isKnownGeneratorVersion(version)) {
    return t('warning.generatorVersionUnknown', { minimum: MIN_GENERATOR_VERSION });
  }
  if (!isGeneratorVersionAtLeast(version)) {
    return t('warning.generatorVersionOld', { version, minimum: MIN_GENERATOR_VERSION });
  }
  return undefined;
}

function warnGeneratorVersion(version: string): void {
  const warning = generatorVersionWarning(version);
  const key = version.trim().toLowerCase() || 'unknown';
  if (!warning || warnedGeneratorVersions.has(key)) {
    return;
  }
  warnedGeneratorVersions.add(key);
  output.appendLine(`[xr_hpm_cfg] ${warning}`);
  void vscode.window.showWarningMessage(warning);
}

function cliError(error: unknown): Error {
  if (error instanceof HpmCliError) {
    output.appendLine(`[xr_hpm_cfg] ${error.name}: ${error.message}`);
  }
  if (error instanceof HpmCliNotFoundError) {
    return new Error(t('error.cliNotFound', { executable: error.executable }), { cause: error });
  }
  if (error instanceof HpmCliProtocolError) {
    appendProtocolErrorStreams(error);
    return new Error(t('error.cliProtocol', { protocol: PROTOCOL_VERSION }), { cause: error });
  }
  if (error instanceof HpmCliTimeoutError) {
    return new Error(t('error.cliTimeout', { timeoutMs: error.timeoutMs }), { cause: error });
  }
  if (error instanceof HpmCliOutputLimitError) {
    return new Error(t('error.cliOutputLimit'), { cause: error });
  }
  if (error instanceof HpmCliError) {
    return new Error(t('error.cliFailed'), { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function appendProtocolErrorStreams(error: HpmCliProtocolError): void {
  if (error.stdout.length > 0) {
    output.appendLine(
      `[xr_hpm_cfg protocol stdout] ${Buffer.byteLength(error.stdout, 'utf8')} byte(s) suppressed`,
    );
  }
  const excerpt = safeOutputExcerpt(error.stderr);
  if (excerpt.text.trim()) {
    const suffix = excerpt.truncated
      ? `, truncated; ${excerpt.omittedCharacters} character(s) omitted`
      : '';
    output.appendLine(`[xr_hpm_cfg protocol stderr${suffix}]`);
    output.appendLine(excerpt.text);
  }
}

async function invokeCli<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw cliError(error);
  }
}

function appendCliResult<T extends {
  generator_version: string;
  errors: readonly Diagnostic[];
  warnings: readonly Diagnostic[];
}>(
  command: string,
  result: HpmCliResponse<T>,
): void {
  output.appendLine(`[xr_hpm_cfg ${command}] exit ${result.exitCode}`);
  const stderr = safeOutputExcerpt(result.stderr);
  if (stderr.text.trim()) {
    output.appendLine(stderr.text);
    if (stderr.truncated) {
      output.appendLine(`[stderr truncated; ${stderr.omittedCharacters} character(s) omitted]`);
    }
  }
  for (const diagnostic of [...result.envelope.errors, ...result.envelope.warnings]) {
    const detail = safeOutputExcerpt(diagnostic.message);
    const suffix = detail.truncated
      ? `, truncated; ${detail.omittedCharacters} character(s) omitted`
      : '';
    output.appendLine(
      `[xr_hpm_cfg ${command} ${diagnostic.level}:${diagnostic.code}${suffix}]`,
    );
    if (detail.text) {
      output.appendLine(detail.text);
    }
  }
  warnGeneratorVersion(result.envelope.generator_version);
}

function diagnosticsError(diagnostics: readonly Diagnostic[], fallback: string): Error {
  const messages = diagnostics.map(diagnosticMessage).filter(Boolean);
  return new Error(messages.length > 0 ? messages.join('\n') : fallback);
}

function localizedDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.map((item) => ({ ...item, message: diagnosticMessage(item) }));
}

function normalizedConfig(validation: ValidateEnvelope): PeripheralConfigDto {
  if ('version' in validation.normalized_config) {
    return validation.normalized_config as PeripheralConfigDto;
  }
  throw diagnosticsError(validation.errors, t('config.validationFailed'));
}

function savedNormalizedConfig(validation: ValidateEnvelope): PeripheralConfigDto {
  if (isValidateOperationFailure(validation)) {
    throw diagnosticsError(validation.errors, t('config.validationFailed'));
  }
  return normalizedConfig(validation);
}

async function inspectCurrentProject(): Promise<CurrentProject> {
  const root = workspaceRoot();
  const result = await invokeCli(() => cliClient().inspect({
    cwd: root,
    hpmpcPath: configuredHpmpcPath() || undefined,
  }));
  appendCliResult('inspect', result);
  if (result.exitCode !== 0 || result.envelope.errors.length > 0) {
    throw diagnosticsError(result.envelope.errors, t('project.hpmpcNotFound'));
  }
  const hpmpcPath = path.resolve(root, result.envelope.project.hpmpc);
  return { root, hpmpcPath, inspection: result.envelope };
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

function onWorkspaceHpmpcChanged(uri: vscode.Uri): void {
  if (
    watchedHpmpcPath &&
    normalizedFilePath(uri.fsPath) === normalizedFilePath(watchedHpmpcPath)
  ) {
    hpmpcReloadTask.schedule();
  }
}

async function reloadHpmpcViews(): Promise<void> {
  const generation = watcherBindingGuard.begin();
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const project = await inspectCurrentProject();
      if (!watcherBindingGuard.isCurrent(generation)) {
        return;
      }
      watchHpmpcFile(project.hpmpcPath);
      await notifyHpmpcChanged(project.hpmpcPath);
      return;
    } catch (error) {
      if (!watcherBindingGuard.isCurrent(generation)) {
        return;
      }
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

async function rebindHpmpcWatcher(reloadViews = false): Promise<void> {
  const generation = watcherBindingGuard.begin();
  try {
    const project = await inspectCurrentProject();
    if (!watcherBindingGuard.isCurrent(generation)) {
      return;
    }
    watchHpmpcFile(project.hpmpcPath);
    if (reloadViews) {
      hpmpcReloadTask.schedule(0);
    }
  } catch {
    if (watcherBindingGuard.isCurrent(generation)) {
      clearHpmpcWatcher();
    }
  }
}

function peripheralConfigArgument(project: CurrentProject): string {
  return workspaceRelative(project.root, configPath(project.root));
}

async function validateProject(
  project: CurrentProject,
  config?: PeripheralConfigDto,
  write = false,
): Promise<ValidateEnvelope> {
  const result = await invokeCli(() => cliClient().validate({
    cwd: project.root,
    hpmpcPath: workspaceRelative(project.root, project.hpmpcPath),
    peripheralConfigPath: peripheralConfigArgument(project),
    config,
    write,
  }));
  appendCliResult('validate', result);
  return result.envelope;
}

async function generateProject(
  project: CurrentProject,
  config?: PeripheralConfigDto,
): Promise<GenerateEnvelope> {
  const result = await invokeCli(() => cliClient().generate({
    cwd: project.root,
    hpmpcPath: workspaceRelative(project.root, project.hpmpcPath),
    peripheralConfigPath: peripheralConfigArgument(project),
    config,
    libxrConfigPath: 'User/libxr_config.yaml',
    configOutputPath: '.config.yaml',
    appOutputPath: 'User/app_main.cpp',
    hardwareContainer: true,
  }));
  appendCliResult('generate', result);
  return result.envelope;
}

async function refreshConfig(): Promise<void> {
  await projectMutationQueue.run(async () => {
    const project = await inspectCurrentProject();
    const target = configPath(project.root);
    const validation = await validateProject(project, undefined, true);
    savedNormalizedConfig(validation);
    await notifyHpmpcChanged(project.hpmpcPath);
    output.appendLine(`Refreshed ${target}`);
    output.show(true);
    if (!validation.valid) {
      throw diagnosticsError(validation.errors, t('config.validationFailed'));
    }
    void vscode.window.showInformationMessage(t('notification.configRefreshed', { file: path.basename(target) }));
  });
}

async function generateBoardGlue(): Promise<void> {
  await projectMutationQueue.run(async () => {
    const project = await inspectCurrentProject();
    const validation = await validateProject(project);
    if (!validation.valid) {
      throw diagnosticsError(validation.errors, t('config.validationFailed'));
    }
    const generated = await generateProject(project);
    if (!generated.success) {
      throw diagnosticsError(generated.errors, t('config.validationFailed'));
    }
    generated.generated_files.forEach((file) => output.appendLine(`Updated ${file}`));
    output.show(true);
    void vscode.window.showInformationMessage(t('notification.boardGlueGenerated'));
  });
}

function projectMeta(project: CurrentProject): string {
  const info = project.inspection.project;
  return `${info.board} / ${info.soc} / ${info.hpmpc}`;
}

function peripheralFunctionsForProject(project: CurrentProject): Record<string, string[]> {
  return Object.fromEntries(
    project.inspection.peripherals.map((peripheral) => [
      peripheral.instance.toLowerCase(),
      [...new Set(peripheral.functions)],
    ]),
  );
}

function webviewHtml(
  config: PeripheralConfigDto,
  project: CurrentProject,
  validation: ValidateEnvelope,
  compact = false,
): string {
  const nonce = String(Date.now());
  const serialized = JSON.stringify(config).replace(/</g, '\\u003c');
  const serializedUi = JSON.stringify(webviewMessages()).replace(/</g, '\\u003c');
  const locale = currentLocale();
  const pinmuxFunctions = JSON.stringify(project.inspection.pinmux_functions).replace(/</g, '\\u003c');
  const clockSources = JSON.stringify(project.inspection.clock_sources).replace(/</g, '\\u003c');
  const capabilities = JSON.stringify(project.inspection.capabilities).replace(/</g, '\\u003c');
  const peripheralFunctions = JSON.stringify(peripheralFunctionsForProject(project)).replace(/</g, '\\u003c');
  const initialErrors = JSON.stringify(localizedDiagnostics(validation.errors)).replace(/</g, '\\u003c');
  const initialWarnings = JSON.stringify(localizedDiagnostics(validation.warnings)).replace(/</g, '\\u003c');
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
    let capabilities = ${capabilities};
    let peripheralFunctions = ${peripheralFunctions};
    let validationErrors = ${initialErrors};
    let validationWarnings = ${initialWarnings};
    const groups = [
      ['uart', 'UART'],
      ['i2c', 'I2C'],
      ['spi', 'SPI'],
      ['mcan', 'MCAN / FDCAN'],
    ];
    const sectionOpenState = new Map();
    const cardOpenState = new Map();
    const busyDisabledState = new Map();
    let operationBusy = false;
    let validationTimer;
    let validationRequestId = 0;
    let reloadRequestId = 0;
    let operationRequestId = 0;
    let configRevision = 0;
    document.getElementById('meta').textContent = config.project.board + ' / ' + config.project.soc + ' / ' + config.project.hpmpc;
    if (!Array.isArray(config.project.pinmux_functions)) config.project.pinmux_functions = [];
    function input(type, path, value, extra = '') {
      const checked = type === 'checkbox' && value ? 'checked' : '';
      return '<input type="' + type + '" data-path="' + path + '" value="' + value + '" ' + checked + ' ' + extra + '>';
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
    function diagnosticMessage(item) {
      return item && typeof item === 'object' && typeof item.message === 'string'
        ? item.message
        : String(item);
    }
    function renderValidation() {
      const element = document.getElementById('validation');
      const warnings = validationWarnings;
      if (validationErrors.length) {
        element.className = 'validation error';
        element.innerHTML = '<div class="validation-title">' +
          escapeHtml(countMessage('errorsBlockedOne', 'errorsBlockedMany', validationErrors.length)) + '</div><ul>' +
          validationErrors.map(item => '<li>' + escapeHtml(diagnosticMessage(item)) + '</li>').join('') + '</ul>';
      } else if (warnings.length) {
        element.className = 'validation warning';
        element.innerHTML = '<div class="validation-title">' +
          escapeHtml(countMessage('validLimitationsOne', 'validLimitationsMany', warnings.length)) + '</div><ul>' +
          warnings.map(item => '<li>' + escapeHtml(diagnosticMessage(item)) + '</li>').join('') + '</ul>';
      } else {
        element.className = 'validation ok';
        element.innerHTML = '<div class="validation-title">' + escapeHtml(ui.configurationValid) + '</div>';
      }
    }
    function syncBusyControls() {
      if (operationBusy) {
        for (const control of document.querySelectorAll('input, select, textarea, button')) {
          if (!busyDisabledState.has(control)) busyDisabledState.set(control, control.disabled);
          control.disabled = true;
        }
        return;
      }
      for (const [control, wasDisabled] of busyDisabledState) {
        if (control.isConnected) control.disabled = wasDisabled;
      }
      busyDisabledState.clear();
    }
    function setBusy(busy) {
      if (busy && !operationBusy) {
        clearTimeout(validationTimer);
        validationRequestId += 1;
      }
      operationBusy = busy;
      syncBusyControls();
    }
    function scheduleValidation() {
      clearTimeout(validationTimer);
      const requestId = ++validationRequestId;
      const revision = configRevision;
      validationTimer = setTimeout(() => vscode.postMessage({
        command: 'validate', config, requestId, revision,
      }), 250);
    }
    function requestHpmpcReload() {
      const requestId = ++reloadRequestId;
      vscode.postMessage({
        command: 'reloadFromHpmpc', config, requestId, revision: configRevision,
      });
    }
    function replaceConfig(next) {
      if (!next || typeof next !== 'object' || !next.project) return false;
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, next);
      configRevision += 1;
      clearTimeout(validationTimer);
      validationRequestId += 1;
      return true;
    }
    function enumSelect(path, value, options) {
      return '<select data-path="' + path + '">' + options.map(option => {
        const selected = value === option.value ? ' selected' : '';
        return '<option value="' + option.value + '"' + selected + '>' + escapeHtml(option.label) + '</option>';
      }).join('') + '</select>';
    }
    function options(values, labels = {}) {
      return values.map(value => ({ value, label: labels[value] || String(value) }));
    }
    function rangeAttributes(range) {
      return ['min', 'max', 'step']
        .filter(name => range && Number.isFinite(Number(range[name])))
        .map(name => name + '="' + Number(range[name]) + '"')
        .join(' ');
    }
    function clockFields(group, name, value) {
      const prefix = group + '.' + name + '.';
      let html = field(ui.fieldAutoClock, input('checkbox', prefix + 'auto_clock', value.auto_clock));
      if (!value.auto_clock) {
        html += field(ui.fieldClockSource, enumSelect(prefix + 'clock_source', value.clock_source,
          clockSources.map(source => ({ value: source.id, label: source.id + ' (' + source.hz + ' Hz)' }))));
        html += field(ui.fieldClockDivider, input(
          'number',
          prefix + 'clock_divider',
          value.clock_divider,
          rangeAttributes(capabilities.spi.clock_divider),
        ));
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
        html += field(ui.fieldParity, enumSelect(group + '.' + name + '.parity', value.parity,
          options(capabilities.uart.parity, {
            NO_PARITY: ui.optionParityNone,
            EVEN: ui.optionParityEven,
            ODD: ui.optionParityOdd,
          })));
        html += field(ui.fieldDataBits, enumSelect(group + '.' + name + '.data_bits', value.data_bits,
          options(capabilities.uart.data_bits)));
        html += field(ui.fieldStopBits, enumSelect(group + '.' + name + '.stop_bits', value.stop_bits,
          options(capabilities.uart.stop_bits)));
        html += field(ui.fieldRxBufferSize, input('number', group + '.' + name + '.rx_buffer_size', value.rx_buffer_size, 'min="1"'));
        html += field(ui.fieldTxBufferSize, input('number', group + '.' + name + '.tx_buffer_size', value.tx_buffer_size, 'min="2"'));
        html += field(ui.fieldTxQueueSize, input('number', group + '.' + name + '.tx_queue_size', value.tx_queue_size, 'min="1"'));
        html += clockFields(group, name, value);
        html += '<div class="clock-status">' + escapeHtml(ui.uartDmaAutomatic) + '</div>';
      } else if (group === 'i2c') {
        html += field(ui.fieldBusHz, enumSelect(group + '.' + name + '.bus_hz', value.bus_hz,
          capabilities.i2c.bus_rates.map(rate => ({
            value: rate,
            label: numberFormatter.format(rate) + ' Hz',
          }))));
        html += field(ui.fieldAddressMode, enumSelect(
          group + '.' + name + '.address_mode',
          value.address_mode,
          options(capabilities.i2c.address_modes, {
            '7bit': ui.option7BitMaster,
            '10bit': ui.option10BitMaster,
          }),
        ));
        html += clockFields(group, name, value);
        html += '<div class="clock-status">' + escapeHtml(ui.i2cRuntimeDma) + '</div>';
      } else if (group === 'spi') {
        html += field(ui.fieldSclkHz, input('number', group + '.' + name + '.sclk_hz', value.sclk_hz, 'min="1"'));
        html += field(ui.fieldBufferSize, input(
          'number',
          group + '.' + name + '.buffer_size',
          value.buffer_size,
          rangeAttributes(capabilities.spi.buffer_size),
        ));
        html += field(ui.fieldDoubleBuffer, input('checkbox', group + '.' + name + '.double_buffer', value.double_buffer));
        html += field(ui.fieldSpiMode, enumSelect(group + '.' + name + '.spi_mode', value.spi_mode,
          options(capabilities.spi.modes)));
        html += field(ui.fieldClockPolarity, enumSelect(
          group + '.' + name + '.clock_polarity',
          value.clock_polarity,
          options(capabilities.spi.clock_polarities, {
            LOW: ui.optionPolarityLow,
            HIGH: ui.optionPolarityHigh,
          }),
        ));
        html += field(ui.fieldClockPhase, enumSelect(
          group + '.' + name + '.clock_phase',
          value.clock_phase,
          options(capabilities.spi.clock_phases, {
            EDGE_1: ui.optionPhaseFirst,
            EDGE_2: ui.optionPhaseSecond,
          }),
        ));
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
        html += field(ui.fieldMode, enumSelect(group + '.' + name + '.mode', value.mode,
          options(capabilities.mcan.modes, { can: 'CAN', fdcan: 'FDCAN' })));
        html += field(ui.fieldBitrate, input('number', group + '.' + name + '.bitrate', value.bitrate, 'min="1"'));
        html += field(ui.fieldSamplePoint, input(
          'number',
          group + '.' + name + '.sample_point',
          value.sample_point ?? 0.875,
          rangeAttributes(capabilities.mcan.sample_point),
        ));
        html += field(ui.fieldQueueSize, input(
          'number',
          group + '.' + name + '.queue_size',
          value.queue_size ?? 8,
          rangeAttributes(capabilities.mcan.queue_size),
        ));
        html += field(ui.fieldLoopback, input('checkbox', group + '.' + name + '.loopback', value.loopback));
        html += field(ui.fieldListenOnly, input('checkbox', group + '.' + name + '.listen_only', value.listen_only));
        html += field(ui.fieldOneShot, input('checkbox', group + '.' + name + '.one_shot', value.one_shot));
        if (value.mode === 'fdcan') {
          html += field(ui.fieldDataBitrate, input('number', group + '.' + name + '.data_bitrate', value.data_bitrate ?? 2000000, 'min="1"'));
          html += field(ui.fieldDataSamplePoint, input(
            'number',
            group + '.' + name + '.data_sample_point',
            value.data_sample_point ?? 0.75,
            rangeAttributes(capabilities.mcan.sample_point),
          ));
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
      syncBusyControls();
    }
    function setPath(path, raw, isCheckbox) {
      const parts = path.split('.');
      let target = config;
      for (const part of parts.slice(0, -1)) target = target[part];
      const key = parts[parts.length - 1];
      if (isCheckbox) target[key] = Boolean(raw);
      else if (!Number.isNaN(Number(raw)) && raw !== '') target[key] = Number(raw);
      else target[key] = raw;
      if (key === 'spi_mode') {
        delete target.clock_polarity;
        delete target.clock_phase;
      } else if (key === 'clock_polarity' || key === 'clock_phase') {
        delete target.spi_mode;
      }
      configRevision += 1;
    }
    document.addEventListener('input', event => {
      if (operationBusy) return;
      const el = event.target;
      if (!el.dataset || !el.dataset.path) return;
      setPath(el.dataset.path, el.type === 'checkbox' ? el.checked : el.value, el.type === 'checkbox');
      scheduleValidation();
    });
    document.addEventListener('click', event => {
      if (event.target.closest('summary') && event.target.matches('input, select')) event.stopPropagation();
    });
    document.addEventListener('change', event => {
      if (operationBusy) return;
      const el = event.target;
      if (el.dataset && el.dataset.function) {
        const selected = new Set(config.project.pinmux_functions || []);
        if (el.checked) selected.add(el.dataset.function);
        else selected.delete(el.dataset.function);
        config.project.pinmux_functions = Array.from(selected);
        configRevision += 1;
        document.getElementById('functionHint').textContent = selected.size
          ? countMessage('selectedOne', 'selectedMany', selected.size)
          : ui.allFunctions;
        scheduleValidation();
        return;
      }
      if (!el.dataset || !el.dataset.path) return;
      setPath(el.dataset.path, el.type === 'checkbox' ? el.checked : el.value, el.type === 'checkbox');
      if (
        el.dataset.path.endsWith('.mode') ||
        el.dataset.path.endsWith('.enabled') ||
        el.dataset.path.endsWith('.auto_clock') ||
        el.dataset.path.endsWith('.use_gpio_cs') ||
        el.dataset.path.endsWith('.clock_source') ||
        el.dataset.path.endsWith('.clock_divider') ||
        el.dataset.path.endsWith('.sclk_hz')
      ) {
        render();
      }
      scheduleValidation();
    });
    function runOperation(command, includeConfig = true) {
      setBusy(true);
      const requestId = ++operationRequestId;
      const message = { command, requestId, revision: configRevision };
      vscode.postMessage(includeConfig ? { ...message, config } : message);
    }
    document.getElementById('save').onclick = () => runOperation('save');
    document.getElementById('generate').onclick = () => runOperation('generate');
    document.getElementById('openPinmux').onclick = () => runOperation('openPinmux', false);
    document.getElementById('openProjectGenerator').onclick = () => runOperation('openProjectGenerator', false);
    window.addEventListener('message', event => {
      const message = event.data || {};
      if (message.command === 'hpmpcChanged') {
        clearTimeout(validationTimer);
        validationRequestId += 1;
        requestHpmpcReload();
      } else if (message.command === 'projectReloaded') {
        if (typeof message.requestId === 'number' && message.requestId !== reloadRequestId) return;
        if (typeof message.revision === 'number' && message.revision !== configRevision) {
          requestHpmpcReload();
          return;
        }
        if (!replaceConfig(message.config)) return;
        pinmuxFunctions = message.pinmuxFunctions || [];
        clockSources = message.clockSources || [];
        capabilities = message.capabilities || capabilities;
        peripheralFunctions = message.peripheralFunctions || {};
        validationErrors = message.errors || [];
        validationWarnings = message.warnings || [];
        document.getElementById('meta').textContent = message.meta || '';
        render();
      } else if (message.command === 'validation') {
        if (message.operation) {
          if (typeof message.requestId === 'number' && message.requestId !== operationRequestId) return;
        } else if (typeof message.requestId === 'number' && message.requestId !== validationRequestId) {
          return;
        }
        if (typeof message.revision === 'number' && message.revision !== configRevision) return;
        replaceConfig(message.config);
        validationErrors = message.errors || [];
        validationWarnings = message.warnings || [];
        render();
      } else if (message.command === 'operationComplete') {
        if (typeof message.requestId === 'number' && message.requestId !== operationRequestId) return;
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
  const messageDisposable = webview.onDidReceiveMessage(async (message: {
    command?: string;
    config?: PeripheralConfigDto;
    requestId?: number;
    revision?: number;
  }) => {
    let refreshSidebar = false;
    try {
      if (message.command === 'openProjectGenerator') {
        openProjectGenerator();
      } else if (message.command === 'openPinmux') {
        await openPinmux();
      } else if (
        (message.command === 'save' || message.command === 'generate') &&
        message.config
      ) {
        const command = message.command;
        const requestedConfig = message.config;
        await projectMutationQueue.run(async () => {
          const currentProject = await inspectCurrentProject();
          if (command === 'save') {
            const target = configPath(currentProject.root);
            const validation = await validateProject(currentProject, requestedConfig, true);
            const savedConfig = savedNormalizedConfig(validation);
            await webview.postMessage({
              command: 'validation',
              requestId: message.requestId,
              revision: message.revision,
              operation: true,
              config: savedConfig,
              errors: localizedDiagnostics(validation.errors),
              warnings: localizedDiagnostics(validation.warnings),
            });
            if (validation.errors.length > 0) {
              const key = validation.errors.length === 1
                ? 'notification.savedWithErrorsOne'
                : 'notification.savedWithErrorsMany';
              void vscode.window.showWarningMessage(t(key, { count: validation.errors.length }));
              validation.errors.forEach((item) => (
                output.appendLine(`[config:${item.code}] ${diagnosticMessage(item)}`)
              ));
              output.show(true);
            } else {
              void vscode.window.showInformationMessage(t('notification.configSavedChecked'));
            }
            output.appendLine(`Saved ${target}`);
            refreshSidebar = true;
          } else {
            const validation = await validateProject(currentProject, requestedConfig);
            await webview.postMessage({
              command: 'validation',
              requestId: message.requestId,
              revision: message.revision,
              operation: true,
              config: validation.normalized_config,
              errors: localizedDiagnostics(validation.errors),
              warnings: localizedDiagnostics(validation.warnings),
            });
            if (!validation.valid) {
              throw diagnosticsError(validation.errors, t('config.validationFailed'));
            }
            const generated = await generateProject(currentProject, requestedConfig);
            if (!generated.success) {
              throw diagnosticsError(generated.errors, t('config.validationFailed'));
            }
            generated.generated_files.forEach((file) => output.appendLine(`Updated ${file}`));
            refreshSidebar = true;
            void vscode.window.showInformationMessage(t('notification.configGenerated'));
          }
        });
      } else {
        const currentProject = await inspectCurrentProject();
        if (message.command === 'validate' && message.config) {
          const validation = await validateProject(currentProject, message.config);
          await webview.postMessage({
            command: 'validation',
            requestId: message.requestId,
            revision: message.revision,
            config: validation.normalized_config,
            errors: localizedDiagnostics(validation.errors),
            warnings: localizedDiagnostics(validation.warnings),
          });
        } else if (message.command === 'reloadFromHpmpc' && message.config) {
          const validation = await validateProject(currentProject, message.config);
          await webview.postMessage({
            command: 'projectReloaded',
            requestId: message.requestId,
            revision: message.revision,
            config: validation.normalized_config,
            meta: projectMeta(currentProject),
            pinmuxFunctions: currentProject.inspection.pinmux_functions,
            clockSources: currentProject.inspection.clock_sources,
            capabilities: currentProject.inspection.capabilities,
            peripheralFunctions: peripheralFunctionsForProject(currentProject),
            errors: localizedDiagnostics(validation.errors),
            warnings: localizedDiagnostics(validation.warnings),
          });
        }
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      output.appendLine(`[error] ${messageText}`);
      output.show(true);
      void vscode.window.showErrorMessage(messageText);
    } finally {
      if (message.command !== 'validate' && message.command !== 'reloadFromHpmpc') {
        await webview.postMessage({ command: 'operationComplete', requestId: message.requestId });
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
  const project = await inspectCurrentProject();
  const validation = await validateProject(project);
  const panel = vscode.window.createWebviewPanel(
    'hpmPeripheralConfig',
    t('extension.title'),
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = webviewHtml(normalizedConfig(validation), project, validation);
  const unbind = bindWebviewMessages(panel.webview);
  panel.onDidDispose(unbind, undefined, context.subscriptions);
}

class HpmPeripheralViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private unbind?: () => void;
  private refreshId = 0;

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
    void this.refreshAsync(sender);
  }

  private async refreshAsync(sender?: vscode.Webview): Promise<void> {
    if (!this.view || this.view.webview === sender) {
      return;
    }
    const refreshId = ++this.refreshId;
    try {
      const project = await inspectCurrentProject();
      const validation = await validateProject(project);
      if (this.view && refreshId === this.refreshId) {
        this.view.webview.html = webviewHtml(
          normalizedConfig(validation),
          project,
          validation,
          true,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.view && refreshId === this.refreshId) {
        this.view.webview.html = `<!doctype html><html lang="${currentLocale()}"><body style="font-family: var(--vscode-font-family); padding: 8px;"><h3>${escapeHtmlText(t('extension.title'))}</h3><p>${escapeHtmlText(message)}</p></body></html>`;
      }
    }
  }
}

async function openPinmux(): Promise<void> {
  const project = await inspectCurrentProject();
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
        void rebindHpmpcWatcher(true);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void rebindHpmpcWatcher(true)),
    workspaceHpmpcWatcher,
    workspaceHpmpcWatcher.onDidChange(onWorkspaceHpmpcChanged),
    workspaceHpmpcWatcher.onDidCreate(() => void rebindHpmpcWatcher(true)),
    workspaceHpmpcWatcher.onDidDelete(() => void rebindHpmpcWatcher(true)),
    {
      dispose: () => {
        watcherBindingGuard.invalidate();
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
  void rebindHpmpcWatcher();
  register(context, 'hpmPeripheral.openConfig', () => openConfigUi(context));
  register(context, 'hpmPeripheral.refreshConfig', refreshConfig);
  register(context, 'hpmPeripheral.generate', generateBoardGlue);
  register(context, 'hpmPeripheral.openPinmux', openPinmux);
  register(context, 'hpmPeripheral.openProjectGenerator', openProjectGenerator);
}

export function deactivate(): void {
  output.dispose();
}
