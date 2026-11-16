$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot

$lockPath = Join-Path $PSScriptRoot 'data\zajil.lock'

if (Test-Path -LiteralPath $lockPath) {
  $pidText = Get-Content -LiteralPath $lockPath -ErrorAction SilentlyContinue | Select-Object -First 1

  if ($pidText -match '^\d+$') {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidText" -ErrorAction SilentlyContinue

    if ($process -and $process.CommandLine -like '*src/index.js*') {
      Write-Host "Zajil is already running. Restarting it..."
      Stop-Process -Id ([int]$pidText) -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js was not found. Install Node.js or add it to PATH."
  exit 1
}

& $node.Source 'src/index.js'
