import type { Node } from 'oxc-parser';
import {
  forEachChild,
  isNode,
  isStaticMember,
  isStringLiteral,
  isStaticTemplate,
  parseSyntax,
  staticText,
} from './source';

function quotedTypeTextEnd(comment: string, start: number): number {
  const quote = comment[start];
  for (let index = start + 1; index < comment.length; index += 1) {
    if (comment[index] === '\\') index += 1;
    else if (comment[index] === quote) return index;
  }
  return comment.length;
}

const TYPE_TEXT_QUOTES = new Set(['"', "'", '`']);

function jsDocTypeExpression(comment: string, start: number): string {
  let depth = 1;
  for (let index = start; index < comment.length; index += 1) {
    const character = comment[index];
    if (character !== undefined && TYPE_TEXT_QUOTES.has(character)) {
      index = quotedTypeTextEnd(comment, index);
    } else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      return comment.slice(start, index).replace(/\n\s*\*/gu, '\n');
    }
  }
  throw new Error('Unterminated JSDoc type expression.');
}

function jsDocTypeExpressions(comment: string): string[] {
  const expressions: string[] = [];
  const tags = /@(?:type|typedef|param|returns?|throws|extends|implements)\s*\{/gu;
  for (const match of comment.matchAll(tags)) {
    expressions.push(jsDocTypeExpression(comment, match.index + match[0].length));
  }
  return expressions;
}

function isImportMeta(node: Node): boolean {
  return node.type === 'MetaProperty' && node.meta.name === 'import' && node.property.name === 'meta';
}

function isModuleLoader(callee: Node): boolean {
  if (isNode(callee, 'Identifier')) return callee.name === 'require';
  if (!isStaticMember(callee)) return false;
  const object = callee.object;
  if (isNode(object, 'Identifier')) {
    return (
      (object.name === 'require' && callee.property.name === 'resolve') ||
      (object.name === 'module' && callee.property.name === 'require')
    );
  }
  return isImportMeta(object) && callee.property.name === 'resolve';
}

function referencedModuleNode(node: Node): Node | null | undefined {
  if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportNamedDeclaration' ||
    node.type === 'ExportAllDeclaration' ||
    node.type === 'ImportExpression' ||
    node.type === 'TSImportType'
  )
    return node.source;
  if (node.type === 'TSExternalModuleReference') return node.expression;
  if (node.type === 'CallExpression' && isModuleLoader(node.callee)) return node.arguments[0];
  return undefined;
}

function visitJsDocImportExpression(expression: string, fileName: string, visit: (node: Node) => void): void {
  try {
    const typeSource = parseSyntax('jsdoc-type.ts', `declare function documented(): ${expression};`).program;
    if (typeSource.body.length !== 1 || typeSource.body[0]?.type !== 'TSDeclareFunction') {
      throw new Error('Expected one complete JSDoc type expression.');
    }
    visit(typeSource);
  } catch (error) {
    throw new Error(`Cannot analyze JSDoc in ${fileName}: ${expression}`, { cause: error });
  }
}

export function moduleSpecifiers(source: string, fileName: string): string[] {
  const syntax = parseSyntax(fileName, source);
  const specifiers: Array<{ position: number; value: string }> = [];
  function visit(node: Node, position?: number): void {
    const reference = referencedModuleNode(node);
    if (isStringLiteral(reference) || isStaticTemplate(reference)) {
      specifiers.push({ position: position ?? reference.start, value: staticText(reference) });
    }
    forEachChild(node, (child) => visit(child, position));
  }
  visit(syntax.program);
  for (const comment of syntax.comments) {
    if (comment.type !== 'Block' || !comment.value.startsWith('*')) continue;
    for (const expression of jsDocTypeExpressions(comment.value)) {
      if (!/\bimport\s*\(/u.test(expression)) continue;
      visitJsDocImportExpression(expression, fileName, (node) => visit(node, comment.start));
    }
  }
  return specifiers.sort((left, right) => left.position - right.position).map(({ value }) => value);
}
