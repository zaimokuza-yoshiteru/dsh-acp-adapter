/**
 * Additive ACP composition root. DSH owns the AgentLoop, ModelPicker, and
 * conversation surface; this plugin contributes only ACP LLM routes and its
 * existing settings/sidecar services through public seams.
 */
import type { Context } from '@deepseek-ai/cordis'
import { installInstalledProfileRegistry } from './installed-profile-registry.ts'

export const name = 'dsh-acp-adapter'
// Wait for the host-owned seams before creating routes. This avoids freezing a
// missing sessions/subprocess service during an early composition pass.
// Settings is a required host seam. The ACP namespace must be registered as
// part of the composition lifecycle; relying on a nested dynamic inject can
// leave the route row present while the settings watcher never starts.
// Attachment storage is required because ACP image capability is only true
// when DSH can read its durable image references.  Waiting for this seam at
// composition time prevents a health probe from freezing a false
// `promptImage: unsupported` result before the host finishes booting.
export const inject = ['llm', 'sessions', 'subprocess', 'dshHomePath', 'settings', 'attachments']

export function apply(ctx: Context): void {
  installInstalledProfileRegistry(ctx, { installRemote: true })
}

export { installInstalledProfileRegistry } from './installed-profile-registry.ts'
