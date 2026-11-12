[CmdletBinding()]
param([switch]$Install, [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')][string]$At = '02:00')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script = Join-Path $PSScriptRoot 'backup-stack.mjs'
if (-not $Install) {
    Write-Output 'No task installed. Run backup-stack.mjs backup --verify --init-key once, keep the backup key separately off-host, then opt in with .\scripts\schedule-backup.ps1 -Install -At 02:00.'
    return
}
$node = (Get-Command node -ErrorAction Stop).Source
if ($node.Contains('"') -or $script.Contains('"')) { throw 'Unexpected quote in executable/script path.' }
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $script + '" backup --verify') -WorkingDirectory $workspace
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture))
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'Astrama verified encrypted backup' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Quiesce local Astrama, encrypt the DB/private objects/key and verify a full isolated restore. Requires this Windows user logged in and Docker Desktop running.' | Out-Null
Write-Output 'Installed the daily task for the current Windows user. It runs only while that user is logged in; wire task failures and stale backup heartbeat to your operational alerts.'
