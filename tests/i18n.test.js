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
  setLocale('zh-cn');
  const ui = webviewMessages();
  assert.equal(ui.title, 'XRobot HPM 外设配置');
  assert.equal(ui.openProjectGenerator, '工程生成器');
  assert.equal(ui.fieldSamplePoint, '采样点');

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  assert.doesNotMatch(source, />Save YAML</);
  assert.doesNotMatch(source, />Save \+ Generate</);
  assert.doesNotMatch(source, /Configuration valid with/);
  assert.doesNotMatch(source, /No pinmux functions found/);
  assert.match(source, /const ui = \$\{serializedUi\}/);
});
