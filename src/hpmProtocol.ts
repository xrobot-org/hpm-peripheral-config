export const PROTOCOL_VERSION = 1 as const;
export const UNKNOWN_GENERATOR_VERSION = 'unknown';
export const MIN_GENERATOR_VERSION = '5.3.0';

export type ClockSourceIdDto = string;
export type SpiPrescalerDto = string;

export type ClockSettingsDto = {
  auto_clock: boolean;
  clock_source: ClockSourceIdDto;
  clock_divider: number;
  peripheral_clock_hz: number;
};

export type SpiConfigDto = ClockSettingsDto & {
  enabled: boolean;
  buffer_size: number;
  sclk_hz: number;
  spi_mode?: 0 | 1 | 2 | 3;
  prescaler: SpiPrescalerDto;
  actual_sclk_hz: number;
  clock_polarity: 'LOW' | 'HIGH';
  clock_phase: 'EDGE_1' | 'EDGE_2';
  hardware_cs_index?: 0 | 1 | 2 | 3;
  cs_active_low: boolean;
  double_buffer: boolean;
  use_dma: boolean;
  tx_dma_channel?: number;
  rx_dma_channel?: number;
  use_gpio_cs: boolean;
  pins: Record<string, string>;
};

export type I2cConfigDto = ClockSettingsDto & {
  enabled: boolean;
  bus_hz: number;
  address_mode: '7bit' | '10bit';
  use_dma: boolean;
  dma_channel?: number;
  pins: Record<string, string>;
};

export type UartConfigDto = ClockSettingsDto & {
  enabled: boolean;
  baudrate: number;
  rx_buffer_size: number;
  tx_buffer_size: number;
  tx_queue_size: number;
  parity: 'NO_PARITY' | 'EVEN' | 'ODD';
  data_bits: 5 | 6 | 7 | 8;
  stop_bits: 1 | 2;
  use_dma: boolean;
  tx_dma_channel?: number;
  rx_dma_channel?: number;
  pins: Record<string, string>;
};

export type McanConfigDto = ClockSettingsDto & {
  enabled: boolean;
  mode: 'can' | 'fdcan';
  bitrate: number;
  sample_point?: number;
  data_bitrate?: number;
  data_sample_point?: number;
  brs?: boolean;
  queue_size?: number;
  loopback: boolean;
  listen_only: boolean;
  one_shot: boolean;
  esi?: boolean;
  pins: Record<string, string>;
};

export type PeripheralConfigDto = {
  version: 1;
  project: {
    board: string;
    soc: string;
    package?: string;
    sdk?: string;
    hpmpc: string;
    pinmux_functions: string[];
  };
  spi: Record<string, SpiConfigDto>;
  i2c: Record<string, I2cConfigDto>;
  uart: Record<string, UartConfigDto>;
  mcan: Record<string, McanConfigDto>;
};

export type Diagnostic = {
  code: string;
  level: 'error' | 'warning';
  peripheral: string | null;
  field: string | null;
  message: string;
};

type BaseEnvelope = {
  protocol_version: 1;
  generator_version: string;
  errors: Diagnostic[];
  warnings: Diagnostic[];
};

export type InspectProjectDto = {
  board: string;
  soc: string;
  package: string;
  sdk: string;
  hpmpc: string;
};

export type InspectPeripheralDto = {
  instance: string;
  type: string;
  index: number;
  pins: Record<string, string>;
  functions: string[];
  annotations: string[];
  function_pins?: Record<string, Record<string, string>>;
};

export type InspectClockSourceDto = {
  id: string;
  c_symbol: string;
  hz: number;
};

export type NumericRangeDto = {
  min: number;
  max?: number;
  step?: number;
};

