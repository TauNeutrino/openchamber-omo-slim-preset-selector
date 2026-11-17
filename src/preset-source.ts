import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';

import { t } from './i18n.ts';

/** The result of validating one oMo Slim source file. */
export type PresetSourceValidation =
  | { ok: true }
  | { ok: false; message: string; line?: number; column?: number };

const BOM = '\uFEFF';

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** Converts a parser offset into the one-based position shown to the user. */
const positionAt = (content: string, offset: number): { line: number; column: number } => {
  const bounded = Math.max(0, Math.min(offset, content.length));
  const before = content.slice(0, bounded);
  const lastNewline = before.lastIndexOf('\n');
  return {
    line: before.split('\n').length,
    column: bounded - lastNewline,
  };
};

const parseFailure = (content: string, error: ParseError): PresetSourceValidation => {
  const position = positionAt(content, error.offset);
  return {
    ok: false,
    message: t('presetSourceInvalidJsonc', printParseErrorCode(error.error)),
    line: position.line,
    column: position.column,
  };
};

/**
 * Validates the source-file contract shared by the preset panel and editor.
 *
 * A source must be valid JSONC with an object at its root, a `presets` key,
 * and a presets map whose values are all objects. The empty `presets` map is
 * valid; removing the map itself is intentionally refused because it would
 * leave the panel without any presets to select.
 */
export const validatePresetSource = (raw: string): PresetSourceValidation => {
  const content = raw.startsWith(BOM) ? raw.slice(1) : raw;
  if (!content.trim()) {
    return { ok: false, message: t('presetSourceEmpty') };
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return parseFailure(content, errors[0]);
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, message: t('presetSourceRootObject') };
  }
  if (!Object.hasOwn(parsed, 'presets')) {
    return { ok: false, message: t('presetSourceMissingPresets') };
  }

  const presets = parsed.presets;
  if (!isPlainObject(presets)) {
    return { ok: false, message: t('presetSourcePresetsObject') };
  }

  // Object.getOwnPropertyNames also sees a `__proto__` entry, which
  // Object.entries would skip and could therefore hide from the check.
  for (const name of Object.getOwnPropertyNames(presets)) {
    if (!isPlainObject(presets[name])) {
      return { ok: false, message: t('presetSourcePresetValueObject', name) };
    }
  }

  return { ok: true };
};
