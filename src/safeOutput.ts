const DEFAULT_MAX_CHARACTERS = 4096;
const REDACTED = '<REDACTED>';

const SENSITIVE_FIELD = [
  'api[_-]?key',
  'authorization',
  'clientKey',
  'cookie',
  'password',
  'passwd',
  'refresh[_-]?token',
  'secretKey',
  'session[_-]?(?:id|token)',
  'token',
].join('|');

export type SafeOutputExcerpt = {
  text: string;
  truncated: boolean;
  omittedCharacters: number;
};

function redactSensitiveValues(value: string): string {
  const quotedField = new RegExp(
    `((?:"|')?(?:${SENSITIVE_FIELD})(?:"|')?\\s*[:=]\\s*)(["'])([^\\r\\n]*?)\\2`,
    'gi',
  );
  const unquotedField = new RegExp(
    `((?:"|')?(?:${SENSITIVE_FIELD})(?:"|')?\\s*[:=]\\s*)(?!["'])([^\\s,;}\\]]+)`,
    'gi',
  );
  return value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      '<REDACTED PRIVATE KEY>',
    )
    .replace(/\b(authorization\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`)
    .replace(quotedField, (_match, prefix: string, quote: string) => (
      `${prefix}${quote}${REDACTED}${quote}`
    ))
    .replace(unquotedField, `$1${REDACTED}`)
    .replace(/([?&](?:api[_-]?key|password|secret|token)=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, REDACTED)
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, REDACTED)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function safeOutputExcerpt(
  value: string,
  maxCharacters = DEFAULT_MAX_CHARACTERS,
): SafeOutputExcerpt {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    throw new RangeError('maxCharacters must be a positive integer.');
  }
  const redacted = redactSensitiveValues(value).trimEnd();
  if (redacted.length <= maxCharacters) {
    return { text: redacted, truncated: false, omittedCharacters: 0 };
  }
  return {
    text: redacted.slice(0, maxCharacters),
    truncated: true,
    omittedCharacters: redacted.length - maxCharacters,
  };
}