export type InspectCapabilitiesDto = {
  spi: {
    modes: number[];
    clock_polarities: string[];
    clock_phases: string[];
    prescalers: string[];
    buffer_size: NumericRangeDto;
    clock_divider: NumericRangeDto;
    dma_supported: boolean;
    gpio_cs: { max_instances: number };
  };
  i2c: {
    bus_rates: number[];
    address_modes: string[];
    fixed_dma_channel: boolean;
    runtime_dma_allocation: boolean;
  };
  uart: {
    parity: string[];
    data_bits: number[];
    stop_bits: number[];
    dma: {
      automatic: boolean;
      channel_min: number;
      channel_max: number;
      channel_count: number;
      rx_mode?: 'dma' | 'irq';
      tx_mode?: 'dma';
      channels_per_uart?: number;
    };
  };
  mcan: {
    modes: string[];
    sample_point: NumericRangeDto;
    data_fields: string[];
    queue_size: NumericRangeDto;
  };
};

type EmptyDto = Record<string, never>;

export type InspectEnvelope = BaseEnvelope & {
  project: InspectProjectDto | EmptyDto;
  pinmux_functions: string[];
  peripherals: InspectPeripheralDto[];
  clock_functions: string[];
  clock_sources: InspectClockSourceDto[];
  capabilities: InspectCapabilitiesDto;
};

export type ValidateEnvelope = BaseEnvelope & {
  valid: boolean;
  normalized_config: PeripheralConfigDto | Record<string, unknown>;
};

export type GenerateEnvelope = BaseEnvelope & {
  success: boolean;
  generated_files: string[];
};

type JsonObject = Record<string, unknown>;

export class HpmProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HpmProtocolError';
  }
}

function fail(path: string, message: string): never {
  throw new HpmProtocolError(`${path} ${message}`);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object.');
  }
  return value as JsonObject;
}

function required(object: JsonObject, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    fail(`${path}.${key}`, 'is missing.');
  }
  return object[key];
}

function stringAt(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== 'string' || (nonEmpty && value.trim() === '')) {
    fail(path, nonEmpty ? 'must be a non-empty string.' : 'must be a string.');
  }
  return value;
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'must be a finite number.');
  }
  return value;
}

function integerAt(value: unknown, path: string): number {
  const number = numberAt(value, path);
  if (!Number.isInteger(number)) {
    fail(path, 'must be an integer.');
  }
  return number;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    fail(path, 'must be a boolean.');
  }
  return value;
}

function oneOf(value: unknown, values: readonly unknown[], path: string): void {
  if (!values.includes(value)) {
    fail(path, `must be one of ${values.join(', ')}.`);
  }
}

function optional(
  object: JsonObject,
  key: string,
  path: string,
  validate: (value: unknown, fieldPath: string) => unknown,
): void {
  if (Object.prototype.hasOwnProperty.call(object, key)) {
    validate(object[key], `${path}.${key}`);
  }
}

function stringArrayAt(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail(path, 'must be an array.');
  }
  return value.map((item, index) => stringAt(item, `${path}[${index}]`));
}

function numberArrayAt(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) {
    fail(path, 'must be an array.');
  }
  return value.map((item, index) => numberAt(item, `${path}[${index}]`));
}

function stringRecordAt(value: unknown, path: string): Record<string, string> {
  const object = objectAt(value, path);
  for (const [key, item] of Object.entries(object)) {
    stringAt(item, `${path}.${key}`);
  }
  return object as Record<string, string>;
}

function recordAt(
  value: unknown,
  path: string,
  validate: (entry: JsonObject, entryPath: string) => void,
): void {
  const object = objectAt(value, path);
  for (const [key, item] of Object.entries(object)) {
    if (!key) {
      fail(path, 'must not contain an empty instance name.');
    }
    validate(objectAt(item, `${path}.${key}`), `${path}.${key}`);
  }
}

function assertClockSettings(value: JsonObject, path: string): void {
  booleanAt(required(value, 'auto_clock', path), `${path}.auto_clock`);
  stringAt(required(value, 'clock_source', path), `${path}.clock_source`, true);
  integerAt(required(value, 'clock_divider', path), `${path}.clock_divider`);
  integerAt(required(value, 'peripheral_clock_hz', path), `${path}.peripheral_clock_hz`);
}

function assertPins(value: JsonObject, path: string): void {
  stringRecordAt(required(value, 'pins', path), `${path}.pins`);
}

