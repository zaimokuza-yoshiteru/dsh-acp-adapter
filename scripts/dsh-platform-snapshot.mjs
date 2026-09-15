/**
 * Checked-in copy of the DSH web platform module rows consumed by the client
 * bundle. The host does not publish its tsdown preset as a package export, so
 * this snapshot is intentionally local. verify-dsh-reference.mjs compares it
 * with the checked-out host source during the source/E2E lane.
 */
/** PLATFORM_MODULES plus PRELOADED_CLIENT_EXTERNALS for the web client. */
export const PLATFORM_EXTERNALS = Object.freeze([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const packageName = (specifier) => specifier.startsWith('@')
  ? specifier.split('/').slice(0, 2).join('/')
  : specifier.split('/')[0]

/** Package names corresponding to module-table rows, used for inject checks. */
export const PLATFORM_PACKAGES = new Set(PLATFORM_EXTERNALS.map(packageName))
