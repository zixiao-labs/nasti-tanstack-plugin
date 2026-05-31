import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

// Not exported — the plugin hoists this into its own chunk during build.
function Home() {
  return <h1>Home</h1>
}
