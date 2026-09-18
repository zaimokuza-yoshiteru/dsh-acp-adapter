// Called by actions/github-script in a separate, non-blocking notification job.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

module.exports = async ({ github, context, core }, directory = '.local/registry-release') => {
  try {
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'))
    if (report.status !== 'fallback') return
    const marker = '<!-- dsh-acp-registry-sync-fallback -->'
    const run = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`
    const summary = readFileSync(join(directory, 'summary.md'), 'utf8')
    const body = `${marker}\n\nRegistry 同步失败，发布继续使用仓库中的已验证快照。此问题不阻塞部署。\n\n最近一次：[工作流日志与快照](${run})\n\n${summary}\n排查上游目录或包元数据后，可运行 registry sync 验证修复并将新快照提交到仓库。`
    const issues = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, state: 'open', creator: 'github-actions[bot]', per_page: 100 })
    const existing = issues.find(issue => !issue.pull_request && issue.body?.includes(marker))
    const result = existing
      ? await github.rest.issues.update({ ...context.repo, issue_number: existing.number, body })
      : await github.rest.issues.create({ ...context.repo, title: 'ACP Registry 自动同步失败：发布已沿用旧快照', body })
    core.notice(`Registry fallback tracked at ${result.data.html_url}`)
    await core.summary.addRaw(`Registry 回退已记录：[issue](${result.data.html_url})\n`).write()
  } catch (error) {
    core.warning(`Registry issue notification failed; deployment is unaffected: ${error.message}`)
  }
}
