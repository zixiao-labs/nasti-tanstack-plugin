import fs from 'node:fs'
import type { NastiPlugin, ResolvedConfig, DevServer } from '@nasti-toolchain/nasti'
import { resolveOptions, type ResolvedTanStackRouterOptions } from './options.js'
import { createRouteGenerator, type RouteGenerator } from './generator.js'
import { createLogger, type Logger } from './log.js'
import {
  isSplitVirtualId,
  parseSplitVirtualId,
  resolveSplitId,
  transformReferenceRoute,
  loadSplitModule,
} from './code-splitter.js'

export type { TanStackRouterOptions } from './options.js'

const PLUGIN_NAME = 'nasti:tanstack-router'
const ROUTE_FILE_RE = /\.(tsx|jsx|ts|js|mts|cts|mjs|cjs)$/

/**
 * TanStack Router support for Nasti.
 *
 * - **File-based route tree generation** (both dev and build) via the official
 *   `@tanstack/router-generator`, regenerated incrementally on file changes in dev.
 * - **Build-time automatic code splitting** (opt-in via `autoCodeSplitting`) of
 *   each route's `component` / `errorComponent` / `notFoundComponent` into their
 *   own chunks. Splitting only runs during `nasti build` — see README.
 */
export function tanstackRouter(options: import('./options.js').TanStackRouterOptions = {}): NastiPlugin {
  let opts: ResolvedTanStackRouterOptions
  let generator: RouteGenerator
  let logger: Logger
  let command: 'build' | 'serve' = 'serve'

  const splittingActive = () => command === 'build' && opts?.autoCodeSplitting

  return {
    name: PLUGIN_NAME,
    enforce: 'pre',

    async configResolved(config: ResolvedConfig) {
      command = config.command
      logger = createLogger(config.logLevel)
      opts = resolveOptions(options)
      generator = createRouteGenerator(opts, config.root, logger)

      try {
        await generator.generateOnce()
        logger.info(`route tree generated → ${opts.generatedRouteTree}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`failed to generate route tree: ${msg}`)
        // Fail the build loudly; in dev, start anyway and let the watcher recover.
        if (command === 'build') throw err
      }
    },

    configureServer(server: DevServer) {
      const { watcher } = server

      const onFileEvent = async (event: 'create' | 'update' | 'delete', file: string) => {
        if (!generator.isRelevantRouteFile(file)) return
        const changed = await generator.handleFileEvent(event, file)
        if (changed) {
          logger.info(`route tree updated (${event}) → reloading`)
          server.ws.send({ type: 'full-reload' })
        }
      }

      // Structural directory changes: do a full re-crawl, then reload.
      const onDirEvent = async () => {
        try {
          await generator.generateOnce()
          server.ws.send({ type: 'full-reload' })
        } catch (err) {
          logger.error(
            `route tree re-crawl failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      watcher.on('add', (f: string) => void onFileEvent('create', f))
      watcher.on('change', (f: string) => void onFileEvent('update', f))
      watcher.on('unlink', (f: string) => void onFileEvent('delete', f))
      watcher.on('addDir', (d: string) => {
        if (generator.isRelevantRouteFile(d + '/_')) void onDirEvent()
      })
      watcher.on('unlinkDir', (d: string) => {
        if (generator.isRelevantRouteFile(d + '/_')) void onDirEvent()
      })
    },

    resolveId(source, importer) {
      if (!splittingActive()) return null
      if (isSplitVirtualId(source)) return resolveSplitId(source, importer)
      return null
    },

    load(id) {
      if (!splittingActive()) return null
      if (!isSplitVirtualId(id)) return null
      const parsed = parseSplitVirtualId(id)
      if (!parsed) return null
      const raw = fs.readFileSync(parsed.base, 'utf-8')
      const result = loadSplitModule(raw, parsed.base, parsed.prop)
      if (!result) {
        throw new Error(
          `[${PLUGIN_NAME}] could not build split module for "${parsed.prop}" of ${parsed.base}`,
        )
      }
      return result
    },

    transform(_code, id) {
      if (!splittingActive()) return null
      const clean = id.split('?')[0]
      if (id.includes('?')) return null // virtual modules are handled in load()
      if (!ROUTE_FILE_RE.test(clean)) return null
      if (!generator.isRelevantRouteFile(clean)) return null

      // Analyze the *raw* source (not the oxc-transpiled `_code`) so reference and
      // virtual modules derive from identical input. On disk the generator has
      // already injected/fixed route path literals during configResolved.
      const raw = fs.readFileSync(clean, 'utf-8')
      return transformReferenceRoute(raw, clean, (reason) => logger.info(reason))
    },
  }
}

export default tanstackRouter
