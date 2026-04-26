import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ja } from './translations/ja';
import { en } from './translations/en';
import { INFOGRAPHIC_GUARANTEE_KEYS, INFOGRAPHIC_STEP_KEYS } from './dynamic-keys';
import { KNOWLEDGE_KEYS } from '@/lib/knowledge/types';

const LANGUAGE_CODES = new Set(['ja', 'en']);
const TRANSLATION_PREFIXES = new Set(Object.keys(ja));
const INVALID_KEY_SUFFIXES = ['.json', '.md', '.ts', '.tsx', '.js', '.jsx'];
const TRANSLATION_FN_NAMES = new Set(['t', 'translate']);
const NON_TRANSLATION_KEYS = new Set(['verification.steps', 'verification.reportSummary']);

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
  return Array.from(matches, (match) => match[1]).sort();
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
  const [root] = value.split('.');
  return TRANSLATION_PREFIXES.has(root);
}

function collectSourceFiles(rootDir: string): string[] {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') {
        continue;
      }
      if (fullPath.includes(`${path.sep}src${path.sep}lib${path.sep}i18n${path.sep}translations`)) {
        continue;
      }
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) {
      continue;
    }
    if (fullPath.endsWith('.d.ts')) {
      continue;
    }
    if (fullPath.includes('.test.') || fullPath.includes('.spec.')) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function isLanguageArgument(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return LANGUAGE_CODES.has(node.text);
  }
  if (ts.isIdentifier(node)) {
    return node.text === 'language' || node.text === 'lang';
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === 'language' || node.name.text === 'lang';
  }
  return false;
}

function extractLiteralKeysFromExpression(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isArrayLiteralExpression(node)) {
    const parts = node.elements.map((element) => {
      if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
        return element.text;
      }
      return undefined;
    });
    if (parts.every((part) => typeof part === 'string')) {
      return [parts.join('.')];
    }
  }
  return [];
}

function collectUsedKeys(): Set<string> {
  const usedKeys = new Set<string>();
  const sourceFiles = collectSourceFiles(path.join(process.cwd(), 'src'));

  for (const filePath of sourceFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const isTCall =
          (ts.isIdentifier(expression) && TRANSLATION_FN_NAMES.has(expression.text)) ||
          (ts.isPropertyAccessExpression(expression) && TRANSLATION_FN_NAMES.has(expression.name.text));
        if (isTCall && node.arguments.length > 0) {
          const keyArgIndex = node.arguments.length > 1 && isLanguageArgument(node.arguments[0]) ? 1 : 0;
          if (node.arguments.length <= keyArgIndex) {
            return;
          }
          const keyArg = node.arguments[keyArgIndex];
          for (const key of extractLiteralKeysFromExpression(keyArg)) {
            usedKeys.add(key);
          }
        }
      }

      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (isLikelyTranslationKey(node.text)) {
          usedKeys.add(node.text);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
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
