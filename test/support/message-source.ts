/** An independently installed plugin may contribute its own durable message source. */
import type {} from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'test-plugin': { kind: 'test-plugin'; plugin: string } }
}
