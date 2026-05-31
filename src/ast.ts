import { Buffer } from 'node:buffer'
import { parseSync } from 'oxc-parser'

// oxc AST nodes are ESTree-shaped; we keep them loosely typed.
export type Node = any

export interface ParseResult {
  program: Node
  /** Raw source the spans index into. */
  code: string
}

/**
 * Parse a source file. Returns null when there are fatal syntax errors (we then
 * skip splitting that file rather than risk a wrong transform).
 */
export function tryParse(code: string, filename: string): ParseResult | null {
  try {
    const result = parseSync(filename, code)
    if (result.errors && result.errors.length > 0) return null
    return { program: result.program as Node, code }
  } catch {
    return null
  }
}

/** Read a node's [start, end) offsets, tolerating either `start/end` or `range`. */
export function spanOf(node: Node): [number, number] {
  if (typeof node.start === 'number' && typeof node.end === 'number') return [node.start, node.end]
  if (Array.isArray(node.range)) return [node.range[0], node.range[1]]
  throw new Error('node has no span')
}

// ---------------------------------------------------------------------------
// Offset calibration: oxc may report spans as UTF-8 byte offsets or UTF-16 code
// unit offsets depending on version. We detect once with a probe containing a
// multibyte char so slicing is correct regardless.
// ---------------------------------------------------------------------------
let offsetMode: 'utf16' | 'utf8' | null = null

function calibrate(): 'utf16' | 'utf8' {
  if (offsetMode) return offsetMode
  const probe = '/*é*/const x = 1' // 'é' is 2 bytes UTF-8, 1 UTF-16 unit
  offsetMode = 'utf16'
  try {
    const r = parseSync('probe.ts', probe)
    let target: Node | null = null
    walk(r.program as Node, (n) => {
      if (!target && n.type === 'Identifier' && n.name === 'x') target = n
    })
    if (target) {
      const [s, e] = spanOf(target)
      if (probe.slice(s, e) === 'x') offsetMode = 'utf16'
      else if (Buffer.from(probe, 'utf8').subarray(s, e).toString('utf8') === 'x') offsetMode = 'utf8'
    }
  } catch {
    /* keep utf16 default */
  }
  return offsetMode
}

/** Slice the original source for a node's span, honoring the detected offset mode. */
export function sliceSpan(code: string, node: Node): string {
  const [start, end] = spanOf(node)
  if (calibrate() === 'utf8') {
    return Buffer.from(code, 'utf8').subarray(start, end).toString('utf8')
  }
  return code.slice(start, end)
}

/**
 * Convert a span offset into a UTF-16 string index (the domain JS string ops use).
 * Identity in utf16 mode; in utf8 mode, maps the byte offset to a string index.
 * Lets callers do all splicing in plain string space regardless of offset mode.
 */
export function toStringIndex(code: string, offset: number): number {
  if (calibrate() === 'utf8') {
    return Buffer.from(code, 'utf8').subarray(0, offset).toString('utf8').length
  }
  return offset
}

/**
 * Generic recursive walk over the ESTree-like AST. Visits every object that has
 * a string `type`. Returning nothing continues; the visitor cannot stop the walk
 * (callers use a flag if they need early-out semantics).
 */
export function walk(node: Node, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') {
      continue
    }
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visit)
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      walk(child, visit)
    }
  }
}

/**
 * Collect identifier names referenced in *value position* within a subtree,
 * optionally skipping any nodes in `exclude` (and their subtrees).
 *
 * This is intentionally an over-approximation of the subtree's free variables in
 * one direction only: we skip the obvious non-references — declaration *binding*
 * names (a `function`/`class` name, a `const`/`let`/`var` binding), non-computed
 * object/property keys, the `.prop` of non-computed member expressions, and
 * import/export specifier names — but we do NOT do scope subtraction for
 * locally-bound names used in value position (e.g. a param). Over-collecting a
 * genuinely-local name is harmless (it matches no module binding and is treated
 * as a global no-op); under-collecting a real reference would be unsafe, so we
 * never risk it. Skipping declaration *binding* ids is essential: otherwise a
 * top-level `function Foo(){}` would register `Foo` as a "use", breaking the
 * shared-binding analysis.
 */
export function collectValueIdentifiers(root: Node, exclude?: Set<Node>): Set<string> {
  const names = new Set<string>()

  function recurse(node: Node, skipKeys?: Set<string>): void {
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') {
        continue
      }
      if (skipKeys?.has(key)) continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c === 'object') visit(c)
      } else if (child && typeof child === 'object' && typeof child.type === 'string') {
        visit(child)
      }
    }
  }

  function visit(node: Node): void {
    if (!node || typeof node !== 'object') return
    if (exclude && exclude.has(node)) return

    switch (node.type) {
      case 'Identifier':
        names.add(node.name)
        return
      // JSX element/component names are JSXIdentifier, not Identifier. `<Link/>`
      // and `<Foo.Bar/>` are real value references to imported/declared bindings;
      // missing them would omit a needed import from a split module. Lowercase
      // host tags (`<div/>`) are over-collected but harmless (no module binding).
      case 'JSXIdentifier':
        names.add(node.name)
        return
      case 'JSXMemberExpression':
        visit(node.object)
        return // skip `.property`
      case 'MemberExpression':
        visit(node.object)
        if (node.computed) visit(node.property)
        return
      case 'Property':
        if (node.computed) visit(node.key)
        visit(node.value)
        return
      case 'VariableDeclarator':
        // skip the binding `id`; only its initializer holds references
        visit(node.init)
        return
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        // skip the function name `id`; params/body may collect local bindings as
        // value ids, which is harmless (they match no module binding)
        recurse(node, new Set(['id']))
        return
      case 'ClassDeclaration':
      case 'ClassExpression':
        recurse(node, new Set(['id']))
        return
      case 'ImportDeclaration':
        return // bindings/aliases only — never value references
      case 'ExportNamedDeclaration':
        if (node.declaration) visit(node.declaration)
        return // skip `export { a, b }` specifiers
      case 'ExportAllDeclaration':
        return
      default:
        recurse(node)
    }
  }

  visit(root)
  return names
}

/** Non-computed property key name (`Identifier` name or string `Literal` value), else null. */
export function propKeyName(prop: Node): string | null {
  if (prop.type !== 'Property' || prop.computed) return null
  const key = prop.key
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value
  return null
}
