import { describe, it, expect } from 'vitest'
import {
  transformReferenceRoute,
  loadSplitModule,
  isSplitVirtualId,
  parseSplitVirtualId,
  resolveSplitId,
} from '../src/code-splitter'

const F = '/proj/src/routes/posts.tsx'

function collectSkips(code: string, file = F) {
  const skips: string[] = []
  const out = transformReferenceRoute(code, file, (r) => skips.push(r))
  return { out, skips }
}

describe('virtual id helpers', () => {
  it('detects and parses split ids', () => {
    expect(isSplitVirtualId('/a/b.tsx?tsr-split=component')).toBe(true)
    expect(isSplitVirtualId('/a/b.tsx')).toBe(false)
    expect(parseSplitVirtualId('/a/b.tsx?tsr-split=errorComponent')).toEqual({
      base: '/a/b.tsx',
      prop: 'errorComponent',
    })
    expect(parseSplitVirtualId('/a/b.tsx')).toBeNull()
  })

  it('resolves relative split specifiers against the importer', () => {
    expect(resolveSplitId('./b.tsx?tsr-split=component', '/a/x.tsx')).toBe(
      '/a/b.tsx?tsr-split=component',
    )
  })
})

describe('transformReferenceRoute', () => {
  it('splits a component referencing a non-exported function and the Route', () => {
    const code = `import { createFileRoute } from '@tanstack/react-router'
import { fetchPosts } from '../api'
export const Route = createFileRoute('/posts')({
  loader: fetchPosts,
  component: PostsComponent,
})
function PostsComponent() {
  const posts = Route.useLoaderData()
  return <ul>{posts.length}</ul>
}
`
    const { out, skips } = collectSkips(code)
    expect(skips).toEqual([])
    expect(out).not.toBeNull()
    expect(out!.code).toContain('lazyRouteComponent($$tsrSplit_component, "component")')
    expect(out!.code).toContain('import("./posts.tsx?tsr-split=component")')
    expect(out!.code).toContain('import { lazyRouteComponent } from "@tanstack/react-router"')
    // loader stays inline
    expect(out!.code).toContain('loader: fetchPosts')

    const virt = loadSplitModule(code, F, 'component')
    expect(virt).not.toBeNull()
    expect(virt!.code).toContain('export const component = PostsComponent')
    expect(virt!.code).toContain('import { Route } from "./posts.tsx"')
    expect(virt!.code).toContain('PostsComponent')
  })

  it('splits an inline arrow component', () => {
    const code = `import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/i')({
  component: () => <div>hi</div>,
})
`
    const { out, skips } = collectSkips(code, '/proj/src/routes/i.tsx')
    expect(skips).toEqual([])
    expect(out!.code).toContain('lazyRouteComponent($$tsrSplit_component, "component")')
    const virt = loadSplitModule(code, '/proj/src/routes/i.tsx', 'component')
    expect(virt!.code).toContain('export const component')
  })

  it('splits component + errorComponent into separate importers', () => {
    const code = `import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/t')({
  component: Comp,
  errorComponent: Err,
})
function Comp() { return null }
function Err() { return null }
`
    const { out, skips } = collectSkips(code, '/proj/src/routes/t.tsx')
    expect(skips).toEqual([])
    expect(out!.code).toContain('$$tsrSplit_component')
    expect(out!.code).toContain('$$tsrSplit_errorComponent')
    expect(loadSplitModule(code, '/proj/src/routes/t.tsx', 'errorComponent')!.code).toContain(
      'export const errorComponent = Err',
    )
  })

  it('returns null for a route with no splittable props', () => {
    const code = `import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/x')({ loader: () => 1 })
`
    const { out, skips } = collectSkips(code, '/proj/src/routes/x.tsx')
    expect(out).toBeNull()
    expect(skips).toEqual([])
  })

  it('carries imports referenced only as JSX tags into the split module', () => {
    const code = `import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
export const Route = createRootRoute({ component: RootLayout })
function RootLayout() {
  return <><Link to="/">Home</Link><Outlet /></>
}
`
    const file = '/proj/src/routes/__root.tsx'
    const { out, skips } = collectSkips(code, file)
    expect(skips).toEqual([])
    expect(out!.code).toContain('lazyRouteComponent($$tsrSplit_component, "component")')

    const virt = loadSplitModule(code, file, 'component')!
    // The split module MUST re-import Link and Outlet (they're used as JSX tags).
    expect(virt.code).toContain('@tanstack/react-router')
    expect(virt.code).toContain('Link')
    expect(virt.code).toContain('Outlet')
    expect(virt.code).toContain('export const component')
  })

  it('returns null for non-route files', () => {
    expect(transformReferenceRoute(`export const a = 1`, '/proj/src/routes/util.ts')).toBeNull()
  })

  it('skips (does not split) when a module-local is shared with non-split code', () => {
    const code = `import { createFileRoute } from '@tanstack/react-router'
const cache = new Map()
export const Route = createFileRoute('/c')({
  loader: () => cache.set('k', 1),
  component: Comp,
})
function Comp() { return cache.get('k') }
`
    const { out, skips } = collectSkips(code, '/proj/src/routes/c.tsx')
    expect(out).toBeNull()
    expect(skips.join('\n')).toContain('cache')
  })

  it('skips when a split-only local has a side-effectful (non-movable) initializer', () => {
    const code = `import { createFileRoute } from '@tanstack/react-router'
const banner = makeBanner()
export const Route = createFileRoute('/d')({
  component: () => banner,
})
`
    const { out, skips } = collectSkips(code, '/proj/src/routes/d.tsx')
    expect(out).toBeNull()
    expect(skips.join('\n')).toContain('banner')
  })

  it('handles multibyte source correctly (offset calibration)', () => {
    const code = `import { createFileRoute } from '@tanstack/react-router'
// 中文注释 émoji 🎉 keep spans aligned
export const Route = createFileRoute('/m')({ component: Comp })
function Comp() { return <span>ok</span> }
`
    const { out } = collectSkips(code, '/proj/src/routes/m.tsx')
    expect(out!.code).toContain('lazyRouteComponent($$tsrSplit_component, "component")')
    const virt = loadSplitModule(code, '/proj/src/routes/m.tsx', 'component')
    expect(virt!.code).toContain('export const component = Comp')
    expect(virt!.code).toContain('Comp')
  })
})
