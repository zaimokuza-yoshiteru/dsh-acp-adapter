param([Parameter(Mandatory=$true)][string]$AuditRoot)
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
npm install --prefix $manager --ignore-scripts --no-audit --no-fund pnpm@10.7.0
pnpm install --frozen-lockfile --store-dir (Join-Path $AuditRoot 'pnpm-store')
pnpm typecheck
pnpm test --no-file-parallelism
pnpm build
node scripts/check-windows-mcp-links.mjs lib/host/teams/devin-config.js
npm pack --ignore-scripts
