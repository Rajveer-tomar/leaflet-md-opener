<#
.SYNOPSIS
  Removes what scripts\install.ps1 added. Your markdown files are not touched.

.PARAMETER RemoveData
  Also delete Leaflet's saved settings and its browser profile.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$RemoveData)

$ErrorActionPreference = 'Stop'
$progId = 'Leaflet.Markdown'
$classes = 'HKCU:\Software\Classes'

if (Test-Path -LiteralPath "$classes\$progId") { Remove-Item -LiteralPath "$classes\$progId" -Recurse }
foreach ($ext in '.md', '.markdown') {
  $key = "$classes\$ext\OpenWithProgids"
  if (Test-Path -LiteralPath $key) {
    Remove-ItemProperty -LiteralPath $key -Name $progId -ErrorAction SilentlyContinue
  }
}

if ($RemoveData) {
  foreach ($dir in (Join-Path $env:APPDATA 'Leaflet'), (Join-Path $env:LOCALAPPDATA 'Leaflet')) {
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
  }
}

Write-Host 'Leaflet has been removed from the Open with menu.' -ForegroundColor Green
Write-Host 'If .md files still open with it, pick another app once via Open with -> Choose another app.'
