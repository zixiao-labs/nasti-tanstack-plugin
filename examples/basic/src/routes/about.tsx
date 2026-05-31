import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: About,
})

// References `Route` — exercises the split module importing the route object back
// from the original file (`import { Route } from './about.tsx'`).
function About() {
  return <h1>About — {Route.fullPath}</h1>
}
