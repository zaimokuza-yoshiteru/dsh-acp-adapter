param([Parameter(Mandatory=$true)][string]$AuditRoot, [string]$DevinTestModel, [string]$WorkflowRunId, [string]$WorkflowRunAttempt, [switch]$Live)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Package CI must not run as administrator' }
Write-Output "Ordinary-user CI: $($identity.Name)"
$env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
$env:HOME = $env:USERPROFILE
$env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
$env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
$env:TEMP = Join-Path $AuditRoot 'tmp'
$env:TMP = $env:TEMP
$env:NPM_CONFIG_CACHE = Join-Path $AuditRoot 'npm-cache'
$env:NPM_CONFIG_USERCONFIG = Join-Path $AuditRoot '.npmrc'
$env:PNPM_HOME = Join-Path $AuditRoot 'pnpm-home'
# Report locally; the bootstrap account forwards it to the runner-owned summary.
$env:GITHUB_STEP_SUMMARY = Join-Path $AuditRoot 'summary.md'
$manager = Join-Path $AuditRoot 'package-manager'
$env:PATH = (Join-Path $AuditRoot 'node') + ';' + (Join-Path $manager 'node_modules\.bin') + ';' + $env:PATH
New-Item -ItemType Directory -Force $env:TEMP, $env:PNPM_HOME | Out-Null
Set-Content -Path $env:NPM_CONFIG_USERCONFIG -Value ''
git config --global --add safe.directory (Get-Location).Path
if (!$Live) {
npm install --prefix $manager --ignore-scripts --no-audit --no-fund pnpm@10.7.0
pnpm install --frozen-lockfile --store-dir (Join-Path $AuditRoot 'pnpm-store')
pnpm typecheck
pnpm test --no-file-parallelism
pnpm build
}
# Test actual session-supplied MCP discovery without login or model calls.
$devinVersion = if ($env:DEVIN_TEST_VERSION) { $env:DEVIN_TEST_VERSION } else { '3000.12.43' }
$devinSha = switch ($devinVersion) {
  '3000.12.43' { 'a76947bbcda169b64fd00b9faaab2baf4f92c613db28dec1b8dce5c48ba80fcd' }
  default { throw 'Unsupported Devin test version' }
}
$devinZip = Join-Path $AuditRoot 'devin.zip'
Invoke-WebRequest -Uri "https://static.devin.ai/cli/$devinVersion/devin-$devinVersion-x86_64-pc-windows.zip" -OutFile $devinZip
if ((Get-FileHash -Algorithm SHA256 $devinZip).Hash.ToLowerInvariant() -ne $devinSha) { throw 'Devin archive integrity mismatch' }
$devinRoot = Join-Path $AuditRoot 'devin'
Expand-Archive -Path $devinZip -DestinationPath $devinRoot
$devinExe = @(Get-ChildItem $devinRoot -Recurse -Filter devin.exe)
if ($devinExe.Count -ne 1) { throw 'Expected one Devin executable' }
$actualVersion = & $devinExe[0].FullName version
Write-Output $actualVersion
if (!$actualVersion.StartsWith("devin $devinVersion (")) { throw 'Devin executable version mismatch' }
node scripts/check-devin-mcp.ts $devinExe[0].FullName ([Environment]::GetFolderPath('ApplicationData'))
if ($Live) {
  if (!$env:WINDSURF_API_KEY) { throw 'Missing DEVIN_CLI_TOKEN Secret in ordinary-user process' }
  if ($DevinTestModel -cne 'swe-2-high') { throw 'Missing configured Devin test model in ordinary-user process' }
  if ($WorkflowRunId -notmatch '^\d{1,15}$' -or $WorkflowRunAttempt -notmatch '^\d{1,15}$') { throw 'Missing safe Devin live workflow metadata' }
  $env:DEVIN_LIVE_WORKFLOW_RUN = $WorkflowRunId
  $env:DEVIN_LIVE_WORKFLOW_ATTEMPT = $WorkflowRunAttempt
  $env:DEVIN_LIVE_TRACE_DIR = Join-Path $AuditRoot 'devin-live-diagnostics'
  New-Item -ItemType Directory -Path $env:DEVIN_LIVE_TRACE_DIR -Force | Out-Null
  $env:DEVIN_TEST_MODEL = $DevinTestModel
  node scripts/check-devin-live.ts $devinExe[0].FullName
} else {
  npm pack --ignore-scripts
}
