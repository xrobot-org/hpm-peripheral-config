const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HpmProtocolError,
  MIN_GENERATOR_VERSION,
  isGeneratorVersionAtLeast,
  isKnownGeneratorVersion,
  parseGenerateEnvelope,
  parseInspectEnvelope,
  parseValidateEnvelope,
} = require('../out/hpmProtocol.js');

function baseEnvelope(value = {}) {
  return {
    protocol_version: 1,
    generator_version: '5.2.4',
    errors: [],
    warnings: [],
    ...value,
  };
}

function diagnostic(level) {
  return {
    code: level === 'error' ? 'HPM_TEST_ERROR' : 'HPM_TEST_WARNING',
    level,
    peripheral: null,
    field: null,
    message: `${level} message`,
  };
}

function capabilities() {
  return {
    spi: {
      modes: [0, 1, 2, 3],
      clock_polarities: ['LOW', 'HIGH'],
      clock_phases: ['EDGE_1', 'EDGE_2'],
      prescalers: ['DIV_1', 'DIV_2'],
      buffer_size: { min: 1 },
      clock_divider: { min: 1, max: 256 },
      dma_supported: false,
      gpio_cs: { max_instances: 1 },
    },
    i2c: {
      bus_rates: [100_000, 400_000, 1_000_000],
      address_modes: ['7bit', '10bit'],
      fixed_dma_channel: false,
      runtime_dma_allocation: true,
    },
    uart: {
      parity: ['NO_PARITY', 'EVEN', 'ODD'],
      data_bits: [5, 6, 7, 8],
      stop_bits: [1, 2],
      dma: { automatic: true, channel_min: 0, channel_max: 31, channel_count: 32 },
    },
    mcan: {
      modes: ['can', 'fdcan'],
      sample_point: { min: 0.5, max: 0.95, step: 0.001 },
      data_fields: ['data_bitrate', 'data_sample_point', 'brs', 'esi'],
      queue_size: { min: 1 },
    },
  };
}

function peripheralConfig() {
  return {
    version: 1,
    project: {
      board: 'hpm5361evklite',
      soc: 'HPM5361',
      package: 'BGA289',
      sdk: '1.11.0',
      hpmpc: 'boards/hpm5361evklite/pinmux.hpmpc',
      pinmux_functions: ['init_uart3_pins'],
    },
    spi: {},
    i2c: {},
    uart: {
      UART3: {
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
        rx_dma_channel: 0,
        tx_dma_channel: 1,
        pins: { TXD: 'PB15', RXD: 'PB14' },
      },
    },
    mcan: {},
  };
}

function inspectEnvelope() {
  return baseEnvelope({
    project: {
      board: 'hpm5361evklite',
      soc: 'HPM5361',
      package: 'BGA289',
      sdk: '1.11.0',
      hpmpc: 'boards/hpm5361evklite/pinmux.hpmpc',
    },
    pinmux_functions: ['init_uart3_pins'],
    peripherals: [{
      instance: 'UART3',
      type: 'UART',
      index: 3,
      pins: { TXD: 'PB15', RXD: 'PB14' },
      functions: ['init_uart3_pins'],
      annotations: ['console'],
    }],
    clock_functions: ['init_clocks'],
    clock_sources: [{ id: 'osc24m', c_symbol: 'clk_src_osc24m', hz: 24_000_000 }],
    capabilities: capabilities(),
  });
}

function validateEnvelope() {
  return baseEnvelope({ valid: true, normalized_config: peripheralConfig() });
}

function generateEnvelope() {
  return baseEnvelope({
    success: true,
    generated_files: ['User/app_main.cpp', 'User/libxr_config.yaml'],
  });
}

test('inspect envelope accepts one strict JSON document', () => {
  const result = parseInspectEnvelope(JSON.stringify(inspectEnvelope()));

  assert.equal(result.protocol_version, 1);
  assert.equal(result.project.board, 'hpm5361evklite');
  assert.equal(result.peripherals[0].pins.TXD, 'PB15');
  assert.deepEqual(result.capabilities.mcan.modes, ['can', 'fdcan']);
});

test('inspect rejects incomplete capability data used by the webview', () => {
  const malformed = inspectEnvelope();
  delete malformed.capabilities.uart.parity;
  assert.throws(
    () => parseInspectEnvelope(malformed),
    /capabilities\.uart\.parity.*missing/,
  );
});

