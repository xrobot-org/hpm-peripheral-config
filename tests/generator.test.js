const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generate } = require('../out/generator.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-generator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    boardC: path.join(root, 'board.c'),
    boardH: path.join(root, 'board.h'),
    pinmuxC: path.join(root, 'pinmux.c'),
    pinmuxH: path.join(root, 'pinmux.h'),
  };
  fs.writeFileSync(files.boardC, `uint32_t board_init_spi_clock(SPI_Type *ptr)
{
    if (ptr == HPM_SPI1) {
        clock_add_to_group(clock_spi1, 0);
        return clock_get_frequency(clock_spi1);
    }
    return 0;
}

void board_write_spi_cs(uint32_t pin, uint8_t state) {}
uint32_t board_init_uart_clock(UART_Type *ptr)
{
    if (ptr == HPM_UART3) {
        clock_add_to_group(clock_uart3, 0);
        clock_set_source_divider(clock_uart3, clk_src_pll0_clk2, 217U);
        return clock_get_frequency(clock_uart3);
    }
    return 0;
}
void init_gptmr_pins(void) {}
`);
  fs.writeFileSync(files.boardH, `#define BOARD_SPI_CS_PIN IOC_PAD_PA26
#define BOARD_SPI_CS_ACTIVE_LEVEL (0U)
void init_gptmr_pins(void);
`);
  fs.writeFileSync(files.pinmuxC, 'void init_all_pins(void) {}\n');
  fs.writeFileSync(files.pinmuxH, 'void init_all_pins(void);\n');
  return {
    root,
    hpmpcPath: path.join(root, 'pinmux.hpmpc'),
    boardDir: root,
    boardName: 'hpm5361evklite',
    socName: 'HPM5361',
    packageName: 'QFN48',
    sdkName: '1.8.0',
    pinmuxFunctions: ['init_all_pins'],
    peripherals: [
      { instance: 'SPI1', type: 'SPI', index: 1, pins: { CS0: 'PA26' }, functions: ['init_all_pins'], annotations: [] },
      { instance: 'MCAN0', type: 'MCAN', index: 0, pins: { TXD: 'PA00', RXD: 'PA01' }, functions: ['init_all_pins'], annotations: [] },
    ],
    ...files,
  };
}

function config() {
  return {
    version: 1,
    project: { board: 'hpm5361evklite', soc: 'HPM5361', hpmpc: 'pinmux.hpmpc', pinmux_functions: ['init_all_pins'] },
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
        use_gpio_cs: false,
        pins: { CS0: 'PA26' },
      },
    },
    i2c: {},
    uart: {},
    mcan: {
      MCAN0: {
        auto_clock: true,
        clock_source: 'pll0_clk0',
        clock_divider: 12,
        peripheral_clock_hz: 80_000_000,
        enabled: true,
        mode: 'can',
        bitrate: 500_000,
        sample_point: 0.875,
        queue_size: 8,
        loopback: false,
        listen_only: false,
        one_shot: false,
        pins: { TXD: 'PA00', RXD: 'PA01' },
      },
    },
  };
}

test('managed clock and CAN blocks disappear after peripherals are disabled', (t) => {
  const project = fixture(t);
  const value = config();
  generate(project, value);
  let board = fs.readFileSync(project.boardC, 'utf8');
  assert.match(board, /HPM Peripheral Config: SPI1/);
  assert.match(board, /HPM Peripheral Config Begin/);

  value.spi.SPI1.enabled = false;
  value.mcan.MCAN0.enabled = false;
  generate(project, value);
  board = fs.readFileSync(project.boardC, 'utf8');
  assert.doesNotMatch(board, /HPM Peripheral Config: SPI1/);
  assert.match(board, /HPM Peripheral Config Begin \*\/\s*\/\* HPM Peripheral Config End/);
});

test('missing board clock helper fails instead of silently succeeding', (t) => {
  const project = fixture(t);
  fs.writeFileSync(project.boardC, 'void init_gptmr_pins(void) {}\n');
  assert.throws(() => generate(project, config()), /board_init_spi_clock is missing/);
});

test('enabled UART clock settings replace stale board clock configuration', (t) => {
  const project = fixture(t);
  project.peripherals.push({
    instance: 'UART3',
    type: 'UART',
    index: 3,
    pins: { TXD: 'PB15', RXD: 'PB14' },
    functions: ['init_all_pins'],
    annotations: [],
  });
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

  generate(project, value);
  const board = fs.readFileSync(project.boardC, 'utf8');
  assert.match(
    board,
    /clock_set_source_divider\(clock_uart3, clk_src_osc24m, 1U\); \/\* HPM Peripheral Config: UART3 \*\//,
  );
  assert.doesNotMatch(board, /clock_uart3, clk_src_pll0_clk2, 217U/);
});