function assertSpiConfig(value: JsonObject, path: string): void {
  assertClockSettings(value, path);
  booleanAt(required(value, 'enabled', path), `${path}.enabled`);
  integerAt(required(value, 'buffer_size', path), `${path}.buffer_size`);
  integerAt(required(value, 'sclk_hz', path), `${path}.sclk_hz`);
  optional(value, 'spi_mode', path, (item, itemPath) => {
    integerAt(item, itemPath);
    oneOf(item, [0, 1, 2, 3], itemPath);
  });
  stringAt(required(value, 'prescaler', path), `${path}.prescaler`, true);
  integerAt(required(value, 'actual_sclk_hz', path), `${path}.actual_sclk_hz`);
  oneOf(required(value, 'clock_polarity', path), ['LOW', 'HIGH'], `${path}.clock_polarity`);
  oneOf(required(value, 'clock_phase', path), ['EDGE_1', 'EDGE_2'], `${path}.clock_phase`);
  optional(value, 'hardware_cs_index', path, (item, itemPath) => {
    integerAt(item, itemPath);
    oneOf(item, [0, 1, 2, 3], itemPath);
  });
  booleanAt(required(value, 'cs_active_low', path), `${path}.cs_active_low`);
  booleanAt(required(value, 'double_buffer', path), `${path}.double_buffer`);
  booleanAt(required(value, 'use_dma', path), `${path}.use_dma`);
  optional(value, 'tx_dma_channel', path, integerAt);
  optional(value, 'rx_dma_channel', path, integerAt);
  booleanAt(required(value, 'use_gpio_cs', path), `${path}.use_gpio_cs`);
  assertPins(value, path);
}

function assertI2cConfig(value: JsonObject, path: string): void {
  assertClockSettings(value, path);
  booleanAt(required(value, 'enabled', path), `${path}.enabled`);
  integerAt(required(value, 'bus_hz', path), `${path}.bus_hz`);
  oneOf(required(value, 'address_mode', path), ['7bit', '10bit'], `${path}.address_mode`);
  booleanAt(required(value, 'use_dma', path), `${path}.use_dma`);
  optional(value, 'dma_channel', path, integerAt);
  assertPins(value, path);
}

function assertUartConfig(value: JsonObject, path: string): void {
  assertClockSettings(value, path);
  booleanAt(required(value, 'enabled', path), `${path}.enabled`);
  integerAt(required(value, 'baudrate', path), `${path}.baudrate`);
  integerAt(required(value, 'rx_buffer_size', path), `${path}.rx_buffer_size`);
  integerAt(required(value, 'tx_buffer_size', path), `${path}.tx_buffer_size`);
  integerAt(required(value, 'tx_queue_size', path), `${path}.tx_queue_size`);
  oneOf(required(value, 'parity', path), ['NO_PARITY', 'EVEN', 'ODD'], `${path}.parity`);
  oneOf(required(value, 'data_bits', path), [5, 6, 7, 8], `${path}.data_bits`);
  oneOf(required(value, 'stop_bits', path), [1, 2], `${path}.stop_bits`);
  booleanAt(required(value, 'use_dma', path), `${path}.use_dma`);
  optional(value, 'tx_dma_channel', path, integerAt);
  optional(value, 'rx_dma_channel', path, integerAt);
  assertPins(value, path);
}

function assertMcanConfig(value: JsonObject, path: string): void {
  assertClockSettings(value, path);
  booleanAt(required(value, 'enabled', path), `${path}.enabled`);
  oneOf(required(value, 'mode', path), ['can', 'fdcan'], `${path}.mode`);
  integerAt(required(value, 'bitrate', path), `${path}.bitrate`);
  optional(value, 'sample_point', path, numberAt);
  optional(value, 'data_bitrate', path, integerAt);
  optional(value, 'data_sample_point', path, numberAt);
  optional(value, 'brs', path, booleanAt);
  optional(value, 'queue_size', path, integerAt);
  booleanAt(required(value, 'loopback', path), `${path}.loopback`);
  booleanAt(required(value, 'listen_only', path), `${path}.listen_only`);
  booleanAt(required(value, 'one_shot', path), `${path}.one_shot`);
  optional(value, 'esi', path, booleanAt);
  assertPins(value, path);
}

