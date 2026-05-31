import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRouteGenerator } from '../src/generator'
import { resolveOptions } from '../src/options'
import { createLogger } from '../src/log'

const logger = createLogger('silent')
let root: string

function write(rel: string, content: string) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nasti-tsr-'))
  write(
    'src/routes/__root.tsx',
    `import { createRootRoute, Outlet } from '@tanstack/react-router'
export const Route = createRootRoute({ component: () => <Outlet /> })
`,
  )
  write(
    'src/routes/index.tsx',
    `import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/')({ component: () => <div>home</div> })
`,
  )
  write(
    'src/routes/about.tsx',
    `import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/about')({ component: () => <div>about</div> })
`,
  )
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('route tree generation (official Generator wiring)', () => {
  it('generates a route tree exporting routeTree with all routes', async () => {
    const gen = createRouteGenerator(
      resolveOptions({ disableLogging: true }),
      root,
      logger,
    )
    await gen.generateOnce()

    const tree = fs.readFileSync(gen.generatedTreeAbsPath, 'utf-8')
    expect(tree).toContain('export const routeTree')
    expect(tree).toContain('about')
    // route modules are imported into the tree
    expect(tree).toMatch(/from ['"]\.\/routes\/about['"]/)
  })

  it('flags only files under the routes dir as relevant (not the generated tree)', () => {
    const gen = createRouteGenerator(resolveOptions({ disableLogging: true }), root, logger)
    expect(gen.isRelevantRouteFile(path.join(root, 'src/routes/about.tsx'))).toBe(true)
    expect(gen.isRelevantRouteFile(gen.generatedTreeAbsPath)).toBe(false)
    expect(gen.isRelevantRouteFile(path.join(root, 'src/main.tsx'))).toBe(false)
  })

  it('incrementally picks up a newly added route and reports the tree changed', async () => {
    const gen = createRouteGenerator(resolveOptions({ disableLogging: true }), root, logger)
    await gen.generateOnce()

    const added = write(
      'src/routes/contact.tsx',
      `import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/contact')({ component: () => <div>contact</div> })
`,
    )
    const changed = await gen.handleFileEvent('create', added)
    expect(changed).toBe(true)
    expect(fs.readFileSync(gen.generatedTreeAbsPath, 'utf-8')).toContain('contact')
  })
})
