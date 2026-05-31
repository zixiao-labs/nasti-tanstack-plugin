import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  // Nasti is a peer dependency and only ever imported as a type; never bundle it.
  // @tanstack/* and oxc-* are real deps and should stay external (resolved by the
  // consumer's node_modules) so the plugin tracks the user's installed versions.
  external: ['@nasti-toolchain/nasti', '@tanstack/react-router'],
})
