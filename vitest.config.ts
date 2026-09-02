import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const sourcePrefix = fileURLToPath(new URL('./src/', import.meta.url)).replaceAll('\\', '/')

export default defineConfig({
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
      // react 是宿主平台模块（loader 模块表在运行时应答），本包按纪律不安装；
      // client 注册测试（client-registration.spec.ts 经 apply → 组件模块）需要
      // 两个值级 import 可解析。组件渲染从不被测试消费——stub 只满足模块加载，
      // 行为断言全部落在 data/glue 层。ui-primitives 同理（baseline 行，其真实
      // lib 会 import react/jsx-runtime，node 下不可解析）。
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./test/ui-primitives-stub.mjs', import.meta.url),
      ),
      react: fileURLToPath(new URL('./test/react-stub.mjs', import.meta.url)),
    },
  },
  test: {
    // Mock ACP server contract suites are included by this pattern; an empty
    // contract directory remains valid and must still pass.
    include: ['test/**/*.spec.ts'],
    passWithNoTests: true,
  },
})
