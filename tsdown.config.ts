/**
 * Browser bundle compatible with the DSH module loader. The official preset at
 * packages/client/tsdown.client.ts is not a public package export, so its loader
 * wrapper, inline CSS and bundle-purity gates are maintained here. The external
 * module table comes from scripts/dsh-platform-snapshot.ts and is checked by
 * verify-dsh-reference.ts against the pinned source scaffold.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'
import { PLATFORM_EXTERNALS } from './scripts/dsh-platform-snapshot.ts'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
  dsh?: { client?: { external?: unknown } }
}

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches ids
 * ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit one plugin-owned style injector plus the CSS Modules class map (preset styleInjectionModule, class-map arm only). */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(`export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

const declaredExternals = manifest.dsh?.client?.external
const externals = new Set<string>([
  ...PLATFORM_EXTERNALS,
  ...(Array.isArray(declaredExternals) ? declaredExternals.filter((e): e is string => typeof e === 'string') : []),
])

/** Inline-safe wire/type layers (preset INLINE_SAFE): no shared runtime identity. */
const INLINE_SAFE =
  /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|deque|output-retention|typert-protocol|util-crypto|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-native-command\/types$|@deepseek-ai\/dsh-host-open-in-app\/shared$|@deepseek-ai\/dsh-plugin-manager\/registry$|@deepseek-ai\/dsh-agent-preset-registry\/display$|@deepseek-ai\/dsh-api-workspace-controller\/default-workspace$|@deepseek-ai\/dsh-spill-policy\/notice$)/
/** Vendored framework libraries rescoped into @deepseek-ai (preset VENDORED_LIBRARY). */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
/** Generated descriptor/codec contribution (preset GENERATED_REMOTE). */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const nodeEnv = process.env.NODE_ENV ?? 'production'

export default defineConfig([
  {
    entry: { client: 'src/client/index.ts' },
    // The browser bundle lands next to the host half (single lib/ artifact dir);
    // clean stays off so the tsc-emitted host output survives.
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    // Plugin code is fetched outside Vite's module graph, so its own bundle must
    // carry the TS mapping; the host serves the map next to the bundle.
    sourcemap: true,
    clean: false,
    deps: {
      // Requested module-table rows (baseline + dsh.client.external) stay
      // require() calls; matching is exact, like the preset's clientExternals.
      neverBundle: (specifier) => externals.has(specifier),
      // Everything NOT requested from the loader module table must inline.
      alwaysBundle: (specifier) => !externals.has(specifier),
    },
    define: {
      __DSH_ACP_ADAPTER_VERSION__: JSON.stringify(manifest.version),
      'process.env.NODE_ENV': JSON.stringify(nodeEnv),
      'import.meta.env.MODE': JSON.stringify(nodeEnv),
      'import.meta.env': JSON.stringify({ MODE: nodeEnv }),
    },
    plugins: [
      {
        name: 'dsh-client-bundle-purity',
        resolveId(source) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (externals.has(source)) return null // requested module-table row: external wins
          if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
          if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point
          throw new Error(
            `client bundle purity: "${source}" is not in the DSH platform snapshot or this package's dsh.client.external, ` +
              'an inline-safe wire layer, or a generated /remote contribution — cross-plugin value imports are forbidden; ' +
              'declare a non-default module request or collaborate through cordis services ' +
              '(type-only imports are erased and never reach this gate)',
          )
        },
      },
      {
        // 复刻 preset 的 dsh-css-modules-inline（只要 module.css 一臂——本包
        // 无全局 css / ?inline 需求）：`.module.css` 经 lightningcss 编译（hashed
        // class map，pattern 与 preset 相同），产物模块幂等注入
        // <style data-plugin=<包名> data-plugin-css="<包名>/<basename>"> 并默认导出
        // classMap；data-plugin 动态读取 manifest.name。
        name: 'dsh-css-modules-inline',
        resolveId(source, importer) {
          if (!source.endsWith('.module.css')) return null
          const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
          return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
        },
        async load(virtualId) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
          const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
          // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
          this.addWatchFile(fileId)
          const source = await readFile(fileId)
          const { code, exports: cssExports } = transform({
            filename: fileId,
            code: source,
            cssModules: { pattern: '[hash]_[local]' },
            minify: true,
          })
          const classMap: Record<string, string> = {}
          const exportEntries = Object.entries(cssExports ?? {}).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          )
          for (const [local, exp] of exportEntries) classMap[local] = exp.name
          return styleInjectionModule(manifest.name, fileId, code.toString(), classMap)
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
