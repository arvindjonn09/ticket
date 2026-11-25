[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$KeepStack,
    [string]$TestSource = "",
    [ValidateSet('all', 'chromium', 'firefox', 'webkit')]
    [string]$Project = 'all',
    [ValidateSet('onboarding', 'operator', 'all')]
    [string]$Journey = 'onboarding'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (!$TestSource) { $TestSource = Join-Path $repository 'e2e' }
$TestSource = (Resolve-Path $TestSource).Path
$prefix = 'astrama-onboarding-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$slug = 'browser-' + [guid]::NewGuid().ToString()
$network = "$prefix-net"
$containers = New-Object 'System.Collections.Generic.List[string]'
$networkCreated = $false
$apiImage = 'astrama-hosted-e2e-api:local'
$webImage = 'astrama-hosted-e2e-web:local'
$browserImage = 'astrama-hosted-e2e-browser:local'

function Invoke-Docker {
    param([string[]]$DockerArguments)
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker $($DockerArguments[0]) failed (exit $LASTEXITCODE)" }
}

function Start-TestContainer {
    param([string]$Name, [string[]]$DockerArguments)
    $containers.Add($Name)
    Invoke-Docker -DockerArguments (@('run', '--detach', '--name', $Name, '--network', $network) + $DockerArguments) | Out-Null
}

function New-TestSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

$runtimeUrl = "postgresql://astrama_app:hosted-local-app@$prefix-db`:5432/astrama"
$ownerUrl = "postgresql://astrama_owner:hosted-local-owner@$prefix-db`:5432/astrama"
$environment = @(
    '-e', 'NODE_ENV=development', '-e', 'PLATFORM_MODE=hosted',
    '-e', 'APP_BASE_DOMAIN=astrama.test', '-e', 'APP_ORIGIN=https://astrama.test',
    '-e', 'PUBLIC_SITE_ORIGIN=https://astrama.test', '-e', 'OPERATOR_ORIGIN=https://ops.astrama.test',
    '-e', "DATABASE_URL=$runtimeUrl", '-e', "MIGRATION_DATABASE_URL=$ownerUrl",
    '-e', 'APP_DB_PASSWORD=hosted-local-app', '-e', "MFA_ENCRYPTION_KEY=$(New-TestSecret)",
    '-e', "CAPTCHA_HMAC_SECRET=$(New-TestSecret)", '-e', 'PAYMENT_PROVIDER=test',
    '-e', 'TEST_PAYMENT_WEBHOOK_SECRET=hosted-e2e-payment-secret',
    '-e', "SMTP_HOST=$prefix-mail", '-e', 'SMTP_PORT=1025', '-e', 'SMTP_FROM=desk@astrama.test',
    '-e', "MAILPIT_URL=http://$prefix-mail`:8025",
    '-e', "S3_ENDPOINT=http://$prefix-storage`:9000", '-e', 'S3_BUCKET=hosted-e2e-fixtures',
    '-e', 'S3_ACCESS_KEY=hosted-local', '-e', 'S3_SECRET_KEY=hosted-local-storage-password'
)

try {
    if (!$SkipBuild) {
        foreach ($image in @(@('api', $apiImage), @('web', $webImage), @('e2e', $browserImage))) {
            Invoke-Docker -DockerArguments @('build', '-f', (Join-Path $repository 'infra/Dockerfile'), '--target', $image[0], '-t', $image[1], $repository)
        }
    }
    Invoke-Docker -DockerArguments @('network', 'create', $network) | Out-Null
    $networkCreated = $true
    Start-TestContainer -Name "$prefix-db" -DockerArguments @(
        '-e', 'POSTGRES_DB=astrama', '-e', 'POSTGRES_USER=astrama_owner',
        '-e', 'POSTGRES_PASSWORD=hosted-local-owner', 'postgres:16-bookworm'
    )
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker exec "$prefix-db" pg_isready -U astrama_owner -d astrama *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (!$ready) { throw 'Disposable hosted database did not become ready' }
    foreach ($command in @('db:bootstrap', 'db:migrate')) {
        Invoke-Docker -DockerArguments (@('run', '--rm', '--network', $network) + $environment + @($apiImage, 'pnpm', '--filter', '@astrama/api', $command))
    }
    Start-TestContainer -Name "$prefix-mail" -DockerArguments @('axllent/mailpit@sha256:aef2aacc11f075ec0fb6874275ee4a421e688e11a96ebb296134d1735c7761ce')
    Start-TestContainer -Name "$prefix-storage" -DockerArguments @(
        '-e', 'RUSTFS_ACCESS_KEY=hosted-local', '-e', 'RUSTFS_SECRET_KEY=hosted-local-storage-password',
        '-e', 'RUSTFS_CONSOLE_ENABLE=false',
        'rustfs/rustfs@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2', '/data'
    )
    Invoke-Docker -DockerArguments (@('run', '--rm', '--network', $network) + $environment + @($apiImage, 'node', 'apps/api/dist/storage-init.js'))
    Start-TestContainer -Name "$prefix-api" -DockerArguments (@('--network-alias', 'api') + $environment + @($apiImage))
    Start-TestContainer -Name "$prefix-worker" -DockerArguments ($environment + @($apiImage, 'node', 'apps/api/dist/notification-worker.js'))
    Start-TestContainer -Name "$prefix-lifecycle" -DockerArguments ($environment + @($apiImage, 'node', 'apps/api/dist/tenant-lifecycle-worker.js'))
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & docker exec "$prefix-api" node -e "fetch('http://localhost:4311/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (!$ready) { throw 'Hosted API did not become ready' }
    $caddy = Join-Path $repository 'infra/Caddyfile.e2e-hosted'
    Start-TestContainer -Name "$prefix-web" -DockerArguments @('--mount', "type=bind,source=$caddy,target=/etc/caddy/Caddyfile,readonly", $webImage)
    $webAddress = (& docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$prefix-web").Trim()
    $browser = "$prefix-browser"
    $containers.Add($browser)
    Write-Host "Hosted journey: $prefix ($slug); browser selection: $Project"
    $testFiles = @()
    if ($Journey -in @('onboarding', 'all')) { $testFiles += 'e2e/hosted-onboarding.spec.ts' }
    
    $browserCommand = @($browserImage, 'pnpm', 'exec', 'playwright', 'test') + $testFiles
    if ($Project -ne 'all') { $browserCommand += @('--project', $Project) }
    Invoke-Docker -DockerArguments (@(
        'run', '--name', $browser, '--network', $network,
        '--add-host', "astrama.test:$webAddress", '--add-host', "$slug.astrama.test:$webAddress",
        '--add-host', "ops.astrama.test:$webAddress",
        '--mount', "type=bind,source=$TestSource,target=/app/e2e,readonly",
        '-e', 'BROWSER_MATRIX=1', '-e', "HOSTED_E2E_SLUG=$slug", '-e', "OPERATOR_E2E_SLUG=$slug"
    ) + $environment + $browserCommand)
} catch {
    $failure = $_
    $ErrorActionPreference = 'Continue'
    Write-Host "Hosted journey failed: $($failure.Exception.Message)"
    foreach ($service in @('api', 'worker', 'lifecycle', 'web')) {
        & docker inspect "$prefix-$service" *> $null
        if ($LASTEXITCODE -eq 0) { & docker logs --tail 30 "$prefix-$service" 2>&1 | Write-Host }
    }
    $artifacts = Join-Path $repository "test-results/$prefix"
    New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
    & docker cp "$prefix-browser`:/app/test-results/." $artifacts 2>&1 | Write-Host
    throw $failure
} finally {
    $ErrorActionPreference = 'Continue'
    if ($KeepStack) {
        Write-Host "Retained test containers under $prefix on $network"
    } else {
        foreach ($container in $containers) { & docker rm -f -v $container 2>&1 | Out-Null }
        if ($networkCreated) { & docker network rm $network 2>&1 | Out-Null }
    }
}
