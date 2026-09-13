import type { Node } from 'oxc-parser';
import {
  forEachChild,
  isNode,
  isStaticMember,
  isStringLiteral,
  isStaticTemplate,
  parseSource,
  sourceComments,
  staticText,
} from './source';

function jsDocTypeExpressions(comment: string): string[] {
  const expressions: string[] = [];
  const tags = /@(?:type|typedef|param|returns?|throws|extends|implements)\s*\{/gu;
  for (const match of comment.matchAll(tags)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = '';
    for (let index = start; index < comment.length; index += 1) {
      const character = comment[index];
      if (quote) {
        if (character === '\\') index += 1;
        else if (character === quote) quote = '';
      } else if (character === '"' || character === "'" || character === '`') quote = character;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        expressions.push(comment.slice(start, index).replace(/\n\s*\*/gu, '\n'));
        break;
      }
    }
    if (depth !== 0) throw new Error('Unterminated JSDoc type expression.');
  }
  return expressions;
}

export function moduleSpecifiers(source: string, fileName: string): string[] {
  const program = parseSource(fileName, source);
  const specifiers: Array<{ position: number; value: string }> = [];
  function add(node: Node | null | undefined, position?: number): void {
    if (isStringLiteral(node) || isStaticTemplate(node)) {
      specifiers.push({ position: position ?? node.start, value: staticText(node) });
    }
  }
  function visit(node: Node, position?: number): void {
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ImportExpression'
    )
      add(node.source, position);
    else if (node.type === 'TSExternalModuleReference') add(node.expression, position);
    else if (node.type === 'TSImportType') add(node.source, position);
    else if (node.type === 'CallExpression') {
      const callee = node.callee;
      const requireCall = isNode(callee, 'Identifier') && callee.name === 'require';
      const loader =
        isStaticMember(callee) &&
        ((isNode(callee.object, 'Identifier') &&
          ((callee.object.name === 'require' && callee.property.name === 'resolve') ||
            (callee.object.name === 'module' && callee.property.name === 'require'))) ||
          (callee.object.type === 'MetaProperty' &&
            callee.object.meta.name === 'import' &&
            callee.object.property.name === 'meta' &&
            callee.property.name === 'resolve'));
      if (requireCall || loader) add(node.arguments[0], position);
    }
    forEachChild(node, (child) => visit(child, position));
  }
  visit(program);
  for (const comment of sourceComments(program)) {
    if (comment.type !== 'Block' || !comment.value.startsWith('*')) continue;
    for (const expression of jsDocTypeExpressions(comment.value)) {
      if (!/\bimport\s*\(/u.test(expression)) continue;
      try {
        const typeSource = parseSource('jsdoc-type.ts', `declare function documented(): ${expression};`);
        if (typeSource.body.length !== 1 || typeSource.body[0]?.type !== 'TSDeclareFunction') {
          throw new Error('Expected one complete JSDoc type expression.');
        }
        visit(typeSource, comment.start);
      } catch (error) {
        throw new Error(`Cannot analyze JSDoc in ${fileName}: ${expression}`, { cause: error });
      }
    }
  }
  return specifiers.sort((left, right) => left.position - right.position).map(({ value }) => value);
}
