const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  currentLocale,
  diagnosticMessage,
  messagesForLocale,
  setLocale,
  t,
  webviewMessages,
} = require('../out/i18n.js');

test.afterEach(() => setLocale('en'));

test('runtime locale follows simplified Chinese variants and falls back to English', () => {
  setLocale('zh-cn');
  assert.equal(currentLocale(), 'zh-cn');
  assert.equal(t('webview.saveYaml'), '保存 YAML');

  setLocale('zh-Hans-CN');
  assert.equal(currentLocale(), 'zh-cn');
  assert.equal(t('webview.saveGenerate'), '保存并生成');

  setLocale('fr');
  assert.equal(currentLocale(), 'en');
  assert.equal(t('webview.saveYaml'), 'Save YAML');
});

test('English and Chinese runtime catalogs have matching keys and placeholders', () => {
  const english = messagesForLocale('en');
  const chinese = messagesForLocale('zh-cn');
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());

  const placeholders = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
    .map((match) => match[1])
    .sort();
  for (const key of Object.keys(english)) {
    assert.notEqual(english[key], '');
    assert.notEqual(chinese[key], '');
    assert.deepEqual(placeholders(chinese[key]), placeholders(english[key]), key);
  }
});

test('named parameters can change order in Chinese without changing technical values', () => {
  setLocale('zh-cn');
  const message = t('config.i2cTiming', {
    instance: 'I2C3',
    busHz: 400000,
    clockHz: 24000000,
  });
  assert.match(message, /^I2C3：/);
  assert.match(message, /24000000 Hz/);
  assert.match(message, /400000 Hz/);
});

test('CLI setup and protocol guidance is localized without changing machine values', () => {
  setLocale('en');
  assert.match(t('error.cliNotFound', { executable: 'xr_hpm_cfg' }), /cliPath/);
  assert.match(t('error.cliProtocol', { protocol: 1 }), /Protocol 1/);

  setLocale('zh-cn');
  assert.match(t('error.cliNotFound', { executable: 'xr_hpm_cfg' }), /未找到 HPM CLI/);
  assert.match(t('error.cliProtocol', { protocol: 1 }), /协议 1/);
  assert.match(t('warning.generatorVersionOld', { version: '5.2.4', minimum: '5.3.0' }), /5\.2\.4/);
});

test('diagnostics are localized by stable code without parsing backend English', () => {
  const diagnostic = {
    code: 'HPM_CAN_NOMINAL_TIMING_UNREACHABLE',
    level: 'error',
    peripheral: 'MCAN2',
    field: 'bitrate',
    message: 'BACKEND ENGLISH SENTINEL 80000000 Hz',
  };

  setLocale('en');
  assert.equal(
    diagnosticMessage(diagnostic),
    'MCAN2: CAN nominal bitrate/sample point cannot be represented.',
  );

  setLocale('zh-cn');
  const chinese = diagnosticMessage(diagnostic);
  assert.equal(chinese, 'MCAN2：无法实现 CAN 标称比特率或采样点。');
  assert.doesNotMatch(chinese, /BACKEND|80000000/);

  assert.equal(
    diagnosticMessage({ ...diagnostic, code: 'HPM_FUTURE_CODE' }),
    diagnostic.message,
  );
});

test('unsupported Pinmux manager actions use the dedicated localized message', () => {
  setLocale('en');
  assert.equal(
    diagnosticMessage({
      code: 'HPM_PINMUX_MANAGER_UNSUPPORTED',
      level: 'error',
      message: 'BACKEND MANAGER SENTINEL',
    }),
    'The selected Pinmux function requires unsupported non-pin routing actions; no project files were changed.',
  );
});

test('unsafe Pinmux function updates use the dedicated localized message', () => {
  setLocale('en');
  assert.equal(
    diagnosticMessage({
      code: 'HPM_PINMUX_FUNCTION_UPDATE_UNSAFE',
      level: 'error',
      message: 'BACKEND UPDATE SENTINEL',
    }),
    'The selected Pinmux function contains custom code and cannot be updated safely; no project files were changed.',
  );
});

test('unavailable SPI hardware chip select uses the dedicated localized message', () => {
  const diagnostic = {
    code: 'HPM_SPI_HARDWARE_CS_INVALID',
    level: 'error',
    peripheral: 'SPI1',
    field: 'hardware_cs_index',
    message: 'BACKEND HARDWARE CS SENTINEL',
  };

  setLocale('en');
  assert.equal(
    diagnosticMessage(diagnostic),
    'SPI1: selected hardware chip select is not available in the active Pinmux function.',
  );
  setLocale('zh-cn');
  assert.equal(
    diagnosticMessage(diagnostic),
    'SPI1：当前 Pinmux 函数未配置所选硬件片选。',
  );
});

test('SPI polarity diagnostics describe the SCLK idle level', () => {
  const diagnostic = {
    code: 'HPM_SPI_CPOL_INVALID',
    level: 'error',
    peripheral: 'SPI1',
    field: 'clock_polarity',
    message: 'BACKEND CPOL SENTINEL',
  };

  setLocale('en');
  assert.equal(diagnosticMessage(diagnostic), 'SPI1: SCLK idle level must be LOW or HIGH.');
  setLocale('zh-cn');
  assert.equal(diagnosticMessage(diagnostic), 'SPI1：SCLK 空闲电平必须为 LOW 或 HIGH。');
});

test('Manifest language packs cover every package placeholder', () => {
  const root = path.join(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const english = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
  const chinese = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));
  const placeholders = [...JSON.stringify(packageJson).matchAll(/%([^%]+)%/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
  assert.deepEqual(placeholders, Object.keys(english).sort());
});

test('Webview receives localized strings instead of hard-coded English controls', () => {
  setLocale('en');
  const englishUi = webviewMessages();
  assert.equal(
    englishUi.uartDmaAutomatic,
    'RX and TX each use one automatically allocated DMA channel.',
  );
  assert.equal(
    englishUi.uartRxInterruptTxDma,
    'RX uses UART FIFO interrupts; TX uses one automatically allocated DMA channel.',
  );
  assert.equal(englishUi.fieldClockPolarity, 'SCLK idle level');
  assert.equal(englishUi.optionPolarityLow, 'Low (CPOL = 0)');
  assert.equal(englishUi.optionPolarityHigh, 'High (CPOL = 1)');
  assert.equal(englishUi.fieldHardwareChipSelect, 'Hardware chip select');

  setLocale('zh-cn');
  const ui = webviewMessages();
  assert.equal(ui.title, 'XRobot HPM 外设配置');
  assert.equal(ui.openProjectGenerator, '工程生成器');
  assert.equal(ui.fieldSamplePoint, '采样点');
  assert.equal(ui.uartDmaAutomatic, 'RX 和 TX 各使用一个自动分配的 DMA 通道。');
  assert.equal(
    ui.uartRxInterruptTxDma,
    'RX 使用 UART FIFO 中断；TX 使用一个自动分配的 DMA 通道。',
  );
  assert.equal(ui.fieldClockPolarity, 'SCLK 空闲电平');
  assert.equal(ui.optionPolarityLow, '低（CPOL = 0）');
  assert.equal(ui.optionPolarityHigh, '高（CPOL = 1）');
  assert.equal(ui.fieldHardwareChipSelect, '硬件片选');

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  assert.doesNotMatch(source, />Save YAML</);
  assert.doesNotMatch(source, />Save \+ Generate</);
  assert.doesNotMatch(source, /Configuration valid with/);
  assert.doesNotMatch(source, /No pinmux functions found/);
  assert.match(source, /const ui = \$\{serializedUi\}/);
});