function assertPeripheralConfig(value: JsonObject, path: string): void {
  if (required(value, 'version', path) !== 1) {
    fail(`${path}.version`, 'must be 1.');
  }
  const project = objectAt(required(value, 'project', path), `${path}.project`);
  stringAt(required(project, 'board', `${path}.project`), `${path}.project.board`);
  stringAt(required(project, 'soc', `${path}.project`), `${path}.project.soc`);
  optional(project, 'package', `${path}.project`, stringAt);
  optional(project, 'sdk', `${path}.project`, stringAt);
  stringAt(required(project, 'hpmpc', `${path}.project`), `${path}.project.hpmpc`);
  stringArrayAt(
    required(project, 'pinmux_functions', `${path}.project`),
    `${path}.project.pinmux_functions`,
  );
  recordAt(required(value, 'spi', path), `${path}.spi`, assertSpiConfig);
  recordAt(required(value, 'i2c', path), `${path}.i2c`, assertI2cConfig);
  recordAt(required(value, 'uart', path), `${path}.uart`, assertUartConfig);
  recordAt(required(value, 'mcan', path), `${path}.mcan`, assertMcanConfig);
}

function assertDiagnostic(value: unknown, path: string, level: 'error' | 'warning'): void {
  const diagnostic = objectAt(value, path);
  stringAt(required(diagnostic, 'code', path), `${path}.code`, true);
  if (required(diagnostic, 'level', path) !== level) {
    fail(`${path}.level`, `must be ${level}.`);
  }
  for (const key of ['peripheral', 'field'] as const) {
    const item = required(diagnostic, key, path);
    if (item !== null) {
      stringAt(item, `${path}.${key}`);
    }
  }
  stringAt(required(diagnostic, 'message', path), `${path}.message`, true);
}

function assertDiagnostics(
  value: unknown,
  path: string,
  level: 'error' | 'warning',
): Diagnostic[] {
  if (!Array.isArray(value)) {
    fail(path, 'must be an array.');
  }
  value.forEach((item, index) => assertDiagnostic(item, `${path}[${index}]`, level));
  return value as Diagnostic[];
}

function parseBaseEnvelope(input: unknown): JsonObject {
  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new HpmProtocolError('HPM CLI response is not valid JSON.');
    }
  }
  const envelope = objectAt(parsed, '$');
  const version = required(envelope, 'protocol_version', '$');
  if (version !== PROTOCOL_VERSION) {
    fail('$.protocol_version', `is ${String(version)}; expected ${PROTOCOL_VERSION}.`);
  }
  stringAt(required(envelope, 'generator_version', '$'), '$.generator_version', true);
  assertDiagnostics(required(envelope, 'errors', '$'), '$.errors', 'error');
  assertDiagnostics(required(envelope, 'warnings', '$'), '$.warnings', 'warning');
  return envelope;
}

function isEmptyObject(value: JsonObject): boolean {
  return Object.keys(value).length === 0;
}

function assertInspectProject(value: JsonObject, path: string): void {
  for (const key of ['board', 'soc', 'package', 'sdk', 'hpmpc'] as const) {
    stringAt(required(value, key, path), `${path}.${key}`);
  }
}

function assertInspectPeripheral(value: unknown, path: string): void {
  const peripheral = objectAt(value, path);
  stringAt(required(peripheral, 'instance', path), `${path}.instance`, true);
  stringAt(required(peripheral, 'type', path), `${path}.type`, true);
  integerAt(required(peripheral, 'index', path), `${path}.index`);
  stringRecordAt(required(peripheral, 'pins', path), `${path}.pins`);
  stringArrayAt(required(peripheral, 'functions', path), `${path}.functions`);
  stringArrayAt(required(peripheral, 'annotations', path), `${path}.annotations`);
  optional(peripheral, 'function_pins', path, (functionPins, functionPinsPath) => {
    recordAt(functionPins, functionPinsPath, (pins, pinsPath) => {
      stringRecordAt(pins, pinsPath);
    });
  });
}

