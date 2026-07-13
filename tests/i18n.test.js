const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const {
  currentLocale,
  messagesForLocale,
  setLocale,
  t,
  webviewMessages,
} = require('../out/i18n.js');
const { configurationErrors, writeConfig } = require('../out/configFile.js');

function config() {
  return {
    version: 1,
    project: {
      board: 'hpm5361evklite',
      soc: 'HPM5361',
      hpmpc: 'boards/test/pinmux.hpmpc',
      pinmux_functions: [],
    },
    spi: {
      SPI1: {
        auto_clock: true,
        clock_source: 'pll0_clk0',
        clock_divider: 48,
        peripheral_clock_hz: 20_000_000,
        prescaler: 'DIV_1',
        actual_sclk_hz: 20_000_000,
        enabled: true,
        buffer_size: 0,
        sclk_hz: 20_000_000,
        spi_mode: 0,
        clock_polarity: 'LOW',
        clock_phase: 'EDGE_1',
        cs_active_low: true,
        double_buffer: false,
        use_dma: false,
        use_gpio_cs: true,
        pins: { CS0: 'PA26', SCLK: 'PA27' },
      },
    },
    i2c: {},
    uart: {},
    mcan: {},
  };
}

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

test('configuration diagnostics follow the active locale', () => {
  const value = config();
  setLocale('en');
  assert.equal(
    configurationErrors(value).some((error) => error.includes('must be a positive integer')),
    true,
  );

  setLocale('zh-cn');
  const chineseErrors = configurationErrors(value);
  assert.equal(chineseErrors.some((error) => error.includes('必须为正整数')), true);
  assert.equal(chineseErrors.some((error) => error.includes('SPI1')), true);
});

test('locale does not change YAML keys or machine values', (tContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-i18n-'));
  tContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'hpm_peripherals.yaml');

  setLocale('zh-cn');
  writeConfig(file, config());
  const output = YAML.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(output.project.soc, 'HPM5361');
  assert.equal(output.spi.SPI1.buffer_size, 0);
  assert.equal(output.spi.SPI1.clock_polarity, 'LOW');
  assert.equal(Object.keys(output).some((key) => /[\u4e00-\u9fff]/u.test(key)), false);
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
