const assert = require('node:assert/strict');
const test = require('node:test');

const { isValidateOperationFailure } = require('../out/validationOutcome.js');

function envelope(code, normalizedConfig = { version: 1 }) {
  return {
    protocol_version: 1,
    generator_version: '5.3.0',
    valid: false,
    normalized_config: normalizedConfig,
    errors: [{
      code,
      level: 'error',
      peripheral: null,
      field: null,
      message: 'test diagnostic',
    }],
    warnings: [],
  };
}

test('classifies validate write failures as operation failures', () => {
  assert.equal(
    isValidateOperationFailure(envelope('HPM_CONFIG_VALIDATION_FAILED', {})),
    true,
  );
  assert.equal(
    isValidateOperationFailure(envelope('HPM_CONFIG_VALIDATION_FAILED')),
    true,
  );
});

test('allows a saved normalized config to retain business validation errors', () => {
  assert.equal(
    isValidateOperationFailure(envelope('HPM_UART_BAUDRATE_UNREACHABLE')),
    false,
  );
});
