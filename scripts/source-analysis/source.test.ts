import { describe, expect, it } from 'vitest';
import {
  forEachChild,
  isNode,
  nodeText,
  parseSource,
  parseSyntax,
  sourceLine,
  sourcePosition,
  topLevelDeclarations,
} from './source';
import { moduleSpecifiers } from './imports';

describe('source analysis', () => {
  it('preserves UTF-16 source spans and line positions after non-ASCII text', () => {
    const source = '// 日本語 𠀀\r\nexport const value = "値";';
    const declaration = topLevelDeclarations(parseSource('example.ts', source))[0];
    expect(declaration).toBeDefined();
    if (!isNode(declaration, 'VariableDeclaration')) throw new Error('Expected a variable declaration.');
    expect(nodeText(declaration)).toBe('const value = "値";');
    expect(sourceLine(declaration)).toBe(2);
    expect(sourcePosition(declaration, declaration.start)).toEqual({ line: 1, character: 7 });
  });
  it('visits shorthand and unaliased import names once but retains distinct alias positions', () => {
    const names: string[] = [];
    const source = parseSource(
      'example.ts',
      'import { value, source as alias } from "package"; const object = { value };',
    );
    function visit(node: import('oxc-parser').Node): void {
      if (node.type === 'Identifier') names.push(nodeText(node));
      forEachChild(node, visit);
    }
    const declaration = source.body[0];
    if (declaration?.type !== 'ImportDeclaration') throw new Error('Expected an import.');
    const specifier = declaration.specifiers[0];
    if (!specifier) throw new Error('Expected an import binding.');
    expect(nodeText(specifier.local)).toBe('value');
    visit(source);
    expect(names).toEqual(['value', 'source', 'alias', 'object', 'value']);
  });
  it('rejects invalid syntax instead of admitting a partial tree', () => {
    expect(() => parseSource('invalid.ts', 'const broken-name = 1;')).toThrow('Cannot parse invalid.ts');
    expect(() => moduleSpecifiers('import "valid"; const broken-name = 1;', 'invalid.ts')).toThrow(
      'Cannot parse invalid.ts',
    );
  });
  it('keeps source context scoped to its indexed tree', () => {
    const first = parseSource('first.ts', 'const value = "first";');
    const second = parseSource('second.ts', 'const value = "second";');
    const firstStatement = first.body[0];
    const secondStatement = second.body[0];
    if (!firstStatement || !secondStatement) throw new Error('Expected a statement in each tree.');
    expect(nodeText(firstStatement)).toBe('const value = "first";');
    expect(nodeText(secondStatement)).toBe('const value = "second";');
    expect(() => nodeText(parseSyntax('raw.ts', 'const value = "raw";').program)).toThrow(
      'Source node has no parsed context',
    );
  });
  it('extracts imports from JSDoc types without treating examples or ordinary comments as dependencies', () => {
    const source =
      '/** @type {{ nested: import("actual").Type, example: "import(\\\"fake\\\")" }} */\nconst value = {};\n/* @type {import("ignored")} */';
    expect(moduleSpecifiers(source, 'example.js')).toEqual(['actual']);
  });
  it('extracts JSDoc return predicates and multiline nested types', () => {
    const source =
      '/** @returns {value is import("predicate").Value} */\nfunction isValue(value) { return true; }\n/**\n * @param {{\n * nested: { item: import("nested").Item }\n * }} value\n */\nfunction consume(value) {}';
    expect(moduleSpecifiers(source, 'example.js')).toEqual(['predicate', 'nested']);
  });
  it('rejects statements smuggled into a JSDoc type expression', () => {
    expect(() =>
      moduleSpecifiers('/** @type {unknown; import("injected")} */\nconst value = {};', 'example.js'),
    ).toThrow('Cannot analyze JSDoc');
  });
  it('recognizes module resolution and type-only runtime dependencies', () => {
    expect(
      moduleSpecifiers(
        'const path = import.meta.resolve("typescript/package.json"); type T = import("other").T;',
        'example.ts',
      ),
    ).toEqual(['typescript/package.json', 'other']);
  });
});
