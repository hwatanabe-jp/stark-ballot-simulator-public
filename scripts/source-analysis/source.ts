import {
  parseSync,
  visitorKeys,
  type Node,
  type Program,
  type Comment,
  type StringLiteral,
  type NumericLiteral,
  type RegExpLiteral,
  type TemplateLiteral,
  type MemberExpression,
  type Function as AstFunction,
  type ArrowFunctionExpression,
} from 'oxc-parser';

interface SourceContext {
  readonly text: string;
  readonly comments: readonly Comment[];
  readonly lineStarts: readonly number[];
}

const contexts = new WeakMap<Node, SourceContext>();

function createUniqueSpanAdmission(): (candidate: Node) => boolean {
  let firstType: Node['type'] | undefined;
  let firstStart = 0;
  let firstEnd = 0;
  // Track the first child directly; allocate a Set only after a distinct sibling.
  let visited: Set<string> | undefined;
  return (candidate) => {
    if (firstType === undefined) {
      firstType = candidate.type;
      firstStart = candidate.start;
      firstEnd = candidate.end;
    } else {
      if (firstType === candidate.type && firstStart === candidate.start && firstEnd === candidate.end) return false;
      const identity = `${candidate.type}:${candidate.start}:${candidate.end}`;
      if (visited?.has(identity)) return false;
      (visited ??= new Set<string>()).add(identity);
    }
    return true;
  };
}

function isAstChild(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && 'type' in value;
}

function visitChildren(node: Node, visit: (child: Node) => void, uniqueSpans: boolean): void {
  const admitSpan = uniqueSpans ? createUniqueSpanAdmission() : undefined;
  for (const key of visitorKeys[node.type] ?? []) {
    const value: unknown = Reflect.get(node, key);
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!isAstChild(child)) continue;
      if (admitSpan && !admitSpan(child)) continue;
      visit(child);
    }
  }
}

export function forEachChild(node: Node, visit: (child: Node) => void): void {
  visitChildren(node, visit, true);
}

export function parseSyntax(fileName: string, text: string): ReturnType<typeof parseSync> {
  const result = parseSync(fileName, text, { astType: 'ts', sourceType: 'unambiguous', preserveParens: true });
  if (result.errors.length > 0) {
    throw new Error(`Cannot parse ${fileName}: ${result.errors.map((error) => error.message).join('; ')}`);
  }
  return result;
}

export function parseSource(fileName: string, text: string): Program {
  const result = parseSyntax(fileName, text);
  const lineStarts = [
    0,
    ...Array.from(text.matchAll(/\r\n|[\n\r\u2028\u2029]/gu), (match) => match.index + match[0].length),
  ];
  const context = { text, comments: result.comments, lineStarts };
  contexts.set(result.program, context);
  function index(node: Node): void {
    visitChildren(
      node,
      (child) => {
        child.parent = node;
        index(child);
      },
      false,
    );
  }
  index(result.program);
  return result.program;
}

function contextFor(node: Node): SourceContext {
  let current: Node | null | undefined = node;
  while (current) {
    const context = contexts.get(current);
    if (context) {
      // Most nodes are only traversed; cache source metadata only when requested.
      if (current !== node) contexts.set(node, context);
      return context;
    }
    current = current.parent;
  }
  throw new Error('Source node has no parsed context.');
}

export function nodeText(node: Node): string {
  return contextFor(node).text.slice(node.start, node.end);
}

export function sourceComments(node: Node): readonly Comment[] {
  return contextFor(node).comments;
}

export function sourceLine(node: Node): number {
  return sourcePosition(node, node.start).line + 1;
}
type NodeOfType<T extends Node['type'], N = Node> = N extends Node
  ? T extends N['type']
    ? N & { type: T }
    : never
  : never;

export function isNode<T extends Node['type']>(node: Node | null | undefined, type: T): node is NodeOfType<T> {
  return node?.type === type;
}

export function findAncestor(node: Node | null | undefined, predicate: (ancestor: Node) => boolean): Node | undefined {
  let current = node;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return undefined;
}

