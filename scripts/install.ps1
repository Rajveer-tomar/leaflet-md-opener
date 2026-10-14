<#
.SYNOPSIS
  Adds Leaflet to the "Open with" menu for .md and .markdown files.

.DESCRIPTION
  Registers Leaflet for the current Windows user only (HKCU), so it needs no
  administrator rights and touches nothing system-wide.

  Windows deliberately does not let any program make itself the default app.
  With -ShowPicker, this script opens Windows' own "How do you want to open
  this file?" dialog afterwards, so the last step is one click: pick Leaflet
  and tick "Always".

  Run scripts\uninstall.ps1 to remove it again. Supports -WhatIf.

.PARAMETER Window
  How files open: fullscreen (default), maximized, or tab.

.PARAMETER ShowPicker
  Open the Windows app picker on a sample file once registration is done.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -ShowPicker
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Window maximized
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('fullscreen', 'maximized', 'tab')]
  [string]$Window = 'fullscreen',

  [switch]$ShowPicker
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $root 'src\Leaflet.ps1'
$sample = Join-Path $root 'examples\welcome.md'
if (-not (Test-Path -LiteralPath $script)) { throw "Cannot find $script - run this from inside the Leaflet folder." }

$progId = 'Leaflet.Markdown'
$classes = 'HKCU:\Software\Classes'
$command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Path "%1" -Window {1}' -f $script, $Window

function Set-Default([string]$Key, [string]$Value) {
  if (-not (Test-Path -LiteralPath $Key)) { New-Item -Path $Key -Force | Out-Null }
  Set-Item -LiteralPath $Key -Value $Value
}

Set-Default "$classes\$progId" 'Markdown document'
New-ItemProperty -LiteralPath "$classes\$progId" -Name 'FriendlyTypeName' -Value 'Markdown document' -Force | Out-Null
Set-Default "$classes\$progId\shell\open" 'Open with Leaflet'
New-ItemProperty -LiteralPath "$classes\$progId\shell\open" -Name 'FriendlyAppName' -Value 'Leaflet' -Force | Out-Null
Set-Default "$classes\$progId\shell\open\command" $command

foreach ($ext in '.md', '.markdown') {
  $key = "$classes\$ext\OpenWithProgids"
  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -LiteralPath $key -Name $progId -Value '' -PropertyType String -Force | Out-Null
}

if ($WhatIfPreference) { return }

# Tell Explorer the associations changed so the menu updates without a sign-out.
Add-Type -Namespace Leaflet -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, System.IntPtr a, System.IntPtr b);'
[Leaflet.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host ''
Write-Host 'Leaflet is registered for .md and .markdown files.' -ForegroundColor Green

if ($ShowPicker -and (Test-Path -LiteralPath $sample)) {
  Write-Host 'Windows is asking which app to use: choose "Leaflet", tick "Always", then OK.'
  Start-Process -FilePath 'rundll32.exe' -ArgumentList 'shell32.dll,OpenAs_RunDLL', "`"$sample`""
} else {
  Write-Host 'Last step: right-click any .md file -> Open with -> Choose another app ->'
  Write-Host '"Leaflet", tick "Always use this app", then OK.'
}
