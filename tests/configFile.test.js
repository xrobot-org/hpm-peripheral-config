const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const { configurationErrors, configurationWarnings, writeLibxrConfig } = require('../out/configFile.js');

function config() {
  return {
    version: 1,
    project: {
      board: 'hpm5361evklite',
      soc: 'HPM5361',
      hpmpc: 'boards/test/pinmux.hpmpc',
      pinmux_functions: ['init_spi1_pins'],
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
        buffer_size: 256,
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

test('LibXR YAML update preserves settings owned by the user', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'libxr_config.yaml');
  fs.writeFileSync(file, YAML.stringify({
    SYSTEM: 'FreeRTOS',
    GPIO: { led: { direction: 'OUTPUT_PUSH_PULL' } },
    PWM: { motor: { frequency: 20000 } },
    device_aliases: { spi1: ['flash'] },
    SPI: { spi1: { custom_option: 7, use_dma: true, tx_dma_channel: 4 } },
    custom_section: { keep: true },
  }));

  writeLibxrConfig(file, config());
  const output = YAML.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(output.SYSTEM, 'FreeRTOS');
  assert.equal(output.GPIO.led.direction, 'OUTPUT_PUSH_PULL');
  assert.equal(output.PWM.motor.frequency, 20000);
  assert.deepEqual(output.device_aliases.spi1, ['flash']);
  assert.equal(output.custom_section.keep, true);
  assert.equal(output.SPI.spi1.prescaler, 'DIV_1');
  assert.equal(output.SPI.spi1.custom_option, 7);
  assert.equal(output.SPI.spi1.use_dma, undefined);
});

test('disabled peripherals are exported explicitly', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'libxr_config.yaml');
  const value = config();
  value.spi.SPI1.enabled = false;
  writeLibxrConfig(file, value);
  const output = YAML.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(output.disabled_peripherals, ['spi1']);
  assert.equal(output.SPI?.spi1, undefined);
});

test('hardware active-high CS and impossible I2C timing are rejected', () => {
  const value = config();
  value.spi.SPI1.use_gpio_cs = false;
  value.spi.SPI1.cs_active_low = false;
  value.i2c.I2C3 = {
    auto_clock: false,
    clock_source: 'osc24m',
    clock_divider: 256,
    peripheral_clock_hz: 93_750,
    enabled: true,
    bus_hz: 1_000_000,
    address_mode: '7bit',
    use_dma: false,
    pins: { SCL: 'PB13', SDA: 'PB12' },
  };
  const errors = configurationErrors(value);
  assert.equal(errors.some((error) => error.includes('hardware chip-select polarity')), true);
  assert.equal(errors.some((error) => error.includes('timing cannot be represented')), true);
});

test('supported SPI and I2C runtime policies are not reported as limitations', () => {
  const value = config();
  value.i2c.I2C3 = {
    auto_clock: true,
    clock_source: 'osc24m',
    clock_divider: 1,
    peripheral_clock_hz: 24_000_000,
    enabled: true,
    bus_hz: 100_000,
    address_mode: '7bit',
    use_dma: false,
    pins: { SCL: 'PB13', SDA: 'PB12' },
  };

  assert.deepEqual(configurationWarnings(value), []);
});

test('enabled HPM UART is generated configuration, not a limitation', () => {
  const value = config();
  value.uart.UART3 = {
    auto_clock: true,
    clock_source: 'osc24m',
    clock_divider: 1,
    peripheral_clock_hz: 24_000_000,
    enabled: true,
    baudrate: 115_200,
    rx_buffer_size: 256,
    tx_buffer_size: 256,
    tx_queue_size: 5,
    parity: 'NO_PARITY',
    data_bits: 8,
    stop_bits: 1,
    use_dma: true,
    pins: { TXD: 'PB15', RXD: 'PB14' },
  };

  assert.deepEqual(configurationWarnings(value), []);
  assert.deepEqual(configurationErrors(value), []);

  value.uart.UART3.tx_buffer_size = 1;
  assert.equal(
    configurationErrors(value).some((error) => error.includes('tx_buffer_size')),
    true,
  );
});