export function isStringLiteral(node: Node | null | undefined): node is StringLiteral {
  return node?.type === 'Literal' && typeof node.value === 'string';
}
export function isNumericLiteral(node: Node | null | undefined): node is NumericLiteral {
  return node?.type === 'Literal' && typeof node.value === 'number';
}
export function isRegExpLiteral(node: Node | null | undefined): node is RegExpLiteral {
  return node?.type === 'Literal' && 'regex' in node;
}
export function isStaticTemplate(node: Node | null | undefined): node is TemplateLiteral {
  return node?.type === 'TemplateLiteral' && node.expressions.length === 0;
}
export function isTemplateElement(node: Node | null | undefined): node is NodeOfType<'TemplateElement'> {
  return node?.type === 'TemplateElement';
}
export function staticText(node: Node): string {
  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') return node.name;
  if (isStringLiteral(node) || isNumericLiteral(node)) return String(node.value);
  if (isRegExpLiteral(node)) return node.raw ?? nodeText(node);
  if (node.type === 'TemplateElement') return node.value.cooked ?? node.value.raw;
  if (isStaticTemplate(node)) return node.quasis.map((part) => part.value.cooked ?? part.value.raw).join('');
  throw new Error(`Expected a static source name, got ${node.type}.`);
}
export function isStaticMember(node: Node | null | undefined): node is MemberExpression & { computed: false } {
  return node?.type === 'MemberExpression' && !node.computed;
}
export function isComputedMember(node: Node | null | undefined): node is MemberExpression & { computed: true } {
  return node?.type === 'MemberExpression' && node.computed;
}
export function isFunction(node: Node | null | undefined): node is AstFunction | ArrowFunctionExpression {
  return (
    node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'TSDeclareFunction' ||
    node?.type === 'TSEmptyBodyFunctionExpression'
  );
}
export function isBinaryOperation(
  node: Node | null | undefined,
): node is NodeOfType<'BinaryExpression' | 'LogicalExpression' | 'AssignmentExpression'> {
  return (
    node?.type === 'BinaryExpression' || node?.type === 'LogicalExpression' || node?.type === 'AssignmentExpression'
  );
}
export function isReexport(
  node: Node | null | undefined,
): node is NodeOfType<'ExportNamedDeclaration' | 'ExportAllDeclaration'> {
  return (
    node?.type === 'ExportAllDeclaration' || (node?.type === 'ExportNamedDeclaration' && node.declaration === null)
  );
}
export function isExportValue(
  node: Node | null | undefined,
): node is NodeOfType<'ExportDefaultDeclaration' | 'TSExportAssignment'> {
  return node?.type === 'ExportDefaultDeclaration' || node?.type === 'TSExportAssignment';
}

export function isExported(node: Node): boolean {
  return (
    (node.parent?.type === 'ExportNamedDeclaration' || node.parent?.type === 'ExportDefaultDeclaration') &&
    node.parent.declaration === node
  );
}

export function topLevelDeclarations(program: Program): Node[] {
  return program.body.map((statement) =>
    statement.type === 'ExportNamedDeclaration' && statement.declaration
      ? statement.declaration
      : statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement,
  );
}

export function lineAt(node: Node, position: number): number {
  return sourcePosition(node, position).line + 1;
}
export function bindingNames(node: Node): string[] {
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'RestElement') return bindingNames(node.argument);
  if (node.type === 'AssignmentPattern') return bindingNames(node.left);
  if (node.type === 'ArrayPattern') return node.elements.flatMap((element) => (element ? bindingNames(element) : []));
  if (node.type === 'ObjectPattern')
    return node.properties.flatMap((property) =>
      bindingNames(property.type === 'RestElement' ? property.argument : property.value),
    );
  if (node.type === 'TSParameterProperty') return bindingNames(node.parameter);
  return [];
}

export function typeAnnotation(node: Node): Node | undefined {
  if ('typeAnnotation' in node) {
    const annotation = node.typeAnnotation;
    return annotation?.type === 'TSTypeAnnotation' ? annotation.typeAnnotation : (annotation ?? undefined);
  }
  if ('returnType' in node) return node.returnType?.typeAnnotation;
  return undefined;
}

export function sourcePosition(node: Node, position: number): { line: number; character: number } {
  const starts = contextFor(node).lineStarts;
  let lower = 0;
  let upper = starts.length;
  while (lower + 1 < upper) {
    const middle = (lower + upper) >>> 1;
    if ((starts[middle] ?? Infinity) <= position) lower = middle;
    else upper = middle;
  }
  return { line: lower, character: position - (starts[lower] ?? 0) };
}

export function isJsonParseCall(node: Node): boolean {
  return (
    isNode(node, 'CallExpression') &&
    isStaticMember(node.callee) &&
    isNode(node.callee.object, 'Identifier') &&
    staticText(node.callee.object) === 'JSON' &&
    staticText(node.callee.property) === 'parse'
  );
}
