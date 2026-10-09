import ts from 'typescript'
import { transform } from 'lightningcss'
import { dirname, resolve } from 'node:path'

export interface UiCopyIssue {
  readonly file: string
  readonly line: number
  readonly text: string
}

const copyProps = new Set([
  'title',
  'label',
  'description',
  'message',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'emptyText',
])
// Executable names, argument examples and environment syntax are input data,
// not English instructions. This exception applies only to placeholder props.
const commandExamples = new Set(['Devin', 'devin', 'acp', 'NO_COLOR=1'])

/** Follow display expressions, including local helper parameters and returns.
 * Protocol fields stay opaque; enum tuples and translation keys are not copy.
 */
export function uiCopyIssues(
  source: string,
  filename = 'component.tsx',
  related: ReadonlyMap<string, string> = new Map(),
): UiCopyIssue[] {
  filename = resolve(filename)
  const sources = new Map([...related].map(([name, text]) => [resolve(name), text]))
  sources.set(filename, source)
  const options: ts.CompilerOptions = { noLib: true, allowImportingTsExtensions: true, noEmit: true }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (name) => {
    const text = sources.get(resolve(name))
    return text === undefined
      ? undefined
      : ts.createSourceFile(
          name,
          text,
          ts.ScriptTarget.Latest,
          true,
          name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
  }
  host.fileExists = (name) => sources.has(resolve(name))
  host.resolveModuleNames = (names, containing) =>
    names.map((name) => {
      if (!name.startsWith('.')) return undefined
      const target = resolve(dirname(containing), name)
      const found = [target, `${target}.ts`, `${target}.tsx`].find((candidate) => sources.has(candidate))
      return found === undefined
        ? undefined
        : { resolvedFileName: found, extension: found.endsWith('.tsx') ? ts.Extension.Tsx : ts.Extension.Ts }
    })
  const program = ts.createProgram([filename], options, host)
  const file = program.getSourceFile(filename)!
  if (program.getSyntacticDiagnostics(file).length > 0) throw new Error(`Cannot scan invalid UI source: ${filename}`)
  const checker = program.getTypeChecker()
  const elementFactories = new Set<ts.Symbol>()
  const reactNamespaces = new Set<ts.Symbol>()
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      (statement.moduleSpecifier.getText(file) !== "'react'" && statement.moduleSpecifier.getText(file) !== '"react"')
    )
      continue
    const clause = statement.importClause
    const bind = (name: ts.Identifier, into: Set<ts.Symbol>): void => {
      const symbol = checker.getSymbolAtLocation(name)
      if (symbol) into.add(symbol)
    }
    if (clause?.name) bind(clause.name, reactNamespaces)
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      bind(clause.namedBindings.name, reactNamespaces)
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        if ((binding.propertyName ?? binding.name).text === 'createElement') bind(binding.name, elementFactories)
      }
    }
  }
  const issues = new Map<string, UiCopyIssue>()
  const literal = (node: ts.Node, text: string): void => {
    if (!/[A-Za-z]{2}|[\u3400-\u9fff]/u.test(text) || /^ACP_[A-Z0-9_]+$/.test(text)) return
    const owner = node.getSourceFile()
    issues.set(`${owner.fileName}:${node.getStart(owner)}`, {
      file: owner.fileName,
      line: owner.getLineAndCharacterOfPosition(node.getStart(owner)).line + 1,
      text,
    })
  }
  type Values = ReadonlyMap<ts.Declaration, ts.Expression>
  const returns = (fn: ts.FunctionLikeDeclaration): ts.Expression[] => {
    if (!fn.body) return []
    if (!ts.isBlock(fn.body)) return [fn.body]
    const found: ts.Expression[] = []
    const walk = (node: ts.Node): void => {
      if (node !== fn.body && ts.isFunctionLike(node)) return
      if (ts.isReturnStatement(node) && node.expression) found.push(node.expression)
      else ts.forEachChild(node, walk)
    }
    walk(fn.body)
    return found
  }
  const declarationOf = (node: ts.Node): ts.Declaration | undefined => {
    let symbol = checker.getSymbolAtLocation(node)
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    return symbol?.valueDeclaration
  }
  type Sink = 'copy' | 'props' | 'rows'
  const display = (
    expression: ts.Expression,
    values: Values = new Map(),
    seen = new Set<ts.Node>(),
    sink: Sink = 'copy',
  ): void => {
    if (seen.has(expression)) return
    seen = new Set(seen).add(expression)
    const next = (value: ts.Expression, role: Sink = sink): void => display(value, values, seen, role)
    if (ts.isStringLiteralLike(expression) && sink === 'copy') literal(expression, expression.text)
    else if (ts.isTemplateExpression(expression)) {
      literal(expression.head, expression.head.text)
      for (const span of expression.templateSpans) {
        next(span.expression)
        literal(span.literal, span.literal.text)
      }
    } else if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    )
      next(expression.expression)
    else if (ts.isConditionalExpression(expression)) {
      next(expression.whenTrue)
      next(expression.whenFalse)
    } else if (ts.isBinaryExpression(expression)) {
      next(expression.left)
      next(expression.right)
    } else if (ts.isIdentifier(expression)) {
      const declaration = declarationOf(expression)
      const bound = declaration && values.get(declaration)
      if (bound) next(bound)
      else if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
        next(declaration.initializer)
    } else if (ts.isArrayLiteralExpression(expression)) {
      for (const item of expression.elements) if (ts.isExpression(item)) next(item)
    } else if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const value = checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration
          const expression =
            value && (values.get(value) ?? (ts.isVariableDeclaration(value) ? value.initializer : undefined))
          if (expression) {
            const name = property.name.text
            const role =
              sink === 'copy' || copyProps.has(name) || name === 'labels'
                ? 'copy'
                : ['items', 'footer', 'groups', 'choices'].includes(name)
                  ? 'rows'
                  : undefined
            if (role) next(expression, role)
          }
          continue
        }
        if (ts.isSpreadAssignment(property)) {
          next(property.expression)
          continue
        }
        if (!ts.isPropertyAssignment(property)) continue
        const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : ''
        if (sink === 'copy') next(property.initializer)
        else if (copyProps.has(name) || name === 'children' || (sink === 'rows' && ['text', 'name'].includes(name))) {
          if (!(
            name === 'placeholder' &&
            ts.isStringLiteralLike(property.initializer) &&
            commandExamples.has(property.initializer.text)
          ))
            next(property.initializer, 'copy')
        } else if (name === 'labels') next(property.initializer, 'copy')
        else if (['items', 'footer', 'groups', 'choices'].includes(name)) next(property.initializer, 'rows')
      }
    } else if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      for (const value of returns(expression)) next(value)
    } else if (ts.isCallExpression(expression)) {
      const callee = expression.expression
      const declaration = declarationOf(callee)
      const fn =
        declaration && ts.isFunctionDeclaration(declaration)
          ? declaration
          : declaration &&
              ts.isVariableDeclaration(declaration) &&
              declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
            ? declaration.initializer
            : undefined
      if (fn) {
        const bound = new Map(values)
        fn.parameters.forEach((parameter, index) => {
          const value = expression.arguments[index] ?? parameter.initializer
          if (value) bound.set(parameter, value)
        })
        for (const value of returns(fn)) display(value, bound, seen, sink)
      } else if (
        (ts.isIdentifier(callee) && callee.text === 't') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 't')
      ) {
        // An injected translator is opaque, but a local function named t is
        // still followed above. Keys are not copy; authored params can be.
        for (const argument of expression.arguments.slice(1)) next(argument, 'copy')
        return
      }
      // Callback-created children and string formatting preserve their copy.
      if (
        ts.isPropertyAccessExpression(callee) &&
        ['map', 'flatMap', 'trim', 'trimStart', 'trimEnd'].includes(callee.name.text)
      ) {
        if (!['map', 'flatMap'].includes(callee.name.text)) next(callee.expression)
        for (const argument of expression.arguments) next(argument)
      }
    }
  }
  const isFactory = (callee: ts.Expression): boolean =>
    (ts.isIdentifier(callee) && elementFactories.has(checker.getSymbolAtLocation(callee)!)) ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'createElement' &&
      ts.isIdentifier(callee.expression) &&
      reactNamespaces.has(checker.getSymbolAtLocation(callee.expression)!))
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isFactory(node.expression)) {
      for (const child of node.arguments.slice(2)) display(child)
      const props = node.arguments[1]
      if (props) display(props, new Map(), new Set(), 'props')
    } else if (ts.isJsxText(node)) literal(node, node.text.trim())
    else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) display(node.expression)
    else if (ts.isJsxAttribute(node) && copyProps.has(node.name.getText(file)) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) display(node.initializer)
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) display(node.initializer.expression)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...issues.values()].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
}

