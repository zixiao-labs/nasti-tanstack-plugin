// Example Nasti config. We import the plugin from the built dist via a relative
// path so the example needs no install of its own; the plugin's runtime deps
// resolve from the plugin's node_modules, and react / react-dom /
// @tanstack/react-router resolve by walking up to the plugin's node_modules.
import { tanstackRouter } from '../../dist/index.js'

export default {
  framework: 'react',
  plugins: [
    tanstackRouter({
      autoCodeSplitting: true,
    }),
  ],
}
