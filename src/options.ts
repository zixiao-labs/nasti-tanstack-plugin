import type { Config as GeneratorConfig } from '@tanstack/router-generator'

/**
 * Options for the Nasti TanStack Router plugin.
 *
 * Mirrors the common subset of TanStack Router's `tsr.config` / bundler-plugin
 * options. This plugin targets React only (v1); `target` is fixed to `'react'`.
 */
export interface TanStackRouterOptions {
  /** Directory containing route files, relative to project root. Default: `src/routes`. */
  routesDirectory?: string
  /** Path of the generated route tree file, relative to project root. Default: `src/routeTree.gen.ts`. */
  generatedRouteTree?: string
  /** Files starting with this prefix are ignored by the generator. Default: `-`. */
  routeFileIgnorePrefix?: string
  /** Regex source string; files matching it are ignored by the generator. */
  routeFileIgnorePattern?: string
  /** Only files starting with this prefix are treated as routes (when set). */
  routeFilePrefix?: string
  /** Quote style used in the generated route tree. Default: `single`. */
  quoteStyle?: 'single' | 'double'
  /** Emit semicolons in the generated route tree. Default: `false`. */
  semicolons?: boolean
  /** Silence the generator's own logging. Default: `false`. */
  disableLogging?: boolean
  /** Run the generator's prettier-based formatter on the route tree. Default: `false`. */
  enableRouteTreeFormatting?: boolean
  /**
   * Enable build-time automatic code splitting of route components.
   *
   * When enabled, during `nasti build` each route's `component` / `errorComponent`
   * / `notFoundComponent` is hoisted into its own lazily-imported chunk via
   * `lazyRouteComponent`. Has no effect during `nasti dev` (see README — Nasti's
   * dev server serves native ESM per-module, and its request pipeline strips the
   * query used to address split virtual modules). Default: `false`.
   */
  autoCodeSplitting?: boolean
  /**
   * Escape hatch: extra fields merged into the underlying
   * `@tanstack/router-generator` config (e.g. `indexToken`, `routeToken`,
   * `virtualRouteConfig`). Use sparingly.
   */
  generator?: Partial<GeneratorConfig>
}

export interface ResolvedTanStackRouterOptions {
  routesDirectory: string
  generatedRouteTree: string
  autoCodeSplitting: boolean
  /** Inline config handed to `getConfig()` from `@tanstack/router-generator`. */
  generatorInlineConfig: Partial<GeneratorConfig>
}

const DEFAULT_ROUTES_DIR = 'src/routes'
const DEFAULT_GENERATED_TREE = 'src/routeTree.gen.ts'

export function resolveOptions(options: TanStackRouterOptions = {}): ResolvedTanStackRouterOptions {
  const routesDirectory = options.routesDirectory ?? DEFAULT_ROUTES_DIR
  const generatedRouteTree = options.generatedRouteTree ?? DEFAULT_GENERATED_TREE

  // Build the inline config for @tanstack/router-generator. Only forward keys the
  // user actually set so the generator's own defaults apply otherwise.
  const generatorInlineConfig: Partial<GeneratorConfig> = {
    target: 'react',
    routesDirectory,
    generatedRouteTree,
    enableRouteTreeFormatting: options.enableRouteTreeFormatting ?? false,
    ...(options.routeFileIgnorePrefix !== undefined && {
      routeFileIgnorePrefix: options.routeFileIgnorePrefix,
    }),
    ...(options.routeFileIgnorePattern !== undefined && {
      routeFileIgnorePattern: options.routeFileIgnorePattern,
    }),
    ...(options.routeFilePrefix !== undefined && { routeFilePrefix: options.routeFilePrefix }),
    ...(options.quoteStyle !== undefined && { quoteStyle: options.quoteStyle }),
    ...(options.semicolons !== undefined && { semicolons: options.semicolons }),
    ...(options.disableLogging !== undefined && { disableLogging: options.disableLogging }),
    ...options.generator,
  }

  return {
    routesDirectory,
    generatedRouteTree,
    autoCodeSplitting: options.autoCodeSplitting ?? false,
    generatorInlineConfig,
  }
}
