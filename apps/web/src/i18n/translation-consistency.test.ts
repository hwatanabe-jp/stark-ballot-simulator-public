import { parseSync, Visitor, type Node } from 'oxc-parser';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ja } from './translations/ja';
import { en } from './translations/en';
import { INFOGRAPHIC_GUARANTEE_KEYS, INFOGRAPHIC_STEP_KEYS } from './dynamic-keys';
import { KNOWLEDGE_KEYS } from '@stark-ballot/web/knowledge/types';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const LANGUAGE_CODES = new Set(['ja', 'en']);
const TRANSLATION_PREFIXES = new Set(Object.keys(ja));
const INVALID_KEY_SUFFIXES = ['.json', '.md', '.ts', '.tsx', '.js', '.jsx'];
const TRANSLATION_FN_NAMES = new Set(['t', 'translate']);
const NON_TRANSLATION_KEYS = new Set([
  'verification.steps',
  'verification.reportSummary',
  'sessions.finalizations.artifacts.bundle.get',
  'sessions.finalizations.artifacts.report.get',
]);

type TranslationTree = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractTranslationKeys(obj: TranslationTree, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) {
      return extractTranslationKeys(value, pathKey);
    }
    return [pathKey];
  });
}

function getTranslationValue(obj: TranslationTree, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((value, segment) => {
    if (isRecord(value) && segment in value) {
      return value[segment];
    }
    return undefined;
  }, obj);
}

function extractPlaceholders(value: string): string[] {
  const matches = value.matchAll(/\{\{(\w+)\}\}/g);
  return Array.from(matches, (match) => strictDefined(match[1])).sort();
}

function isLikelyTranslationKey(value: string): boolean {
  if (NON_TRANSLATION_KEYS.has(value)) {
    return false;
  }
  if (!value.includes('.')) {
    return false;
  }
  if (value.includes('/') || value.includes('\\')) {
    return false;
  }
  if (value.endsWith('.')) {
    return false;
  }
  if (value.includes(' ')) {
    return false;
  }
  if (INVALID_KEY_SUFFIXES.some((suffix) => value.endsWith(suffix))) {
    return false;
  }
  const [root = ''] = value.split('.');
  return TRANSLATION_PREFIXES.has(root);
}

function isTranslationSourceFile(fullPath: string): boolean {
  if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) return false;
  if (fullPath.endsWith('.d.ts')) return false;
  return !fullPath.includes('.test.') && !fullPath.includes('.spec.') && !fullPath.endsWith('.type-test.ts');
}

function shouldVisitSourceDirectory(fullPath: string, name: string): boolean {
  return (
    name !== 'test-support' && !fullPath.includes(`${path.sep}src${path.sep}lib${path.sep}i18n${path.sep}translations`)
  );
}

function collectSourceFiles(rootDir: string): string[] {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (shouldVisitSourceDirectory(fullPath, entry.name)) files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!entry.isFile() || !isTranslationSourceFile(fullPath)) continue;
    files.push(fullPath);
  }
  return files;
}

function literalKey(node: Node | null | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function expressionIdentifier(node: Node): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier')
    return node.property.name;
  return undefined;
}

function isLanguageArgument(node: Node): boolean {
  const literal = literalKey(node);
  if (literal !== undefined) return LANGUAGE_CODES.has(literal);
  const name = expressionIdentifier(node);
  return name === 'language' || name === 'lang';
}
function extractLiteralKeysFromExpression(node: Node): string[] {
  const literal = literalKey(node);
  if (literal !== undefined) return [literal];
  if (node.type === 'ArrayExpression') {
    const parts = node.elements.map(literalKey);
    if (parts.every((part) => typeof part === 'string')) return [parts.join('.')];
  }
  return [];
}

function collectUsedKeys(): Set<string> {
  const usedKeys = new Set<string>();
  const sourceFiles = [
    ...collectSourceFiles(path.join(process.cwd(), 'apps/web/src')),
    ...collectSourceFiles(path.join(process.cwd(), 'packages/verification/src')),
  ];

  for (const filePath of sourceFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseSync(filePath, content);
    if (parsed.errors.length > 0)
      throw new Error(`Cannot parse ${filePath}: ${parsed.errors.map((error) => error.message).join('; ')}`);
    function addLiteral(node: Node): void {
      const key = literalKey(node);
      if (key !== undefined && isLikelyTranslationKey(key)) usedKeys.add(key);
    }
    new Visitor({
      CallExpression(node) {
        const name = expressionIdentifier(node.callee);
        if (!name || !TRANSLATION_FN_NAMES.has(name) || node.arguments.length === 0) return;
        const keyArgIndex = node.arguments.length > 1 && isLanguageArgument(strictDefined(node.arguments[0])) ? 1 : 0;
        const keyArg = node.arguments[keyArgIndex];
        if (keyArg) for (const key of extractLiteralKeysFromExpression(keyArg)) usedKeys.add(key);
      },
      Literal: addLiteral,
      TemplateLiteral: addLiteral,
    }).visit(parsed.program);
  }

  for (const key of INFOGRAPHIC_STEP_KEYS) {
    usedKeys.add(`infographic.steps.${key}.label`);
    usedKeys.add(`infographic.steps.${key}.brief`);
  }

  for (const key of INFOGRAPHIC_GUARANTEE_KEYS) {
    usedKeys.add(`infographic.guarantees.items.${key}`);
  }

  for (const key of KNOWLEDGE_KEYS) {
    usedKeys.add(`knowledge.items.${key}`);
  }

  return usedKeys;
}

const jaKeys = extractTranslationKeys(ja).sort();
const enKeys = extractTranslationKeys(en).sort();
const usedKeys = collectUsedKeys();
const definedKeys = new Set(jaKeys);
const UNUSED_KEY_ALLOWLIST: string[] = [];

const unusedAllowlist = new Set<string>(UNUSED_KEY_ALLOWLIST);

describe('translation consistency', () => {
  it('ja and en have identical key structure', () => {
    expect(jaKeys).toEqual(enKeys);
  });

  it('no undefined translation keys are used', () => {
    const undefinedKeys = Array.from(usedKeys)
      .filter((key) => !definedKeys.has(key))
      .sort();
    expect(undefinedKeys).toEqual([]);
  });

  it('no unused translation keys exist', () => {
    const unusedKeys = jaKeys.filter((key) => !usedKeys.has(key) && !unusedAllowlist.has(key));
    expect(unusedKeys).toEqual([]);
  });

  it('interpolation placeholders match between ja and en', () => {
    const mismatches: string[] = [];

    for (const key of jaKeys) {
      const jaValue = getTranslationValue(ja, key);
      const enValue = getTranslationValue(en, key);
      if (typeof jaValue !== 'string' || typeof enValue !== 'string') {
        continue;
      }
      const jaPlaceholders = extractPlaceholders(jaValue);
      const enPlaceholders = extractPlaceholders(enValue);
      if (jaPlaceholders.join('|') !== enPlaceholders.join('|')) {
        mismatches.push(`${key} (ja: ${jaPlaceholders.join(',')}, en: ${enPlaceholders.join(',')})`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});
