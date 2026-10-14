# Uses installed PostgreSQL binaries only; never installs a Windows service.
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$runId = [Guid]::NewGuid().ToString('N')
$clusterRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot "attendance-postgres-$runId"))
if (-not $clusterRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Disposable cluster path escaped temporary directory.'
}
$dataPath = Join-Path $clusterRoot 'data'
$databaseName = "attendance_ephemeral_$runId"
$marker = [Guid]::NewGuid().ToString()
$initdbBin = (Get-Command initdb -ErrorAction Stop).Source
$pgCtlBin = (Get-Command pg_ctl -ErrorAction Stop).Source
$psqlBin = (Get-Command psql -ErrorAction Stop).Source
$testExit = 1
$started = $false
$cleanupAllowed = $true
$oldUrl = $env:ATTENDANCE_TEST_POSTGRES_URL
$oldMarker = $env:ATTENDANCE_TEST_POSTGRES_MARKER
$oldData = $env:ATTENDANCE_TEST_POSTGRES_DATA_DIRECTORY
New-Item -ItemType Directory -Path $clusterRoot | Out-Null
Set-Content -LiteralPath (Join-Path $clusterRoot 'disposable-marker') -Value $runId

function Invoke-PgHelper([string]$binary, [string]$arguments, [string]$name) {
  $stdoutPath = Join-Path $clusterRoot "$name.stdout.log"
  $stderrPath = Join-Path $clusterRoot "$name.stderr.log"
  $helper = Start-Process -FilePath $binary -ArgumentList $arguments -WindowStyle Hidden `
    -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  # Start-Process -Wait also waits for descendants on Windows: pg_ctl starts a
  # server which must remain alive. Wait only for the direct helper process.
  $null = $helper.Handle # Retain the process handle so Windows PowerShell reports ExitCode.
  if (-not $helper.WaitForExit(60000)) {
    # A descendant may still write/start. Preserve the directory until termination
    # is established; never race cleanup against a timed-out helper.
    $script:cleanupAllowed = $false
    throw "$name exceeded 60 seconds. Helper PID=$($helper.Id); cluster retained at $clusterRoot."
  }
  if ($helper.ExitCode -ne 0) {
    $script:cleanupAllowed = $false
    Get-Content -LiteralPath $stdoutPath,$stderrPath
    throw "$name failed with exit $($helper.ExitCode)."
  }
}

try {
  # Reserve a free loopback port; a race is handled by pg_ctl refusing to start.
  $portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $portProbe.Start()
  $testPort = $portProbe.LocalEndpoint.Port
  $portProbe.Stop()
  Invoke-PgHelper $initdbBin "-D `"$dataPath`" --no-sync --encoding=UTF8 --locale=C --auth=trust --username=attendance_ephemeral" 'initdb'
  Invoke-PgHelper $pgCtlBin "-D `"$dataPath`" -l `"$(Join-Path $clusterRoot 'postgres.log')`" -o `"-h 127.0.0.1 -p $testPort`" -w start" 'start'
  $started = $true
  & $psqlBin -h 127.0.0.1 -p $testPort -U attendance_ephemeral -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $databaseName"
  if ($LASTEXITCODE -ne 0) { throw 'Disposable database creation failed.' }
  & $psqlBin -h 127.0.0.1 -p $testPort -U attendance_ephemeral -d $databaseName -v ON_ERROR_STOP=1 -c "CREATE TABLE public.attendance_test_sandbox_v1 (marker uuid PRIMARY KEY); INSERT INTO public.attendance_test_sandbox_v1 VALUES ('$marker');"
  if ($LASTEXITCODE -ne 0) { throw 'Disposable database marker failed.' }
  $env:ATTENDANCE_TEST_POSTGRES_URL = "postgresql://attendance_ephemeral@127.0.0.1:$testPort/$databaseName"
  $env:ATTENDANCE_TEST_POSTGRES_MARKER = $marker
  $env:ATTENDANCE_TEST_POSTGRES_DATA_DIRECTORY = $dataPath
  Push-Location $repoRoot
  try {
    & npx vitest run tests/attendance/native-contention-v1.integration.test.ts
    $testExit = $LASTEXITCODE
  } finally { Pop-Location }
} finally {
  $env:ATTENDANCE_TEST_POSTGRES_URL = $oldUrl
  $env:ATTENDANCE_TEST_POSTGRES_MARKER = $oldMarker
  $env:ATTENDANCE_TEST_POSTGRES_DATA_DIRECTORY = $oldData
  if (-not $cleanupAllowed) {
    Write-Warning "Cluster retained after helper failure; no recursive cleanup attempted: $clusterRoot"
  } else {
    if ($started -or (Test-Path -LiteralPath (Join-Path $dataPath 'postmaster.pid'))) {
      Invoke-PgHelper $pgCtlBin "-D `"$dataPath`" -m immediate -w stop" 'stop'
    }
    # Delete only our validated, uniquely marked cluster after PostgreSQL stopped.
    $resolvedCluster = [IO.Path]::GetFullPath($clusterRoot)
    if (-not $resolvedCluster.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        ((Get-Item -LiteralPath $resolvedCluster).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        (Get-Content -LiteralPath (Join-Path $resolvedCluster 'disposable-marker') -Raw).Trim() -ne $runId -or
        (Test-Path -LiteralPath (Join-Path $dataPath 'postmaster.pid'))) {
      throw 'Refusing to remove an unverified or still-running cluster.'
    }
    Remove-Item -LiteralPath $resolvedCluster -Recurse -Force
    Write-Output "Disposable PostgreSQL stopped and removed. TestExit=$testExit"
  }
}
exit $testExit
