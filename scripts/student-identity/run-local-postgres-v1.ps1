[CmdletBinding()]
param(
    [ValidateSet('Start', 'Status', 'Stop')]
    [string]$Action = 'Start',
    [ValidateRange(1024, 65535)]
    [int]$Port = 55439,
    [string]$ClusterDirectory = (Join-Path $env:USERPROFILE '.codex/tmp/reconciliation1269-postgres'),
    [string]$PostgresBin = ''
)

$ErrorActionPreference = 'Stop'
$clusterRoot = [IO.Path]::GetFullPath($ClusterDirectory)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex/tmp'))
if (-not $clusterRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($clusterRoot) -notmatch '^reconciliation1269-postgres(?:-[a-z0-9-]+)?$') {
    throw 'The disposable cluster must be a reconciliation1269-postgres directory below the current user .codex/tmp.'
}
$dataDirectory = Join-Path $clusterRoot 'data'
$markerPath = Join-Path $clusterRoot 'disposable-cluster.json'
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

if (-not $PostgresBin) {
    $PostgresBin = Split-Path (Get-Command initdb.exe -ErrorAction Stop).Source
}
$initdb = Join-Path $PostgresBin 'initdb.exe'
$pgctl = Join-Path $PostgresBin 'pg_ctl.exe'
$psql = Join-Path $PostgresBin 'psql.exe'
foreach ($binary in @($initdb, $pgctl, $psql)) {
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'PostgreSQL binaries are unavailable.' }
}

if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($marker.purpose -ne 'student-reconciliation-1269-synthetic-only' -or
        $marker.ownerSid -ne $ownerSid -or $marker.path -ne $clusterRoot -or $marker.port -ne $Port) {
        throw 'Existing cluster ownership, purpose, path or port does not match this test launcher.'
    }
} elseif ($Action -ne 'Start') {
    throw 'No marked disposable cluster exists at the requested path.'
} else {
    if ((Test-Path -LiteralPath $clusterRoot) -and
        @(Get-ChildItem -LiteralPath $clusterRoot -Force).Count -gt 0) {
        throw 'Refusing to use a nonempty directory without this launcher marker.'
    }
    New-Item -ItemType Directory -Path $clusterRoot -Force | Out-Null
    @{
        purpose = 'student-reconciliation-1269-synthetic-only'
        ownerSid = $ownerSid
        path = $clusterRoot
        port = $Port
    } | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding utf8
}

if (-not (Test-Path -LiteralPath (Join-Path $dataDirectory 'PG_VERSION'))) {
    if ($Action -ne 'Start') { throw 'The disposable cluster has not been initialized.' }
    & $initdb -D $dataDirectory -U portal_test_admin --auth-local=trust --auth-host=trust --encoding=UTF8 --no-locale
    if ($LASTEXITCODE -ne 0) { throw 'Local initdb failed.' }
}

$null = & $pgctl -D $dataDirectory status 2>&1
$running = $LASTEXITCODE -eq 0
if ($Action -eq 'Stop') {
    if ($running) {
        & $pgctl -D $dataDirectory -m fast -w -t 30 stop
        if ($LASTEXITCODE -ne 0) { throw 'Stopping the disposable cluster failed.' }
    }
    Write-Output 'Disposable PostgreSQL is stopped. Files were preserved.'
    return
}
if ($Action -eq 'Status' -and -not $running) {
    Write-Output 'Disposable PostgreSQL is stopped.'
    return
}
if (-not $running) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() } finally { $listener.Stop() }
    & $pgctl -D $dataDirectory -l (Join-Path $clusterRoot 'postgres.log') -o "-h 127.0.0.1 -p $Port" -w -t 30 start
    if ($LASTEXITCODE -ne 0) { throw 'Starting the disposable cluster failed.' }
}

function Invoke-LocalSql([string]$Database, [string]$Sql) {
    if ($Database -notin @('postgres', 'portal705_test', 'gradebook_recovery_ci')) {
        throw 'The database name is outside the disposable allowlist.'
    }
    $result = & $psql -X --no-password -h 127.0.0.1 -p $Port -U portal_test_admin -d $Database -v ON_ERROR_STOP=1 -At -c $Sql
    if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL command failed.' }
    return $result
}

$serverData = Invoke-LocalSql postgres 'SHOW data_directory'
$serverListen = Invoke-LocalSql postgres 'SHOW listen_addresses'
if ([IO.Path]::GetFullPath([string]$serverData) -ne [IO.Path]::GetFullPath($dataDirectory) -or $serverListen -ne '127.0.0.1') {
    throw 'Connected server is not the expected loopback disposable cluster.'
}
if ($Action -eq 'Start') {
    $roleExists = Invoke-LocalSql postgres "SELECT 1 FROM pg_roles WHERE rolname='gradebook_test_admin'"
    if ($roleExists -ne '1') {
        Invoke-LocalSql postgres 'CREATE ROLE gradebook_test_admin LOGIN SUPERUSER' | Out-Null
    }
    foreach ($database in @('portal705_test', 'gradebook_recovery_ci')) {
        $exists = Invoke-LocalSql postgres "SELECT 1 FROM pg_database WHERE datname='$database'"
        if ($exists -ne '1') {
            $databaseOwner = if ($database -eq 'portal705_test') { 'portal_test_admin' } else { 'gradebook_test_admin' }
            Invoke-LocalSql postgres "CREATE DATABASE $database OWNER $databaseOwner" | Out-Null
        }
    }
}

$env:PORTAL_TEST_DATABASE_URL = "postgres://portal_test_admin@127.0.0.1:$Port/portal705_test"
$env:GRADEBOOK_RECOVERY_DATABASE_URL = "postgres://gradebook_test_admin@127.0.0.1:$Port/gradebook_recovery_ci"
Write-Output "PORTAL_TEST_DATABASE_URL=$env:PORTAL_TEST_DATABASE_URL"
Write-Output "GRADEBOOK_RECOVERY_DATABASE_URL=$env:GRADEBOOK_RECOVERY_DATABASE_URL"
Write-Output 'Synthetic local databases are ready. Existing databases are never reset by this launcher.'
