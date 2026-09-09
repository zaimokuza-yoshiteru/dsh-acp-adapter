import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const sourcePrefix = fileURLToPath(new URL('./src/', import.meta.url)).replaceAll('\\', '/')

export default defineConfig({
  define: {
    __DSH_ACP_ADAPTER_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version),
  },
  plugins: [
    {
      name: 'dsh-acp-tc39-decorators',
      // vite 8（rolldown/oxc）不降级 TC39 标准装饰器（任何 target 都保留语法，
      // 2025 baseline 浏览器假定），而 node 24 的 V8 尚不支持；
      // src/remote/service.ts 的 @Remote 进入测试链。用生产同款编译器（tsc
      // transpileModule，默认即 TC39 装饰器语义）对含 @Remote 的文件预降级，
      // 与 lib/types 的 tsc emit 语义零漂移。enforce:'pre' 先于 vite:oxc。
      enforce: 'pre',
      transform(code, id) {
        const normalizedId = id.replaceAll('\\', '/')
        if (!normalizedId.startsWith(sourcePrefix) || !code.includes('@Remote')) return undefined
        const out = ts.transpileModule(code, {
          fileName: id,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            sourceMap: true,
          },
        })
        return { code: out.outputText, map: out.sourceMapText ?? null }
      },
    },
  ],
  resolve: {
    alias: {
      // Published DSH client entries are loader-registration wrappers, not
      // Node ESM. Tests execute the same supported-alpha implementation emitted beside
      // its declarations; production keeps the public /client module-table edge.
      '@deepseek-ai/dsh-api-gateway/client': fileURLToPath(new URL(
        './node_modules/@deepseek-ai/dsh-api-gateway/lib/types/client/index.js',
        import.meta.url,
      )),
      // React 与 UI primitives 由宿主模块表提供。普通测试使用元素树替身；
      // 真实渲染、effects 和交互由加载已构建插件的浏览器 E2E 验证。
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./test/ui-primitives-stub.mjs', import.meta.url),
      ),
      react: fileURLToPath(new URL('./test/react-stub.mjs', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.spec.ts'],
  },
})
