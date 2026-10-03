import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { client: './client.ts' },
  outDir: './lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  clean: true,
  deps: {
    neverBundle: (specifier) => specifier === 'react',
    alwaysBundle: (specifier) => specifier !== 'react',
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@dsh-acp-adapter/test-render-probe", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