/** Pinned rc.2 UI contracts, applied to this plugin's own stylesheet corpus.
 * lightningcss parses and normalizes valid CSS, including nested/media rules.
 * Typography and layout variables need role/inheritance review, not a px ban.
 */
export function uiStyleIssues(source: string): string[] {
  const normalized = Buffer.from(
    transform({ filename: 'component.css', code: Buffer.from(source), minify: false }).code,
  ).toString()
  const failures: string[] = []
  const radii = new Set(['xs', 'sm', 'md', 'lg', 'xl', 'panel'].map((suffix) => `--dsw-radius-${suffix}`))
  const focusTokens = new Set([
    '--dsw-focus-ring-color',
    '--dsw-focus-ring-width',
    '--dsw-alias-state-business-primary',
  ])
  for (const match of normalized.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim()
    const declarations = match[2]!.split(';').flatMap((part): [string, string][] => {
      const colon = part.indexOf(':')
      return colon < 0 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim()]]
    })
    for (const [property, value] of declarations) {
      const tokens = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((token) => token[1]!)
      const reject = (reason: string): void => {
        failures.push(`${selector}: ${property}: ${value} (${reason})`)
      }
      if (/^border(?:-[\w-]+)?-radius$/.test(property)) {
        const sizes = [...value.matchAll(/(?:^|[^\w.])((?:\d*\.)?\d+)px\b/g)].map((size) => Number(size[1]))
        const inset = /^calc\(var\(--dsw-radius-(?:xs|sm|md|lg|xl|panel)\) - (?:\d*\.)?\d+px\)$/.test(value)
        if (
          (!inset && sizes.some((size) => size > 4 && size < 99)) ||
          tokens.some((token) => token.startsWith('--dsw-radius-') && !radii.has(token))
        )
          reject('use the shared radius scale')
        if (
          property === 'border-radius' &&
          (/(?:^|\s)(?:50|100)%/.test(value) || sizes.some((size) => size >= 99)) &&
          !declarations.some(([name, setting]) => name === 'corner-shape' && setting === 'round')
        )
          reject('full-round corners need round')
      }
      if (/:focus(?:-visible)?\b/.test(selector) && ['outline', 'outline-color', 'box-shadow'].includes(property)) {
        const colorless = /^(?:none|transparent|currentcolor|inherit)$/i.test(value)
        if (
          !colorless &&
          (!tokens.some(
            (token) => token === '--dsw-focus-ring-color' || token === '--dsw-alias-state-business-primary',
          ) ||
            tokens.some((token) => !focusTokens.has(token)))
        )
          reject('use the shared focus color')
        else if (
          selector.split(',').every((part) => part.includes(':focus-visible')) &&
          tokens.includes('--dsw-alias-state-business-primary') &&
          !tokens.includes('--dsw-focus-ring-color')
        )
          reject('preserve pointer modality suppression')
      }
      if (
        /^border(?:-top|-bottom|-left|-right)?$/.test(property) &&
        /\bsolid\b/.test(value) &&
        tokens.some((token) => token.startsWith('--dsw-alias-border-')) &&
        !/^(?:0?\.5px|0)\s/.test(value)
      )
        reject('neutral borders use a hairline')
      if (
        /^border(?:-top|-bottom|-left|-right)?-color$/.test(property) &&
        tokens.some((token) => token.startsWith('--dsw-alias-border-'))
      ) {
        const prefix = property.slice(0, -'color'.length)
        const valueOf = (part: string): string | undefined =>
          declarations.find(([name]) => name === `${prefix}${part}`)?.[1] ??
          declarations.find(([name]) => name === `border-${part}`)?.[1]
        const width = valueOf('width')
        if (
          valueOf('style') === 'solid' &&
          width &&
          width.split(/\s+/).some((part) => /px$/.test(part) && Number.parseFloat(part) > 0.5)
        )
          reject('neutral borders use a hairline')
      }
      if (
        ['height', 'width'].includes(property) &&
        value === '1px' &&
        declarations.some(
          ([name, setting]) =>
            ['background', 'background-color'].includes(name) && /var\(--dsw-alias-border-/.test(setting),
        )
      )
        reject('neutral dividers use a hairline')
    }
  }
  return failures
}
