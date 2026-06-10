# Deploy wBLOZ + BlozBridge on BSC, then sync to VPS.
# Requires BSC_DEPLOYER_PRIVATE_KEY in .env

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) {
  Write-Error "Missing .env - copy .env.example first"
}

$raw = Get-Content $envFile -Raw
if ($raw -notmatch 'BSC_DEPLOYER_PRIVATE_KEY=0x[0-9a-fA-F]{64}') {
  Write-Host ""
  Write-Host "BLOCKER: BSC private key missing in $envFile" -ForegroundColor Red
  Write-Host "MetaMask: Account 0x05099631... -> Account details -> Show private key"
  Write-Host "Paste into .env:"
  Write-Host "  BSC_DEPLOYER_PRIVATE_KEY=0x..."
  Write-Host "  BSC_OPERATOR_PRIVATE_KEY=0x..."
  Write-Host "Then re-run: .\deploy\deploy-and-sync.ps1"
  exit 1
}

Write-Host "=== Deploy contracts on BSC ===" -ForegroundColor Cyan
npm run deploy:bsc
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$dep = Get-Content (Join-Path $Root "deployments.json") | ConvertFrom-Json
Write-Host "WBLOZ: $($dep.wBLOZ)"
Write-Host "Bridge: $($dep.bridge)"

$lines = Get-Content $envFile
$lines = $lines -replace '^WBLOZ_ADDRESS=.*', "WBLOZ_ADDRESS=$($dep.wBLOZ)"
$lines = $lines -replace '^BRIDGE_ADDRESS=.*', "BRIDGE_ADDRESS=$($dep.bridge)"
$lines | Set-Content $envFile

Write-Host "=== Sync to VPS ===" -ForegroundColor Cyan
$staging = Join-Path $env:TEMP "blockzero-bridge-sync"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
robocopy $Root $staging /E /XD node_modules relayer\node_modules cache artifacts typechain-types .git data /NFL /NDL /NJH /NJS | Out-Null
Copy-Item $envFile (Join-Path $staging ".env") -Force
tar -czf "$env:TEMP\bz-bridge.tgz" -C $staging .

$sshKey = Join-Path $env:USERPROFILE ".ssh\id_ed25519"
scp -i $sshKey -o BatchMode=yes "$env:TEMP\bz-bridge.tgz" root@217.160.46.61:/tmp/bz-bridge.tgz
ssh -i $sshKey -o BatchMode=yes root@217.160.46.61 @'
mkdir -p /opt/blockzero-bridge
tar -xzf /tmp/bz-bridge.tgz -C /opt/blockzero-bridge
sed -i 's/\r//g' /opt/blockzero-bridge/deploy/vps-setup.sh
bash /opt/blockzero-bridge/deploy/vps-setup.sh
'@

Write-Host ""
Write-Host "Done. Open https://bridge.bloz.org/api/status" -ForegroundColor Green