function assertClockSource(value: unknown, path: string): void {
  const source = objectAt(value, path);
  stringAt(required(source, 'id', path), `${path}.id`, true);
  stringAt(required(source, 'c_symbol', path), `${path}.c_symbol`, true);
  integerAt(required(source, 'hz', path), `${path}.hz`);
}

function assertNumericRange(value: unknown, path: string): void {
  const range = objectAt(value, path);
  numberAt(required(range, 'min', path), `${path}.min`);
  optional(range, 'max', path, numberAt);
  optional(range, 'step', path, numberAt);
}

function assertCapabilities(value: unknown, path: string): void {
  const capabilities = objectAt(value, path);
  const spi = objectAt(required(capabilities, 'spi', path), `${path}.spi`);
  numberArrayAt(required(spi, 'modes', `${path}.spi`), `${path}.spi.modes`);
  stringArrayAt(
    required(spi, 'clock_polarities', `${path}.spi`),
    `${path}.spi.clock_polarities`,
  );
  stringArrayAt(required(spi, 'clock_phases', `${path}.spi`), `${path}.spi.clock_phases`);
  stringArrayAt(required(spi, 'prescalers', `${path}.spi`), `${path}.spi.prescalers`);
  assertNumericRange(required(spi, 'buffer_size', `${path}.spi`), `${path}.spi.buffer_size`);
  assertNumericRange(
    required(spi, 'clock_divider', `${path}.spi`),
    `${path}.spi.clock_divider`,
  );
  booleanAt(required(spi, 'dma_supported', `${path}.spi`), `${path}.spi.dma_supported`);
  const gpioCs = objectAt(required(spi, 'gpio_cs', `${path}.spi`), `${path}.spi.gpio_cs`);
  integerAt(
    required(gpioCs, 'max_instances', `${path}.spi.gpio_cs`),
    `${path}.spi.gpio_cs.max_instances`,
  );

  const i2c = objectAt(required(capabilities, 'i2c', path), `${path}.i2c`);
  numberArrayAt(required(i2c, 'bus_rates', `${path}.i2c`), `${path}.i2c.bus_rates`);
  stringArrayAt(
    required(i2c, 'address_modes', `${path}.i2c`),
    `${path}.i2c.address_modes`,
  );
  booleanAt(
    required(i2c, 'fixed_dma_channel', `${path}.i2c`),
    `${path}.i2c.fixed_dma_channel`,
  );
  booleanAt(
    required(i2c, 'runtime_dma_allocation', `${path}.i2c`),
    `${path}.i2c.runtime_dma_allocation`,
  );

  const uart = objectAt(required(capabilities, 'uart', path), `${path}.uart`);
  stringArrayAt(required(uart, 'parity', `${path}.uart`), `${path}.uart.parity`);
  numberArrayAt(required(uart, 'data_bits', `${path}.uart`), `${path}.uart.data_bits`);
  numberArrayAt(required(uart, 'stop_bits', `${path}.uart`), `${path}.uart.stop_bits`);
  const dma = objectAt(required(uart, 'dma', `${path}.uart`), `${path}.uart.dma`);
  booleanAt(required(dma, 'automatic', `${path}.uart.dma`), `${path}.uart.dma.automatic`);
  for (const key of ['channel_min', 'channel_max', 'channel_count'] as const) {
    integerAt(required(dma, key, `${path}.uart.dma`), `${path}.uart.dma.${key}`);
  }
  optional(dma, 'rx_mode', `${path}.uart.dma`, (item, itemPath) => {
    oneOf(item, ['dma', 'irq'], itemPath);
  });
  optional(dma, 'tx_mode', `${path}.uart.dma`, (item, itemPath) => {
    oneOf(item, ['dma'], itemPath);
  });
  optional(dma, 'channels_per_uart', `${path}.uart.dma`, (item, itemPath) => {
    integerAt(item, itemPath);
    oneOf(item, [1, 2], itemPath);
  });
  if (dma.rx_mode !== undefined && dma.channels_per_uart !== undefined) {
    const expectedChannels = dma.rx_mode === 'irq' ? 1 : 2;
    if (dma.channels_per_uart !== expectedChannels) {
      fail(
        `${path}.uart.dma.channels_per_uart`,
        `must be ${expectedChannels} when rx_mode is ${String(dma.rx_mode)}.`,
      );
    }
  }

  const mcan = objectAt(required(capabilities, 'mcan', path), `${path}.mcan`);
  stringArrayAt(required(mcan, 'modes', `${path}.mcan`), `${path}.mcan.modes`);
  assertNumericRange(
    required(mcan, 'sample_point', `${path}.mcan`),
    `${path}.mcan.sample_point`,
  );
  stringArrayAt(required(mcan, 'data_fields', `${path}.mcan`), `${path}.mcan.data_fields`);
  assertNumericRange(required(mcan, 'queue_size', `${path}.mcan`), `${path}.mcan.queue_size`);
}

