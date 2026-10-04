param([switch]$Live)
# CI bootstrap only. All package commands run in the unprivileged child account.
$ErrorActionPreference = 'Stop'
if ($Live -and $env:DEVIN_TEST_MODEL -cne 'swe-2-high') { throw 'Live Windows CI requires the configured Devin test model' }
if ($Live -and ($env:GITHUB_RUN_ID -notmatch '^\d{1,15}$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d{1,15}$')) { throw 'Live Windows CI requires numeric workflow run metadata' }
$auditUser = 'dsh-acp-ci'
$auditRoot = Join-Path $env:RUNNER_TEMP ('dsh-acp-user-' + [guid]::NewGuid().ToString('N'))
$runnerTraceDirectory = $env:DEVIN_LIVE_TRACE_DIR
$workspace = (Get-Location).Path
$developerKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$developerProperty = 'AllowDevelopmentWithoutDevLicense'
$previousDeveloperMode = Get-ItemPropertyValue -Path $developerKey -Name $developerProperty -ErrorAction SilentlyContinue
$createdUser = $false
$grantedWorkspace = $false
$traceCopyFailed = $false
$traceRunSucceeded = $false
try {
  New-Item -ItemType Directory -Path $auditRoot | Out-Null
  if ($Live) {
    if (!$runnerTraceDirectory) { throw 'Live Windows CI requires a dedicated trace output directory' }
    New-Item -ItemType Directory -Path (Join-Path $auditRoot 'devin-live-diagnostics') -Force | Out-Null
    New-Item -ItemType Directory -Path $runnerTraceDirectory -Force | Out-Null
  }
  # Include npm so the ordinary user can install its own pinned pnpm without
  # relying on an administrator's package-manager installation or cache.
  Copy-Item (Split-Path (Get-Command node).Source) (Join-Path $auditRoot 'node') -Recurse
  $auditPassword = ConvertTo-SecureString ('Aa1!' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
  $account = New-LocalUser -Name $auditUser -Password $auditPassword -AccountNeverExpires -PasswordNeverExpires
  $createdUser = $true
  $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
  if (!(Get-LocalGroupMember -Group $usersGroup | Where-Object { $_.SID -eq $account.SID })) {
    Add-LocalGroupMember -Group $usersGroup -Member $account
  }
  if (Get-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-544') | Where-Object { $_.SID -eq $account.SID }) { throw 'CI account must not be an administrator' }
  & icacls $auditRoot /grant ('*' + $account.SID.Value + ':(OI)(CI)M') /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to grant toolchain directory access' }
  & icacls $workspace /grant ('*' + $account.SID.Value + ':(OI)(CI)M') /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to grant workspace access' }
  $grantedWorkspace = $true
  if (!(Test-Path $developerKey)) { New-Item -Path $developerKey -Force | Out-Null }
  New-ItemProperty -Path $developerKey -Name $developerProperty -Value 0 -PropertyType DWord -Force | Out-Null
  $credentials = [pscredential]::new(($env:COMPUTERNAME + '\' + $auditUser), $auditPassword)
  $stdout = Join-Path $auditRoot 'stdout.log'
  $stderr = Join-Path $auditRoot 'stderr.log'
  $arguments = '-NoLogo -NoProfile -NonInteractive -File "' + (Join-Path $workspace 'scripts/windows-user-ci.ps1') + '" -AuditRoot "' + $auditRoot + '"'
  if ($Live) {
    $arguments += ' -Live -DevinTestModel swe-2-high -WorkflowRunId ' + $env:GITHUB_RUN_ID + ' -WorkflowRunAttempt ' + $env:GITHUB_RUN_ATTEMPT
  }
  $child = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList $arguments -WorkingDirectory $workspace -Credential $credentials -LoadUserProfile -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  if (!$child.WaitForExit(1800000)) { $child.Kill(); throw 'Ordinary-user CI timed out' }
  $child.WaitForExit()
  Get-Content $stdout
  Get-Content $stderr
  $summary = Join-Path $auditRoot 'summary.md'
  if ($env:GITHUB_STEP_SUMMARY -and (Test-Path $summary)) {
    Get-Content -Raw $summary | Add-Content -Path $env:GITHUB_STEP_SUMMARY
  }
  if ($child.ExitCode -ne 0) { throw "Ordinary-user CI failed: $($child.ExitCode)" }
  $traceRunSucceeded = $true
} finally {
  if ($Live) {
    try {
      $childTraceDirectory = Join-Path $auditRoot 'devin-live-diagnostics'
      $safeTraceFiles = @(Get-ChildItem -LiteralPath $childTraceDirectory -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^real-devin-live-[a-f0-9]{24}\.jsonl$' })
      foreach ($traceFile in $safeTraceFiles) {
        Copy-Item -LiteralPath $traceFile.FullName -Destination (Join-Path $runnerTraceDirectory $traceFile.Name) -Force
      }
      if ($safeTraceFiles.Count -eq 0) {
        $traceCopyFailed = $true
        Write-Warning 'No safe Devin live JSONL trace was produced by the ordinary-user process'
      }
    } catch {
      $traceCopyFailed = $true
      Write-Warning 'Could not copy the safe Devin live JSONL trace before audit cleanup'
    }
  }
  if ($null -eq $previousDeveloperMode) {
    Remove-ItemProperty -Path $developerKey -Name $developerProperty -ErrorAction SilentlyContinue
  } else {
    Set-ItemProperty -Path $developerKey -Name $developerProperty -Value $previousDeveloperMode
  }
  if ($grantedWorkspace) { & icacls $workspace /remove:g ('*' + $account.SID.Value) /T /Q | Out-Null }
  if ($createdUser) { Remove-LocalUser -Name $auditUser }
  Remove-Item -LiteralPath $auditRoot -Recurse -Force -ErrorAction SilentlyContinue
  if ($Live -and $traceRunSucceeded -and $traceCopyFailed) { throw 'Failed to preserve safe Devin live diagnostics' }
}
