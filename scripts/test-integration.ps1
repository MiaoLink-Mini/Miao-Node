param([int]$Port=18080,[switch]$FrontendOnly,[int]$DatabasePort=55432)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backend=[IO.Path]::GetFullPath((Join-Path $root '..\WeAgent-Backend'))
$runtime=Join-Path $root '.runtime'
$pgbin=$env:POSTGRES_BIN
if (!$pgbin) {
  $pgbin=Join-Path $env:LOCALAPPDATA 'GoLink\postgres-18.3\pgsql\bin'
  if (!(Test-Path -LiteralPath (Join-Path $pgbin 'psql.exe'))) { $pgbin=Join-Path $env:LOCALAPPDATA 'WeAgent\postgres-18.3\pgsql\bin' }
}
$db='weagent_plugin_test_'+[Guid]::NewGuid().ToString('N')
$gateway=$null; $created=$false; $startedDB=$false; $private=$null
$envNames=@('DATABASE_URL','TEST_DATABASE_URL','GATEWAY_HMAC_KEY','AUTH_MODE','LISTEN_ADDR','PGPASSWORD','WEAGENT_TEST_GATEWAY','COMMAND_TTL','POSTGRES_BIN')
$saved=@{}; foreach($name in $envNames){$saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
Push-Location $root
try {
  foreach($tool in @('psql.exe','pg_ctl.exe')) { if (!(Test-Path -LiteralPath (Join-Path $pgbin $tool))) { throw 'Set POSTGRES_BIN to the native PostgreSQL bin directory before running integration tests' } }
  # Both the fixture lifecycle and SQL client must use the same installation.
  $env:POSTGRES_BIN=$pgbin
  if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'Gateway fixture port is occupied; choose another -Port' }
  $running=Get-NetTCPConnection -State Listen -LocalPort $DatabasePort -ErrorAction SilentlyContinue
  & (Join-Path $backend 'scripts\dev-db.ps1') start -Port $DatabasePort
  if (!$running) { $startedDB=$true }
  $private=Get-Content -LiteralPath (Join-Path $backend '.runtime\database.json') -Raw | ConvertFrom-Json
  $uri=[Uri]$private.adminUrl
  $env:PGPASSWORD=[Uri]::UnescapeDataString($uri.UserInfo.Split(':',2)[1])
  & (Join-Path $pgbin 'psql.exe') -h 127.0.0.1 -p $private.port -U weagent -d postgres -v ON_ERROR_STOP=1 -c ('CREATE DATABASE '+$db) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Isolated fixture database creation failed' }; $created=$true
  $env:DATABASE_URL=$private.adminUrl.Replace('/postgres?',('/'+$db+'?'))
  $bytes=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $env:GATEWAY_HMAC_KEY=[Convert]::ToBase64String($bytes)
  $env:AUTH_MODE='development'; $env:LISTEN_ADDR='127.0.0.1:'+$Port; $env:COMMAND_TTL='15s'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  Push-Location $backend
  try {
    $env:TEST_DATABASE_URL=$private.adminUrl
    go test -count=1 -timeout 180s ./...
    if ($LASTEXITCODE -ne 0) { throw 'Gateway Go regression tests failed' }
    go build -trimpath -o (Join-Path $runtime 'gateway-fixture.exe') ./cmd/gateway
    if ($LASTEXITCODE -ne 0) { throw 'Gateway build failed' }
    go build -trimpath -o (Join-Path $runtime 'migrate-fixture.exe') ./cmd/migrate
    if ($LASTEXITCODE -ne 0) { throw 'Migration build failed' }
  } finally { Pop-Location }
  & (Join-Path $runtime 'migrate-fixture.exe') up
  if ($LASTEXITCODE -ne 0) { throw 'Fixture migration failed' }
  $gateway=Start-Process -FilePath (Join-Path $runtime 'gateway-fixture.exe') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'integration-gateway.stdout.log') -RedirectStandardError (Join-Path $runtime 'integration-gateway.stderr.log')
  $env:WEAGENT_TEST_GATEWAY='http://127.0.0.1:'+$Port
  $ready=$false
  for($i=0;$i -lt 60;$i++) {
    try { $health=Invoke-RestMethod -Uri ($env:WEAGENT_TEST_GATEWAY+'/readyz'); if($health.status -eq 'ok'){$ready=$true;break} } catch {}
    if($gateway.HasExited){throw 'Gateway fixture exited'}; Start-Sleep -Milliseconds 100
  }
  if(!$ready){throw 'Gateway readiness timeout'}
  if($FrontendOnly){node (Join-Path $root '..\WeAgent-Frontend\scripts\integration-live.mjs')}
  else {node scripts/integration.mjs}
  if($LASTEXITCODE -ne 0){throw 'Plugin integration failed'}
} finally {
  if($gateway -and !$gateway.HasExited){Stop-Process -Id $gateway.Id -ErrorAction SilentlyContinue; $gateway.WaitForExit()}
  if($created){
    if($db -notmatch '^weagent_plugin_test_[a-f0-9]{32}$'){throw 'Unsafe fixture cleanup target'}
    & (Join-Path $pgbin 'psql.exe') -h 127.0.0.1 -p $private.port -U weagent -d postgres -v ON_ERROR_STOP=1 -c ('DROP DATABASE '+$db+' WITH (FORCE)') | Out-Null
    if($LASTEXITCODE -ne 0){Write-Error 'Disposable fixture database cleanup failed'}
  }
  if($startedDB){& (Join-Path $backend 'scripts\dev-db.ps1') stop}
  foreach($name in $envNames){[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')}
  Pop-Location
}
