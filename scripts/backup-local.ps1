[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

function Invoke-Docker {
    param([string[]] $Arguments)
    $result = & docker @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Docker operation failed: $($Arguments[0]). $($result -join [Environment]::NewLine)" }
    return ($result -join [Environment]::NewLine)
}

# Fixed local project/container/database names prevent an accidental remote or live restore.
$contextName = (Invoke-Docker -Arguments @('context', 'show')).Trim()
if ($contextName -notin @('default', 'desktop-linux')) { throw 'Select the local default or desktop-linux Docker context first.' }
$context = (Invoke-Docker -Arguments @('context', 'inspect', $contextName) | ConvertFrom-Json)[0]
$endpoint = $context.Endpoints.docker.Host
if ($endpoint -notmatch '^(npipe:/{4}\.\/pipe/[^/]+|unix:///var/run/docker\.sock)$') { throw 'Backup requires a local Docker socket.' }
if ($env:DOCKER_HOST -or $env:DOCKER_CONTEXT) { throw 'Unset Docker endpoint/context environment overrides before this local operation.' }
$containerName = 'astrama-local-db-1'
$container = (Invoke-Docker -Arguments @('inspect', $containerName) | ConvertFrom-Json)[0]
if (-not $container.State.Running -or $container.Config.Labels.'com.docker.compose.project' -ne 'astrama-local' -or $container.Config.Labels.'com.docker.compose.service' -ne 'db' -or $container.Config.Image -notmatch '^postgres:16') { throw 'Expected the running astrama-local PostgreSQL 16 Compose service.' }

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backupDirectory = [IO.Path]::GetFullPath((Join-Path $workspace '.local-backups'))
if (-not $backupDirectory.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup directory must stay inside this workspace.' }
if (Test-Path -LiteralPath $backupDirectory) {
    if ((Get-Item -LiteralPath $backupDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Backup directory cannot be a link or junction.' }
} else { $null = New-Item -ItemType Directory -Path $backupDirectory }
$suffix = [Guid]::NewGuid().ToString('N')
$restoreDatabase = "astrama_restore_$suffix"
if ($restoreDatabase -notmatch '^astrama_restore_[0-9a-f]{32}$' -or $restoreDatabase -eq 'astrama') { throw 'Unsafe restore database name.' }
$containerDump = "/tmp/astrama-backup-$suffix.dump"
$backupPath = [IO.Path]::GetFullPath((Join-Path $backupDirectory ("astrama-{0}-{1}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $suffix)))
if (-not $backupPath.StartsWith($backupDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe backup path.' }
$restoreCreated = $false
try {
    $null = Invoke-Docker -Arguments @('exec', $containerName, 'pg_dump', '-U', 'astrama_owner', '-d', 'astrama', '-Fc', '-f', $containerDump)
    # docker cp preserves the custom-format binary; PowerShell never decodes/re-encodes the dump.
    $null = Invoke-Docker -Arguments @('cp', "${containerName}:$containerDump", $backupPath)
    $null = Invoke-Docker -Arguments @('exec', $containerName, 'createdb', '-U', 'astrama_owner', $restoreDatabase)
    $restoreCreated = $true
    $null = Invoke-Docker -Arguments @('exec', $containerName, 'pg_restore', '-U', 'astrama_owner', '--exit-on-error', '-d', $restoreDatabase, $containerDump)
    $countsSql = "SELECT 'tenants='||count(*) FROM public.tenants UNION ALL SELECT 'users='||count(*) FROM public.users UNION ALL SELECT 'tickets='||count(*) FROM public.tickets UNION ALL SELECT 'activities='||count(*) FROM public.activities UNION ALL SELECT 'audits='||count(*) FROM public.audits UNION ALL SELECT 'attachments='||count(*) FROM public.attachments UNION ALL SELECT 'migrations='||count(*) FROM public._prisma_migrations;"
    $counts = Invoke-Docker -Arguments @('exec', $containerName, 'psql', '-U', 'astrama_owner', '-d', $restoreDatabase, '-v', 'ON_ERROR_STOP=1', '-At', '-c', $countsSql)
    if (($counts -split '\r?\n').Count -ne 7 -or $counts -notmatch 'migrations=[1-9][0-9]*') { throw 'Restore verification did not return the expected table counts.' }
    Write-Output "Restored database table counts (no record content):`n$counts"
    Write-Output "Backup: $backupPath"
    Write-Output "SHA256: $((Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash)"
} finally {
    if ($restoreCreated) {
        if ($restoreDatabase -notmatch '^astrama_restore_[0-9a-f]{32}$') { throw 'Refusing unsafe temporary database cleanup.' }
        $null = Invoke-Docker -Arguments @('exec', $containerName, 'dropdb', '-U', 'astrama_owner', '--if-exists', $restoreDatabase)
    }
    # The single generated container file is the only file removed; the host backup is retained.
    if ($containerDump -notmatch '^/tmp/astrama-backup-[0-9a-f]{32}\.dump$') { throw 'Refusing unsafe temporary file cleanup.' }
    $null = Invoke-Docker -Arguments @('exec', $containerName, 'rm', '--', $containerDump)
}
