import path from 'node:path'
import { transformSync } from 'oxc-transform'
import {
  tryParse,
  walk,
  sliceSpan,
  spanOf,
  toStringIndex,
  collectValueIdentifiers,
  propKeyName,
  type Node,
} from './ast.js'

/** Query key used to address a route's split virtual module: `<file>?tsr-split=<prop>`. */
export const SPLIT_QUERY = 'tsr-split'

/**
 * Default split groupings: each of these route options is hoisted into its own
 * lazily-imported chunk. Mirrors TanStack Router's default
 * `[['component'], ['errorComponent'], ['notFoundComponent']]`. `loader` and the
 * rest deliberately stay in the main (reference) chunk.
 */
export const SPLITTABLE_PROPS = ['component', 'errorComponent', 'notFoundComponent'] as const
export type SplittableProp = (typeof SPLITTABLE_PROPS)[number]

const ROUTER_PKG = '@tanstack/react-router'
const ROUTE_FACTORY_NAMES = new Set([
  'createFileRoute',
  'createRootRoute',
  'createRootRouteWithContext',
])

// ---------------------------------------------------------------------------
// Virtual id helpers
// ---------------------------------------------------------------------------

export function isSplitVirtualId(id: string): boolean {
  return new RegExp(`[?&]${SPLIT_QUERY}=`).test(id)
}

export function parseSplitVirtualId(id: string): { base: string; prop: string } | null {
  const q = id.indexOf('?')
  if (q < 0) return null
  const base = id.slice(0, q)
  const prop = new URLSearchParams(id.slice(q + 1)).get(SPLIT_QUERY)
  if (!prop) return null
  return { base, prop }
}

/** Resolve a `?tsr-split=` specifier (emitted by us) to a canonical absolute id. */
export function resolveSplitId(source: string, importer: string | undefined): string | null {
  const parsed = parseSplitVirtualId(source)
  if (!parsed) return null
  const { base, prop } = parsed
  let absBase = base
  if (base.startsWith('.')) {
    absBase = path.resolve(path.dirname(importer ?? ''), base)
  }
  return `${absBase}?${SPLIT_QUERY}=${prop}`
}

// ---------------------------------------------------------------------------
// Route analysis
// ---------------------------------------------------------------------------

interface DeclInfo {
  node: Node
  exported: boolean
  movable: boolean
}

interface RouteAnalysis {
  code: string
  program: Node
  /** route option name -> value AST node */
  props: Map<string, Node>
  /** local name -> the full ImportDeclaration node that binds it */
  importStmtByLocal: Map<string, Node>
  /** top-level binding name -> declaration info */
  decls: Map<string, DeclInfo>
}

function isMovableInit(init: Node | null | undefined): boolean {
  if (!init) return false
  switch (init.type) {
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassExpression':
    case 'Literal':
    case 'Identifier':
    case 'TemplateLiteral':
      return true
    default:
      return false
  }
}

/** Record the names a declaration binds, with exported/movable flags. */
function recordDecl(decl: Node, exported: boolean, out: Map<string, DeclInfo>): void {
  if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
    if (decl.id?.name) out.set(decl.id.name, { node: decl, exported, movable: true })
    return
  }
  if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations) {
      // Only simple identifier bindings are eligible to move; destructuring is
      // conservatively treated as non-movable.
      if (d.id?.type === 'Identifier') {
        out.set(d.id.name, { node: decl, exported, movable: isMovableInit(d.init) })
      }
    }
  }
}

