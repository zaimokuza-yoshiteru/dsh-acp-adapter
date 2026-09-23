param([Parameter(Mandatory=$true)][string]$AuditRoot, [switch]$Live)
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
# Test the actual consumer, not only that our registration succeeds. No login/model calls.
$devinVersion = if ($env:DEVIN_TEST_VERSION) { $env:DEVIN_TEST_VERSION } else { '3000.10.31' }
$devinSha = switch ($devinVersion) {
  '3000.10.31' { '2752bc02ca6ff5fa55031d5dac6a6886e5bcca9e37edeb05fde635a240ced89f' }
  '3000.3.27' { '254c8085137474d883cf6a6309ed98269fe4489cb83c67722d8b2279e443e11c' }
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
  node scripts/check-devin-live.ts $devinExe[0].FullName
} else {
  npm pack --ignore-scripts
}