export function isKnownGeneratorVersion(version: string): boolean {
  return typeof version === 'string' && version.trim() !== '' &&
    version.trim().toLowerCase() !== UNKNOWN_GENERATOR_VERSION;
}

export function isGeneratorVersionAtLeast(
  version: string,
  minimum = MIN_GENERATOR_VERSION,
): boolean {
  const parse = (value: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+.]|$)/.exec(value.trim());
    return match ? match.slice(1).map(Number) : undefined;
  };
  const actual = parse(version);
  const required = parse(minimum);
  if (!actual || !required) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index]) {
      return actual[index] > required[index];
    }
  }
  return true;
}

export function parseInspectEnvelope(input: unknown): InspectEnvelope {
  const envelope = parseBaseEnvelope(input);
  const project = objectAt(required(envelope, 'project', '$'), '$.project');
  if (isEmptyObject(project)) {
    const errors = envelope.errors as Diagnostic[];
    if (errors.length === 0) {
      fail('$.project', 'must not be empty when inspect has no errors.');
    }
  } else {
    assertInspectProject(project, '$.project');
  }
  stringArrayAt(required(envelope, 'pinmux_functions', '$'), '$.pinmux_functions');
  const peripherals = required(envelope, 'peripherals', '$');
  if (!Array.isArray(peripherals)) {
    fail('$.peripherals', 'must be an array.');
  }
  peripherals.forEach((item, index) => assertInspectPeripheral(item, `$.peripherals[${index}]`));
  stringArrayAt(required(envelope, 'clock_functions', '$'), '$.clock_functions');
  const clockSources = required(envelope, 'clock_sources', '$');
  if (!Array.isArray(clockSources)) {
    fail('$.clock_sources', 'must be an array.');
  }
  clockSources.forEach((item, index) => assertClockSource(item, `$.clock_sources[${index}]`));
  const capabilities = objectAt(required(envelope, 'capabilities', '$'), '$.capabilities');
  if (isEmptyObject(capabilities)) {
    const errors = envelope.errors as Diagnostic[];
    if (errors.length === 0) {
      fail('$.capabilities', 'must not be empty when inspect has no errors.');
    }
  } else {
    assertCapabilities(capabilities, '$.capabilities');
  }
  return envelope as InspectEnvelope;
}

export function parseValidateEnvelope(input: unknown): ValidateEnvelope {
  const envelope = parseBaseEnvelope(input);
  const valid = booleanAt(required(envelope, 'valid', '$'), '$.valid');
  const config = objectAt(
    required(envelope, 'normalized_config', '$'),
    '$.normalized_config',
  );
  if (valid && isEmptyObject(config)) {
    fail('$.normalized_config', 'must not be empty when valid is true.');
  }
  if (valid) {
    assertPeripheralConfig(config, '$.normalized_config');
  }
  return envelope as ValidateEnvelope;
}

export function parseGenerateEnvelope(input: unknown): GenerateEnvelope {
  const envelope = parseBaseEnvelope(input);
  booleanAt(required(envelope, 'success', '$'), '$.success');
  stringArrayAt(required(envelope, 'generated_files', '$'), '$.generated_files');
  return envelope as GenerateEnvelope;
}