function analyzeRoute(code: string, filename: string): RouteAnalysis | null {
  const parsed = tryParse(code, filename)
  if (!parsed) return null
  const { program } = parsed

  // Find the route options object literal.
  let optionsObj: Node | null = null
  walk(program, (n) => {
    if (optionsObj || n.type !== 'CallExpression') return
    const callee = n.callee
    const isFactoryCall =
      (callee.type === 'CallExpression' &&
        callee.callee?.type === 'Identifier' &&
        ROUTE_FACTORY_NAMES.has(callee.callee.name)) ||
      (callee.type === 'Identifier' && ROUTE_FACTORY_NAMES.has(callee.name))
    if (!isFactoryCall) return
    const arg = n.arguments?.[0]
    if (arg && arg.type === 'ObjectExpression') optionsObj = arg
  })
  if (!optionsObj) return null

  const props = new Map<string, Node>()
  for (const p of (optionsObj as Node).properties) {
    const name = propKeyName(p)
    if (name) props.set(name, p.value)
  }

  const importStmtByLocal = new Map<string, Node>()
  const decls = new Map<string, DeclInfo>()

  for (const stmt of program.body) {
    if (stmt.type === 'ImportDeclaration') {
      for (const spec of stmt.specifiers) {
        if (spec.local?.name) importStmtByLocal.set(spec.local.name, stmt)
      }
    } else if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.declaration) recordDecl(stmt.declaration, true, decls)
      // `export { a, b }` marks existing locals as exported
      for (const spec of stmt.specifiers ?? []) {
        const local = spec.local?.name
        if (local && decls.has(local)) decls.get(local)!.exported = true
      }
    } else if (
      stmt.type === 'FunctionDeclaration' ||
      stmt.type === 'ClassDeclaration' ||
      stmt.type === 'VariableDeclaration'
    ) {
      recordDecl(stmt, false, decls)
    }
  }

  return { code, program, props, importStmtByLocal, decls }
}

// ---------------------------------------------------------------------------
// Safety check
// ---------------------------------------------------------------------------

export interface SafetyResult {
  safe: boolean
  /** props that are present and would be split */
  splitProps: SplittableProp[]
  /** populated when unsafe: which binding/prop forced the skip */
  reason?: string
}

/**
 * Decide whether a route can be safely auto-split. Conservative: if ANY candidate
 * split prop depends on a non-exported module-local that is either (a) also used
 * by non-split code (shared state risk) or (b) not a side-effect-free movable
 * declaration, we skip the whole route.
 */
function checkSafety(analysis: RouteAnalysis): SafetyResult {
  const splitProps = SPLITTABLE_PROPS.filter((p) => analysis.props.has(p))
  if (splitProps.length === 0) return { safe: false, splitProps: [] }

  const splitValueNodes = new Set<Node>(splitProps.map((p) => analysis.props.get(p)!))
  const usedOutside = collectValueIdentifiers(analysis.program, splitValueNodes)

  // Walk each split value's transitive local dependencies.
  const seen = new Set<string>()
  const queue: string[] = []
  for (const node of splitValueNodes) {
    for (const name of collectValueIdentifiers(node)) queue.push(name)
  }

  while (queue.length) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)

    if (analysis.importStmtByLocal.has(name)) continue // import: always safe
    const decl = analysis.decls.get(name)
    if (!decl) continue // global / builtin
    if (decl.exported) continue // imported from original module: single instance, safe

    // non-exported module-local:
    if (usedOutside.has(name)) {
      return {
        safe: false,
        splitProps,
        reason: `local "${name}" is shared between split and non-split code`,
      }
    }
    if (!decl.movable) {
      return {
        safe: false,
        splitProps,
        reason: `local "${name}" has a non-movable (possibly side-effectful) declaration`,
      }
    }
    // movable & exclusive to split code: include it, follow its own deps
    for (const inner of collectValueIdentifiers(decl.node)) queue.push(inner)
  }

  return { safe: true, splitProps }
}

// ---------------------------------------------------------------------------
// Transpile
// ---------------------------------------------------------------------------

function transpile(filename: string, code: string): string {
  const result = transformSync(filename, code, {
    typescript: {},
    jsx: { runtime: 'automatic', importSource: 'react' },
    sourcemap: false,
  })
  if (result.errors && result.errors.length > 0) {
    const msg = result.errors.map((e: any) => e.message ?? String(e)).join('\n')
    throw new Error(`oxc-transform failed for ${filename}:\n${msg}`)
  }
  return result.code
}

// ---------------------------------------------------------------------------
// Public: reference transform (runs on the route file during build)
// ---------------------------------------------------------------------------

const IMPORTER_PREFIX = '$$tsrSplit_'

