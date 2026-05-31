import fs from 'node:fs'
import path from 'node:path'
import { Generator, getConfig } from '@tanstack/router-generator'
import type { ResolvedTanStackRouterOptions } from './options.js'
import type { Logger } from './log.js'

export type RouteFileEvent = 'create' | 'update' | 'delete'

export interface RouteGenerator {
  /** Absolute path of the generated route tree file (e.g. `<root>/src/routeTree.gen.ts`). */
  generatedTreeAbsPath: string
  /** Absolute path of the routes directory. */
  routesDirAbsPath: string
  /**
   * True when `file` is a route source file the generator cares about — i.e. it
   * lives under the routes directory and is not the generated tree file itself.
   * Used to filter dev-watcher events (and to avoid the regenerate→write→event
   * feedback loop).
   */
  isRelevantRouteFile(file: string): boolean
  /** Full crawl + write. Throws on failure (used at startup / before build). */
  generateOnce(): Promise<void>
  /**
   * Incremental regenerate for a single file event. Never throws — logs and
   * returns false on failure. Returns true when the generated tree file actually
   * changed on disk (so the caller can trigger a reload).
   */
  handleFileEvent(event: RouteFileEvent, file: string): Promise<boolean>
}

export function createRouteGenerator(
  options: ResolvedTanStackRouterOptions,
  root: string,
  logger: Logger,
): RouteGenerator {
  // getConfig validates + merges defaults (and any on-disk tsr.config.*) against
  // our inline config. configDirectory is the project root.
  const config = getConfig(options.generatorInlineConfig, root)
  const generator = new Generator({ config, root })

  const generatedTreeAbsPath = path.resolve(root, config.generatedRouteTree)
  const routesDirAbsPath = path.resolve(root, config.routesDirectory)

  function readTree(): string | null {
    try {
      return fs.readFileSync(generatedTreeAbsPath, 'utf-8')
    } catch {
      return null
    }
  }

  return {
    generatedTreeAbsPath,
    routesDirAbsPath,

    isRelevantRouteFile(file) {
      const abs = path.resolve(file)
      if (abs === generatedTreeAbsPath) return false
      const rel = path.relative(routesDirAbsPath, abs)
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    },

    async generateOnce() {
      await generator.run()
    },

    async handleFileEvent(event, file) {
      const before = readTree()
      try {
        await generator.run({ type: event, path: path.resolve(file) })
      } catch (err) {
        logger.error(
          `route tree regeneration failed for ${path.relative(root, file)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        return false
      }
      const after = readTree()
      return before !== after
    },
  }
}
