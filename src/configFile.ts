import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

import {
  canTimingSupported,
  clockSourcesForSoc,
  defaultClockSettings,
  peripheralClockHz,
  resolveCanClock,
  resolveI2cTiming,
  resolveSpiClock,
  resolveSpiPrescaler,
  resolveUartClock,
  uartBaudrateError,
  type ClockSettings,
  type SpiClockSettings,
} from './clockConfig';
import type { HpmProject, PinmuxPeripheral } from './hpmProject';
import { t } from './i18n';

export type McanConfig = ClockSettings & {
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

export type SpiConfig = SpiClockSettings & {
  enabled: boolean;
  buffer_size: number;
  sclk_hz: number;
  spi_mode?: 0 | 1 | 2 | 3;
  clock_polarity: 'LOW' | 'HIGH';
  clock_phase: 'EDGE_1' | 'EDGE_2';
  cs_active_low: boolean;
  double_buffer: boolean;
  use_dma: boolean;
  tx_dma_channel?: number;
  rx_dma_channel?: number;
  use_gpio_cs: boolean;
  pins: Record<string, string>;
};

export type I2cConfig = ClockSettings & {
  enabled: boolean;
  bus_hz: number;
  address_mode: '7bit' | '10bit';
  use_dma: boolean;
  dma_channel?: number;
  pins: Record<string, string>;
};

export type UartConfig = ClockSettings & {
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

export type PeripheralConfig = {
  version: 1;
  project: {
    board: string;
    soc: string;
    hpmpc: string;
    pinmux_functions: string[];
  };
  spi: Record<string, SpiConfig>;
  i2c: Record<string, I2cConfig>;
  uart: Record<string, UartConfig>;
  mcan: Record<string, McanConfig>;
};

function mcanMode(peripheral: PinmuxPeripheral): 'can' | 'fdcan' {
  const text = [...peripheral.functions, ...peripheral.annotations].join(' ').toLowerCase();
  return text.includes('fdcan') || text.includes('canfd') || text.includes('can fd') ? 'fdcan' : 'can';
}

function spiModeToConfig(mode: number): Pick<SpiConfig, 'clock_polarity' | 'clock_phase'> {
  return {
    clock_polarity: mode >= 2 ? 'HIGH' : 'LOW',
    clock_phase: mode % 2 === 1 ? 'EDGE_2' : 'EDGE_1',
  };
}

function normalizeSpiConfig(value: SpiConfig): void {
  const mode = Number(value.spi_mode);
  const modeConfig = spiModeToConfig(Number.isInteger(mode) && mode >= 0 && mode <= 3 ? mode : 0);
  if (value.clock_polarity !== 'LOW' && value.clock_polarity !== 'HIGH') {
    value.clock_polarity = modeConfig.clock_polarity;
  }
  if (value.clock_phase !== 'EDGE_1' && value.clock_phase !== 'EDGE_2') {
    value.clock_phase = modeConfig.clock_phase;
  }
  value.spi_mode = (value.clock_polarity === 'HIGH' ? 2 : 0) +
    (value.clock_phase === 'EDGE_2' ? 1 : 0) as 0 | 1 | 2 | 3;
  value.cs_active_low = value.cs_active_low !== false;
}

function applyClock(target: ClockSettings, clock: ClockSettings): void {
  target.auto_clock = clock.auto_clock;
  target.clock_source = clock.clock_source;
  target.clock_divider = clock.clock_divider;
  target.peripheral_clock_hz = clock.peripheral_clock_hz;
}

function normalizeManualClock(soc: string, board: string, value: ClockSettings): void {
  const sources = clockSourcesForSoc(soc, board);
  if (!sources.some((source) => source.id === value.clock_source)) {
    value.clock_source = sources[0].id;
  }
  const divider = Number(value.clock_divider);
  value.clock_divider = Number.isInteger(divider) && divider >= 1 && divider <= 256 ? divider : 1;
  value.peripheral_clock_hz = peripheralClockHz(soc, value.clock_source, value.clock_divider, board);
}

function normalizePeripheralClocks(soc: string, config: PeripheralConfig): void {
  const board = config.project.board;
  for (const value of Object.values(config.spi)) {
    if (value.auto_clock !== false) {
      const resolved = resolveSpiClock(soc, value.sclk_hz, board);
      if (resolved) {
        Object.assign(value, resolved);
      }
    } else {
      normalizeManualClock(soc, board, value);
      const resolved = resolveSpiPrescaler(value.peripheral_clock_hz, value.sclk_hz);
      if (resolved) {
        Object.assign(value, resolved);
      }
    }
  }
  for (const value of Object.values(config.i2c)) {
    if (value.auto_clock !== false) {
      applyClock(value, defaultClockSettings(soc, board));
    } else {
      normalizeManualClock(soc, board, value);
    }
  }
  for (const value of Object.values(config.uart)) {
    if (value.auto_clock !== false) {
      const resolved = resolveUartClock(soc, value.baudrate, board);
      if (resolved) {
        applyClock(value, resolved);
      }
    } else {
      normalizeManualClock(soc, board, value);
    }
  }
  for (const value of Object.values(config.mcan)) {
    if (value.auto_clock !== false) {
      const resolved = resolveCanClock(
        soc,
        value.bitrate,
        value.sample_point ?? 0.875,
        value.mode,
        value.data_bitrate,
        value.data_sample_point,
        board,
        value.brs ?? false,
      );
      if (resolved) {
        applyClock(value, resolved);
      }
    } else {
      normalizeManualClock(soc, board, value);
    }
  }
}

export function defaultConfig(project: HpmProject, selectedFunctions: string[] = []): PeripheralConfig {
  const spi: Record<string, SpiConfig> = {};
  const i2c: Record<string, I2cConfig> = {};
  const uart: Record<string, UartConfig> = {};
  const mcan: Record<string, McanConfig> = {};
  const peripherals = project.peripherals;
  const boardHeader = fs.existsSync(project.boardH) ? fs.readFileSync(project.boardH, 'utf8') : '';
  const hasGpioSpiCs = boardHeader.includes('BOARD_SPI_CS_GPIO_CTRL') &&
    boardHeader.includes('BOARD_SPI_CS_PIN') && boardHeader.includes('BOARD_SPI_CS_ACTIVE_LEVEL');
  for (const peripheral of peripherals.filter((item) => item.type === 'SPI')) {
    const clock = resolveSpiClock(project.socName, 20_000_000, project.boardName);
    spi[peripheral.instance] = {
      ...(clock ?? { ...defaultClockSettings(project.socName, project.boardName), prescaler: 'DIV_1' as const, actual_sclk_hz: 0 }),
      enabled: true,
      buffer_size: 256,
      sclk_hz: 20000000,
      clock_polarity: 'LOW',
      clock_phase: 'EDGE_1',
      cs_active_low: true,
      double_buffer: false,
      use_dma: false,
      use_gpio_cs: hasGpioSpiCs && Object.keys(peripheral.pins).some((pin) => pin.startsWith('CS')),
      pins: peripheral.pins,
    };
  }
  for (const peripheral of peripherals.filter((item) => item.type === 'I2C')) {
    i2c[peripheral.instance] = {
      ...defaultClockSettings(project.socName, project.boardName),
      enabled: true,
      bus_hz: 100000,
      address_mode: '7bit',
      use_dma: false,
      pins: peripheral.pins,
    };
  }
  for (const peripheral of peripherals.filter((item) => item.type === 'UART')) {
    uart[peripheral.instance] = {
      ...(resolveUartClock(project.socName, 115200, project.boardName) ?? defaultClockSettings(project.socName, project.boardName)),
      enabled: false,
      baudrate: 115200,
      rx_buffer_size: 256,
      tx_buffer_size: 256,
      tx_queue_size: 5,
      parity: 'NO_PARITY',
      data_bits: 8,
      stop_bits: 1,
      use_dma: true,
      pins: peripheral.pins,
    };
  }
  for (const peripheral of peripherals.filter((item) => item.type === 'MCAN')) {
    const mode = mcanMode(peripheral);
    const clock = resolveCanClock(
      project.socName, 500000, 0.875, mode, 2000000, 0.75, project.boardName, mode === 'fdcan',
    );
    mcan[peripheral.instance] = {
      ...(clock ?? defaultClockSettings(project.socName, project.boardName)),
      enabled: true,
      mode,
      bitrate: 500000,
      queue_size: 8,
      sample_point: 0.875,
      loopback: false,
      listen_only: false,
      one_shot: false,
      pins: peripheral.pins,
    };
    if (mode === 'fdcan') {
      mcan[peripheral.instance].data_bitrate = 2000000;
      mcan[peripheral.instance].data_sample_point = 0.75;
      mcan[peripheral.instance].brs = true;
    }
  }
  return {
    version: 1,
    project: {
      board: project.boardName,
      soc: project.socName,
      hpmpc: path.relative(project.root, project.hpmpcPath).replace(/\\/g, '/'),
      pinmux_functions: selectedFunctions,
    },
    spi,
    i2c,
    uart,
    mcan,
  };
}

export function loadOrCreateConfig(configPath: string, project: HpmProject): PeripheralConfig {
  if (!fs.existsSync(configPath)) {
    const config = defaultConfig(project);
    writeConfig(configPath, config);
    return config;
  }
  const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8')) as Partial<PeripheralConfig> | null;
  return normalizeConfig(project, parsed);
}

export function normalizeConfig(project: HpmProject, parsed?: Partial<PeripheralConfig> | null): PeripheralConfig {
  const availableFunctions = new Set(project.pinmuxFunctions);
  const selectedFunctions = Array.isArray(parsed?.project?.pinmux_functions)
    ? parsed.project.pinmux_functions.filter(
        (name): name is string => typeof name === 'string' && availableFunctions.has(name),
      )
    : [];
  const merged = defaultConfig(project, selectedFunctions);
  if (parsed?.spi) {
    for (const [instance, value] of Object.entries(parsed.spi)) {
      if (!merged.spi[instance]) {
        continue;
      }
      const hasSpiMode = Object.prototype.hasOwnProperty.call(value, 'spi_mode');
      const hasClockPolarity = Object.prototype.hasOwnProperty.call(value, 'clock_polarity');
      const hasClockPhase = Object.prototype.hasOwnProperty.call(value, 'clock_phase');
      merged.spi[instance] = {
        ...merged.spi[instance],
        ...value,
        pins: merged.spi[instance].pins,
      };
      if (hasSpiMode && (!hasClockPolarity || !hasClockPhase)) {
        const modeConfig = spiModeToConfig(Number(value.spi_mode));
        if (!hasClockPolarity) {
          merged.spi[instance].clock_polarity = modeConfig.clock_polarity;
        }
        if (!hasClockPhase) {
          merged.spi[instance].clock_phase = modeConfig.clock_phase;
        }
      }
      normalizeSpiConfig(merged.spi[instance]);
      merged.spi[instance].use_dma = false;
      delete merged.spi[instance].tx_dma_channel;
      delete merged.spi[instance].rx_dma_channel;
    }
  }
  if (parsed?.i2c) {
    for (const [instance, value] of Object.entries(parsed.i2c)) {
      if (!merged.i2c[instance]) {
        continue;
      }
      merged.i2c[instance] = {
        ...merged.i2c[instance],
        ...value,
        pins: merged.i2c[instance].pins,
      };
      merged.i2c[instance].use_dma = false;
      delete merged.i2c[instance].dma_channel;
    }
  }
  if (parsed?.uart) {
    for (const [instance, value] of Object.entries(parsed.uart)) {
      if (!merged.uart[instance]) {
        continue;
      }
      merged.uart[instance] = {
        ...merged.uart[instance],
        ...value,
        pins: merged.uart[instance].pins,
      };
      merged.uart[instance].use_dma = true;
      delete merged.uart[instance].tx_dma_channel;
      delete merged.uart[instance].rx_dma_channel;
    }
  }
  if (parsed?.mcan) {
    for (const [instance, value] of Object.entries(parsed.mcan)) {
      if (!merged.mcan[instance]) {
        continue;
      }
      merged.mcan[instance] = {
        ...merged.mcan[instance],
        ...value,
        pins: merged.mcan[instance].pins,
      };
      merged.mcan[instance].queue_size ??= 8;
      merged.mcan[instance].sample_point ??= 0.875;
      if (merged.mcan[instance].mode === 'can') {
        delete merged.mcan[instance].data_bitrate;
        delete merged.mcan[instance].data_sample_point;
        delete merged.mcan[instance].brs;
        delete merged.mcan[instance].esi;
      } else {
        merged.mcan[instance].data_bitrate ??= 2000000;
        merged.mcan[instance].data_sample_point ??= 0.75;
        merged.mcan[instance].brs ??= true;
        merged.mcan[instance].esi ??= false;
      }
    }
  }
  normalizePeripheralClocks(project.socName, merged);
  return merged;
}

export function writeConfig(configPath: string, config: PeripheralConfig): void {
  normalizePeripheralClocks(config.project.soc, config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(config), 'utf8');
}

export function writeLibxrConfig(libxrConfigPath: string, config: PeripheralConfig): void {
  normalizePeripheralClocks(config.project.soc, config);
  const spi: Record<string, Record<string, unknown>> = {};
  for (const [instance, value] of Object.entries(config.spi)) {
    if (value.enabled) {
      spi[instance.toLowerCase()] = {
        buffer_size: value.buffer_size,
        sclk_hz: value.sclk_hz,
        spi_mode: value.spi_mode,
        prescaler: value.prescaler,
        actual_sclk_hz: value.actual_sclk_hz,
        use_gpio_cs: value.use_gpio_cs,
        clock_polarity: value.clock_polarity,
        clock_phase: value.clock_phase,
        cs_active_low: value.cs_active_low,
        double_buffer: value.double_buffer,
      };
    }
  }

  const i2c: Record<string, Record<string, unknown>> = {};
  for (const [instance, value] of Object.entries(config.i2c)) {
    if (value.enabled) {
      i2c[instance.toLowerCase()] = {
        bus_hz: value.bus_hz,
        address_mode: value.address_mode,
        peripheral_clock_hz: value.peripheral_clock_hz,
      };
    }
  }

  const uart: Record<string, Record<string, unknown>> = {};
  for (const [instance, value] of Object.entries(config.uart)) {
    if (value.enabled) {
      uart[instance.toLowerCase()] = {
        baudrate: value.baudrate,
        rx_buffer_size: value.rx_buffer_size,
        tx_buffer_size: value.tx_buffer_size,
        tx_queue_size: value.tx_queue_size,
        parity: value.parity,
        data_bits: value.data_bits,
        stop_bits: value.stop_bits,
        peripheral_clock_hz: value.peripheral_clock_hz,
      };
    }
  }

  const can: Record<string, Record<string, unknown>> = {};
  const fdcan: Record<string, Record<string, unknown>> = {};
  for (const [instance, value] of Object.entries(config.mcan)) {
    if (!value.enabled) {
      continue;
    }
    const target = value.mode === 'fdcan' ? fdcan : can;
    const key = instance.toLowerCase();
    target[key] = {
      bitrate: value.bitrate,
      queue_size: value.queue_size ?? 8,
      index: Number(instance.replace(/^\D+/, '')),
      sample_point: value.sample_point ?? 0.875,
      peripheral_clock_hz: value.peripheral_clock_hz,
      loopback: value.loopback,
      listen_only: value.listen_only,
      one_shot: value.one_shot,
    };
    if (value.mode === 'fdcan') {
      target[key].data_bitrate = value.data_bitrate ?? 2000000;
      target[key].data_sample_point = value.data_sample_point ?? 0.75;
      target[key].brs = value.brs ?? true;
      target[key].esi = value.esi ?? false;
    }
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(libxrConfigPath)) {
    const parsed = YAML.parse(fs.readFileSync(libxrConfigPath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  }
  const group = (name: string): Record<string, unknown> => {
    const value = existing[name];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  };
  const mergeManaged = (
    name: string,
    managed: string[],
    updates: Record<string, Record<string, unknown>>,
  ): Record<string, unknown> => {
    const result = group(name);
    for (const instance of managed) {
      const key = instance.toLowerCase();
      if (updates[key]) {
        const existingValue = result[key];
        const existingEntry = existingValue && typeof existingValue === 'object' && !Array.isArray(existingValue)
          ? existingValue as Record<string, unknown>
          : {};
        result[key] = { ...existingEntry, ...updates[key] };
      } else {
        delete result[key];
      }
    }
    return result;
  };
  const mcanInstances = Object.keys(config.mcan);
  const disabledPeripherals = [
    ...Object.entries(config.spi),
    ...Object.entries(config.i2c),
    ...Object.entries(config.uart),
    ...Object.entries(config.mcan),
  ].filter(([, value]) => !value.enabled).map(([instance]) => instance.toLowerCase());
  const managedPeripheralNames = new Set([
    ...Object.keys(config.spi),
    ...Object.keys(config.i2c),
    ...Object.keys(config.uart),
    ...Object.keys(config.mcan),
  ].map((instance) => instance.toLowerCase()));
  const existingDisabled = Array.isArray(existing.disabled_peripherals)
    ? existing.disabled_peripherals.map(String).filter(
      (instance) => !managedPeripheralNames.has(instance.toLowerCase()),
    )
    : [];
  const mergedSpi = mergeManaged('SPI', Object.keys(config.spi), spi);
  const mergedI2c = mergeManaged('I2C', Object.keys(config.i2c), i2c);
  const mergedUart = mergeManaged('UART', Object.keys(config.uart), uart);
  for (const instance of Object.keys(config.spi).map((name) => name.toLowerCase())) {
    const entry = mergedSpi[instance] as Record<string, unknown> | undefined;
    if (entry) {
      delete entry.use_dma;
      delete entry.tx_dma_channel;
      delete entry.rx_dma_channel;
    }
  }
  for (const instance of Object.keys(config.i2c).map((name) => name.toLowerCase())) {
    const entry = mergedI2c[instance] as Record<string, unknown> | undefined;
    if (entry) {
      delete entry.use_dma;
      delete entry.dma_channel;
    }
  }
  for (const instance of Object.keys(config.uart).map((name) => name.toLowerCase())) {
    const entry = mergedUart[instance] as Record<string, unknown> | undefined;
    if (entry) {
      delete entry.use_dma;
      delete entry.tx_dma_channel;
      delete entry.rx_dma_channel;
    }
  }
  const output: Record<string, unknown> = {
    ...existing,
    SYSTEM: existing.SYSTEM ?? 'None',
    pinmux_functions: config.project.pinmux_functions,
    disabled_peripherals: [...existingDisabled, ...disabledPeripherals],
    SPI: mergedSpi,
    I2C: mergedI2c,
    UART: mergedUart,
    CAN: mergeManaged('CAN', mcanInstances, can),
    FDCAN: mergeManaged('FDCAN', mcanInstances, fdcan),
    PWM: existing.PWM ?? {},
    GPIO: existing.GPIO ?? {},
    device_aliases: existing.device_aliases ?? {},
  };
  fs.mkdirSync(path.dirname(libxrConfigPath), { recursive: true });
  fs.writeFileSync(libxrConfigPath, YAML.stringify(output), 'utf8');
}

function peripheralSelected(config: PeripheralConfig, project: HpmProject | undefined, instance: string): boolean {
  const selected = new Set(config.project.pinmux_functions);
  if (!project || selected.size === 0) return true;
  const peripheral = project.peripherals.find((item) => item.instance === instance);
  return Boolean(peripheral && (
    peripheral.functions.some((name) => selected.has(name)) ||
    selected.has(`init_${instance.toLowerCase()}_pins`)
  ));
}

export function configurationErrors(config: PeripheralConfig, project?: HpmProject): string[] {
  normalizePeripheralClocks(config.project.soc, config);
  const errors: string[] = [];
  for (const [instance, value] of [
    ...Object.entries(config.spi),
    ...Object.entries(config.i2c),
    ...Object.entries(config.uart),
    ...Object.entries(config.mcan),
  ]) {
    if (value.enabled && peripheralSelected(config, project, instance) &&
      (value.peripheral_clock_hz <= 0 || value.peripheral_clock_hz > 200_000_000)) {
      errors.push(t('config.clockRange', { instance }));
    }
  }
  for (const [instance, value] of Object.entries(config.spi)) {
    if (!value.enabled || !peripheralSelected(config, project, instance)) continue;
    if (!Number.isInteger(value.buffer_size) || value.buffer_size <= 0) {
      errors.push(t('config.spiBufferSize', { instance }));
    }
    if (value.double_buffer && value.buffer_size < 2) {
      errors.push(t('config.spiDoubleBuffer', { instance }));
    }
    if (!value.actual_sclk_hz || value.actual_sclk_hz > value.sclk_hz) {
      errors.push(t('config.spiSclkUnreachable', { instance, requestedHz: value.sclk_hz }));
    }
    if (!value.use_gpio_cs && !value.cs_active_low) {
      errors.push(t('config.spiHardwareCsActiveHigh', { instance }));
    }
  }
  for (const [instance, value] of Object.entries(config.i2c)) {
    if (!peripheralSelected(config, project, instance)) continue;
    if (value.enabled && ![100000, 400000, 1000000].includes(value.bus_hz)) {
      errors.push(t('config.i2cBusRate', { instance }));
    }
    if (value.enabled && value.address_mode !== '7bit' && value.address_mode !== '10bit') {
      errors.push(t('config.i2cAddressMode', { instance }));
    }
    if (value.enabled && !resolveI2cTiming(value.peripheral_clock_hz, value.bus_hz)) {
      errors.push(t('config.i2cTiming', {
        instance,
        busHz: value.bus_hz,
        clockHz: value.peripheral_clock_hz,
      }));
    }
  }
  for (const [instance, value] of Object.entries(config.uart)) {
    if (!peripheralSelected(config, project, instance)) continue;
    if (value.enabled && uartBaudrateError(value.peripheral_clock_hz, value.baudrate) === undefined) {
      errors.push(t('config.uartBaudrate', { instance, baudrate: value.baudrate }));
    }
    if (value.enabled && (!Number.isInteger(value.rx_buffer_size) || value.rx_buffer_size <= 0)) {
      errors.push(t('config.uartRxBuffer', { instance }));
    }
    if (value.enabled && (!Number.isInteger(value.tx_buffer_size) || value.tx_buffer_size < 2)) {
      errors.push(t('config.uartTxBuffer', { instance }));
    }
    if (value.enabled && (!Number.isInteger(value.tx_queue_size) || value.tx_queue_size <= 0)) {
      errors.push(t('config.uartTxQueue', { instance }));
    }
    if (value.enabled && !['NO_PARITY', 'EVEN', 'ODD'].includes(value.parity)) {
      errors.push(t('config.uartParity', { instance }));
    }
    if (value.enabled && ![5, 6, 7, 8].includes(value.data_bits)) {
      errors.push(t('config.uartDataBits', { instance }));
    }
    if (value.enabled && ![1, 2].includes(value.stop_bits)) {
      errors.push(t('config.uartStopBits', { instance }));
    }
  }
  for (const [instance, value] of Object.entries(config.mcan)) {
    if (!value.enabled || !peripheralSelected(config, project, instance)) continue;
    if (value.mode !== 'can' && value.mode !== 'fdcan') {
      errors.push(t('config.canMode', { instance }));
      continue;
    }
    const nominalKind = value.mode === 'fdcan' ? 'fdcan_nominal' : 'can';
    if (!canTimingSupported(value.peripheral_clock_hz, value.bitrate, value.sample_point ?? 0.875, nominalKind)) {
      errors.push(t('config.canNominalTiming', { instance, clockHz: value.peripheral_clock_hz }));
    }
    if (value.mode === 'fdcan' && !canTimingSupported(
      value.peripheral_clock_hz,
      value.data_bitrate ?? value.bitrate,
      value.data_sample_point ?? value.sample_point ?? 0.75,
      'fdcan_data',
      value.brs ? 2 : 256,
    )) {
      errors.push(t('config.canDataTiming', { instance, clockHz: value.peripheral_clock_hz }));
    }
    if (!Number.isInteger(value.queue_size) || (value.queue_size ?? 0) <= 0) {
      errors.push(t('config.canQueue', { instance }));
    }
    if (value.loopback && value.listen_only) {
      errors.push(t('config.canModeConflict', { instance }));
    }
  }
  const gpioCsLevels = new Set(
    Object.entries(config.spi)
      .filter(([instance, value]) => value.enabled && value.use_gpio_cs && peripheralSelected(config, project, instance))
      .map(([, value]) => value.cs_active_low),
  );
  if (gpioCsLevels.size > 1) {
    errors.push(t('config.gpioCsPolarity'));
  }
  const gpioCsCount = Object.entries(config.spi).filter(
    ([instance, value]) => value.enabled && value.use_gpio_cs && peripheralSelected(config, project, instance),
  ).length;
  if (gpioCsCount > 1) {
    errors.push(t('config.gpioCsCount'));
  }
  return errors;
}

export function assertValidConfig(config: PeripheralConfig, project?: HpmProject): void {
  const errors = configurationErrors(config, project);
  if (errors.length > 0) {
    throw new Error(`${t('config.validationFailed')}\n${errors.join('\n')}`);
  }
}

export function configurationWarnings(config: PeripheralConfig, project?: HpmProject): string[] {
  normalizePeripheralClocks(config.project.soc, config);
  const warnings: string[] = [];
  if (config.project.soc.toUpperCase() !== 'HPM5361' || config.project.board.toLowerCase() !== 'hpm5361evklite') {
    warnings.push(t('config.clockTreeLimited', { board: config.project.board }));
  }
  for (const [instance, value] of Object.entries(config.spi)) {
    if (!value.enabled || !peripheralSelected(config, project, instance)) continue;
    if (value.actual_sclk_hz !== value.sclk_hz) {
      warnings.push(t('config.spiSclkAdjusted', {
        instance,
        requestedHz: value.sclk_hz,
        actualHz: value.actual_sclk_hz,
      }));
    }
    if (!value.use_gpio_cs) {
      warnings.push(t('config.spiHardwareCsFixed', { instance }));
    }
  }
  return warnings;
}
