const assert = require('node:assert/strict');
const test = require('node:test');

const {
  canTimingSupported,
  resolveCanClock,
  resolveI2cTiming,
  resolveSpiClock,
  resolveSpiPrescaler,
  uartBaudrateError,
} = require('../out/clockConfig.js');

test('HPM5361 SPI auto clock reaches 20 MHz exactly', () => {
  const result = resolveSpiClock('HPM5361', 20_000_000, 'hpm5361evklite');
  assert.equal(result.actual_sclk_hz, 20_000_000);
  assert.equal(result.peripheral_clock_hz, 20_000_000);
  assert.equal(result.prescaler, 'DIV_1');
});

test('HPM5361 auto CAN clock supports nominal and data phases', () => {
  const result = resolveCanClock('HPM5361', 1_000_000, 0.75, 'fdcan', 2_500_000, 0.75, 'hpm5361evklite');
  assert.equal(result.peripheral_clock_hz, 80_000_000);
  assert.equal(canTimingSupported(result.peripheral_clock_hz, 2_500_000, 0.75, 'fdcan_data'), true);
});

test('clock checks reject unsupported UART and CAN combinations', () => {
  assert.equal(uartBaudrateError(1_000_000, 2_000_000), undefined);
  assert.equal(canTimingSupported(80_000_000, 1_000_000, 0.731, 'can'), false);
  assert.equal(canTimingSupported(60_000_000, 125_000, 0.756, 'can'), false);
  assert.equal(canTimingSupported(200_000_000, 2_000_000, 0.75, 'fdcan_data', 2), false);
});

test('manual SPI and I2C checks match HPM timing constraints', () => {
  assert.equal(resolveSpiPrescaler(95_142_857, 20_000_000), undefined);
  assert.equal(resolveI2cTiming(93_750, 1_000_000), undefined);
  assert.equal(resolveI2cTiming(24_000_000, 1_000_000).actual_hz, 1_001_602);
});

test('unverified HPM5361 boards expose oscillator only', () => {
  const result = resolveSpiClock('HPM5361', 20_000_000, 'custom_board');
  assert.equal(result.clock_source, 'osc24m');
  assert.equal(result.actual_sclk_hz, 12_000_000);
});