test('validate envelope checks the normalized peripheral config at runtime', () => {
  const result = parseValidateEnvelope(validateEnvelope());

  assert.equal(result.valid, true);
  assert.equal(result.normalized_config.uart.UART3.rx_dma_channel, 0);

  const malformed = validateEnvelope();
  malformed.normalized_config.uart.UART3.data_bits = 9;
  assert.throws(
    () => parseValidateEnvelope(malformed),
    (error) => error instanceof HpmProtocolError &&
      error.message.includes('normalized_config.uart.UART3.data_bits'),
  );
});

test('invalid validation envelopes preserve transient field values for diagnostics', () => {
  const invalid = validateEnvelope();
  invalid.valid = false;
  invalid.normalized_config.uart.UART3.baudrate = '';
  invalid.errors = [{
    code: 'HPM_UART_BAUDRATE_UNREACHABLE',
    level: 'error',
    peripheral: 'UART3',
    field: 'baudrate',
    message: 'UART baudrate is not reachable within the HPM SDK tolerance.',
  }];

  const result = parseValidateEnvelope(invalid);

  assert.equal(result.valid, false);
  assert.equal(result.normalized_config.uart.UART3.baudrate, '');
  assert.equal(result.errors[0].code, 'HPM_UART_BAUDRATE_UNREACHABLE');
});

test('generate envelope validates generated file paths as strings', () => {
  const result = parseGenerateEnvelope(generateEnvelope());
  assert.deepEqual(result.generated_files, [
    'User/app_main.cpp',
    'User/libxr_config.yaml',
  ]);

  const malformed = generateEnvelope();
  malformed.generated_files = ['User/app_main.cpp', 7];
  assert.throws(() => parseGenerateEnvelope(malformed), /generated_files\[1\]/);
});

test('error envelopes accept the empty payloads emitted before discovery', () => {
  const error = diagnostic('error');
  const inspected = parseInspectEnvelope(baseEnvelope({
    project: {},
    pinmux_functions: [],
    peripherals: [],
    clock_functions: [],
    clock_sources: [],
    capabilities: {},
    errors: [error],
  }));
  const validated = parseValidateEnvelope(baseEnvelope({
    valid: false,
    normalized_config: {},
    errors: [error],
  }));

  assert.deepEqual(inspected.project, {});
  assert.deepEqual(validated.normalized_config, {});
});

test('malformed or non-object JSON is rejected', () => {
  assert.throws(
    () => parseGenerateEnvelope('{"protocol_version":1'),
    /not valid JSON/,
  );
  assert.throws(() => parseGenerateEnvelope('[]'), /must be an object/);
});

test('missing common and command-specific fields are rejected', () => {
  const missingVersion = generateEnvelope();
  delete missingVersion.generator_version;
  assert.throws(
    () => parseGenerateEnvelope(missingVersion),
    /generator_version.*missing/,
  );

  const missingFiles = generateEnvelope();
  delete missingFiles.generated_files;
  assert.throws(
    () => parseGenerateEnvelope(missingFiles),
    /generated_files.*missing/,
  );
});

test('protocol version mismatches are rejected by every parser', () => {
  const cases = [
    [parseInspectEnvelope, inspectEnvelope()],
    [parseValidateEnvelope, validateEnvelope()],
    [parseGenerateEnvelope, generateEnvelope()],
  ];
  for (const [parse, envelope] of cases) {
    envelope.protocol_version = 2;
    assert.throws(
      () => parse(envelope),
      (error) => error instanceof HpmProtocolError &&
        error.message.includes('expected 1'),
    );
  }
});

test('generator version must be present, while unknown remains distinguishable', () => {
  assert.equal(isKnownGeneratorVersion('5.2.4'), true);
  assert.equal(isKnownGeneratorVersion('unknown'), false);
  assert.equal(isKnownGeneratorVersion('  '), false);

  const blankVersion = generateEnvelope();
  blankVersion.generator_version = '  ';
  assert.throws(
    () => parseGenerateEnvelope(blankVersion),
    /generator_version.*non-empty/,
  );

  assert.equal(MIN_GENERATOR_VERSION, '5.3.0');
  assert.equal(isGeneratorVersionAtLeast('5.3.0'), true);
  assert.equal(isGeneratorVersionAtLeast('5.4.0'), true);
  assert.equal(isGeneratorVersionAtLeast('5.3.0.dev1'), true);
  assert.equal(isGeneratorVersionAtLeast('5.2.9'), false);
  assert.equal(isGeneratorVersionAtLeast('unknown'), false);
});
