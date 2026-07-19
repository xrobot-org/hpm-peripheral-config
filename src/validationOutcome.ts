import type { ValidateEnvelope } from './hpmProtocol';

const OPERATION_ERROR_CODES = new Set([
  'HPM_CONFIG_VALIDATION_FAILED',
  'HPM_INTERNAL_ERROR',
  'HPM_PERIPHERAL_CONFIG_INVALID',
]);

export function isValidateOperationFailure(validation: ValidateEnvelope): boolean {
  if (validation.normalized_config.version !== 1) {
    return true;
  }
  return validation.errors.some((diagnostic) => OPERATION_ERROR_CODES.has(diagnostic.code));
}