/**
 * Rewrite a route file into its "reference" form: each safely-splittable
 * component option becomes `lazyRouteComponent(importer, '<prop>')`, with importer
 * consts and the `lazyRouteComponent` import injected. Returns transpiled JS, or
 * null when the file isn't a splittable route (or is unsafe to split).
 *
 * `onSkip` is invoked with a human-readable reason when a route is recognized but
 * intentionally left un-split, so callers can log it.
 */
export function transformReferenceRoute(
  rawCode: string,
  filename: string,
  onSkip?: (reason: string) => void,
): { code: string } | null {
  const analysis = analyzeRoute(rawCode, filename)
  if (!analysis) return null

  const safety = checkSafety(analysis)
  if (safety.splitProps.length === 0) return null
  if (!safety.safe) {
    if (safety.reason) onSkip?.(`${path.basename(filename)}: ${safety.reason} — left inline`)
    return null
  }

  const basename = path.basename(filename)
  const edits: Array<{ start: number; end: number; text: string }> = []
  for (const prop of safety.splitProps) {
    const valueNode = analysis.props.get(prop)!
    const [s, e] = spanOf(valueNode)
    edits.push({
      start: toStringIndex(rawCode, s),
      end: toStringIndex(rawCode, e),
      text: `lazyRouteComponent(${IMPORTER_PREFIX}${prop}, '${prop}')`,
    })
  }

  // Apply edits right-to-left so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start)
  let out = rawCode
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }

  const header: string[] = [`import { lazyRouteComponent } from '${ROUTER_PKG}';`]
  for (const prop of safety.splitProps) {
    header.push(
      `const ${IMPORTER_PREFIX}${prop} = () => import('./${basename}?${SPLIT_QUERY}=${prop}');`,
    )
  }
  out = header.join('\n') + '\n' + out

  return { code: transpile(filename, out) }
}

// ---------------------------------------------------------------------------
// Public: split virtual module (runs in `load` for `<file>?tsr-split=<prop>`)
// ---------------------------------------------------------------------------

/**
 * Build the virtual split module for one route property: a minimal module that
 * `export const <prop> = <value>`, carrying only the imports / shared (exported)
 * bindings / movable locals that value transitively needs. Returns transpiled JS.
 */
export function loadSplitModule(
  rawCode: string,
  baseFilename: string,
  prop: string,
): { code: string } | null {
  const analysis = analyzeRoute(rawCode, baseFilename)
  if (!analysis) return null
  const valueNode = analysis.props.get(prop)
  if (!valueNode) return null

  const neededImportStmts = new Set<Node>()
  const importFromOriginal = new Set<string>()
  const movedDecls = new Map<string, Node>()

  const seen = new Set<string>()
  const queue: string[] = [...collectValueIdentifiers(valueNode)]
  while (queue.length) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)

    const importStmt = analysis.importStmtByLocal.get(name)
    if (importStmt) {
      neededImportStmts.add(importStmt)
      continue
    }
    const decl = analysis.decls.get(name)
    if (!decl) continue // global
    if (decl.exported) {
      importFromOriginal.add(name)
      continue
    }
    if (!movedDecls.has(name)) {
      movedDecls.set(name, decl.node)
      for (const inner of collectValueIdentifiers(decl.node)) queue.push(inner)
    }
  }

  const lines: string[] = []

  // Re-emit each needed import statement verbatim (unused specifiers tree-shake away).
  for (const stmt of neededImportStmts) lines.push(sliceSpan(rawCode, stmt))

  // Pull shared (exported) bindings — notably `Route` — from the original module.
  if (importFromOriginal.size > 0) {
    const basename = path.basename(baseFilename)
    lines.push(`import { ${[...importFromOriginal].join(', ')} } from './${basename}';`)
  }

  // Inline the movable, split-exclusive locals (in source order for readability).
  const ordered = [...movedDecls.values()].sort((a, b) => spanOf(a)[0] - spanOf(b)[0])
  for (const decl of ordered) lines.push(sliceSpan(rawCode, decl))

  lines.push(`export const ${prop} = ${sliceSpan(rawCode, valueNode)};`)

  return { code: transpile(baseFilename, lines.join('\n') + '\n') }
}
