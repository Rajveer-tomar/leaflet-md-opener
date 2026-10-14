<#
.SYNOPSIS
  Opens a markdown file in Leaflet: a local preview + editor in your browser.

.DESCRIPTION
  Starts a tiny web server bound to localhost only, serving the Leaflet app and
  the markdown files in the opened file's folder, then opens a browser window.
  The server is what lets the editor save back to the original file on disk.

  It shuts itself down when the browser window is closed, or after
  -IdleMinutes with no activity.

  NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads it as ANSI).

.PARAMETER Path
  The .md file to open. A folder also works: its first markdown file opens.

.PARAMETER Window
  fullscreen (default) - Edge/Chrome app window in full screen (F11 to leave)
  maximized            - Edge/Chrome app window, maximized
  tab                  - a normal tab in your default browser

.PARAMETER NoBrowser
  Start the server and print its URL without opening a browser.

.EXAMPLE
  .\Leaflet.ps1 -Path C:\notes\todo.md
.EXAMPLE
  .\Leaflet.ps1 -Path C:\notes\todo.md -Window tab
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path,

  [ValidateSet('fullscreen', 'maximized', 'tab')]
  [string]$Window = 'fullscreen',

  [switch]$NoBrowser,

  [ValidateRange(0, 65535)]
  [int]$Port = 0,

  [ValidateRange(1, 1440)]
  [int]$IdleMinutes = 30
)

$ErrorActionPreference = 'Stop'
$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $srcDir 'Leaflet.Helpers.ps1')

$webDir = Join-Path $srcDir 'web'
$appDataDir = Join-Path $env:APPDATA 'Leaflet'
$settingsPath = Join-Path $appDataDir 'settings.json'
$logPath = Join-Path $env:TEMP 'leaflet.log'
$maxBodyBytes = 20MB
$maxSettingsBytes = 16KB
$closeGraceSeconds = 20

function Write-Log([string]$Message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}' -f (Get-Date), $PID, $Message
  try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch { }
}

function Show-FatalError([string]$Message) {
  Write-Log "FATAL: $Message"
  if ($NoBrowser) { Write-Error $Message; return }
  # Leaflet usually runs with a hidden console, so surface the error as a dialog.
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($Message, 'Leaflet', 'OK', 'Error') | Out-Null
}

# ---------------------------------------------------------------- resolve input

if (-not (Test-Path -LiteralPath $Path)) {
  Show-FatalError "File not found:`n$Path"
  exit 1
}
$resolved = (Resolve-Path -LiteralPath $Path).ProviderPath
if (Test-Path -LiteralPath $resolved -PathType Container) {
  $folder = $resolved
  $first = Get-MarkdownFiles -Folder $folder | Select-Object -First 1
  if ($null -eq $first) {
    Show-FatalError "No markdown files in:`n$folder"
    exit 1
  }
  $initialFile = $first.name
} else {
  $folder = Split-Path -Parent $resolved
  $initialFile = Split-Path -Leaf $resolved
}
$folderName = Split-Path -Leaf $folder

# ---------------------------------------------------------------- start server

function New-Token {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-FreePort {
  $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $probe.Start()
  $free = $probe.LocalEndpoint.Port
  $probe.Stop()
  return $free
}

# The token is part of every URL. Another web page in your browser cannot guess
# it, so it cannot read or overwrite your files through this server.
$token = New-Token
if ($Port -eq 0) { $Port = Get-FreePort }
$listener = New-Object System.Net.HttpListener
# "localhost" (not 127.0.0.1 or +) is the one prefix Windows lets a normal,
# non-admin user bind. It is never reachable from another machine.
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Show-FatalError "Could not start Leaflet on port ${Port}:`n$($_.Exception.Message)"
  exit 1
}

$baseUrl = "http://localhost:$Port/$token/"
$fileUrl = $baseUrl + '#' + [System.Uri]::EscapeDataString($initialFile)
Write-Log "Serving '$folder' at http://localhost:$Port/ (initial: $initialFile)"

# ---------------------------------------------------------------- responses

function Send-Bytes($Response, [int]$Status, [byte[]]$Bytes, [string]$ContentType) {
  $Response.StatusCode = $Status
  $Response.ContentType = $ContentType
  $Response.Headers['X-Content-Type-Options'] = 'nosniff'
  $Response.Headers['Referrer-Policy'] = 'no-referrer'
  $Response.Headers['Cache-Control'] = 'no-store'
  $Response.ContentLength64 = $Bytes.Length
  if ($Bytes.Length -gt 0) { $Response.OutputStream.Write($Bytes, 0, $Bytes.Length) }
}

function Send-Json($Response, [int]$Status, $Body) {
  $json = ConvertTo-Json -InputObject $Body -Depth 6 -Compress
  Send-Bytes $Response $Status ($script:Utf8NoBom.GetBytes($json)) 'application/json; charset=utf-8'
}

function Send-Error($Response, [int]$Status, [string]$Message) {
  Send-Json $Response $Status @{ error = $Message }
}

function Send-File($Response, [string]$FullPath, [switch]$IsAppPage) {
  if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
    Send-Error $Response 404 'Not found'
    return
  }
  if ($IsAppPage) {
    # Markdown can contain raw HTML. The renderer sanitises it, and this policy
    # is the second wall: no inline or remote script can run in the app page.
    $Response.Headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src *; font-src 'self' data:; " +
      "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'"
  } else {
    # Anything else opened directly as a page runs sandboxed: no script, and an
    # opaque origin, so it could not reach the save API even if it had script.
    $Response.Headers['Content-Security-Policy'] = 'sandbox'
  }
  Send-Bytes $Response 200 ([System.IO.File]::ReadAllBytes($FullPath)) (Get-ContentType $FullPath)
}

function Read-Body($Request) {
  if ($Request.ContentLength64 -gt $maxBodyBytes) { throw 'Request too large' }
  $reader = New-Object System.IO.StreamReader($Request.InputStream, $script:Utf8NoBom)
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

# ---------------------------------------------------------------- API handlers

function Get-SessionInfo {
  return @{
    folderName  = $folderName
    folderPath  = $folder
    initialFile = $initialFile
    files       = @(Get-MarkdownFiles -Folder $folder)
  }
}

function Get-DocumentPath([string]$Name) {
  if (-not (Test-MarkdownName $Name)) { return $null }
  return Get-SafeChildPath -Root $folder -Relative $Name
}

function Invoke-ReadDocument($Context, [string]$Name) {
  $docPath = Get-DocumentPath $Name
  if ($null -eq $docPath) { Send-Error $Context.Response 400 'Invalid file name'; return }
  if (-not (Test-Path -LiteralPath $docPath -PathType Leaf)) { Send-Error $Context.Response 404 'File not found'; return }

  $doc = Read-TextDocument -Path $docPath
  Send-Json $Context.Response 200 @{
    name  = $Name
    text  = (ConvertTo-LineEnding -Text $doc.Text)
    readOnly = -not $doc.IsUtf8
    mtime = [string](Get-Item -LiteralPath $docPath).LastWriteTimeUtc.Ticks
  }
}

function Invoke-WriteDocument($Context, [string]$Name) {
  $docPath = Get-DocumentPath $Name
  if ($null -eq $docPath) { Send-Error $Context.Response 400 'Use a plain file name ending in .md'; return }

  $payload = (Read-Body $Context.Request) | ConvertFrom-Json
  if ($null -eq $payload -or $null -eq $payload.text) { Send-Error $Context.Response 400 'Missing text'; return }

  $exists = Test-Path -LiteralPath $docPath -PathType Leaf
  $isCreate = [bool]$payload.create
  if ($isCreate -and $exists) { Send-Error $Context.Response 409 'A file with that name already exists'; return }
  if (-not $isCreate -and -not $exists) { Send-Error $Context.Response 404 'File no longer exists on disk'; return }

  # Refuse to overwrite a file that changed on disk since the editor loaded it,
  # unless the user explicitly chose "Overwrite".
  if ($exists -and -not [bool]$payload.force) {
    $current = [string](Get-Item -LiteralPath $docPath).LastWriteTimeUtc.Ticks
    if ($current -ne [string]$payload.baseMtime) {
      Send-Json $Context.Response 409 @{ error = 'changed-on-disk'; mtime = $current }
      return
    }
  }

  try {
    Write-TextDocument -Path $docPath -Text ([string]$payload.text)
  } catch {
    if ($_.Exception.Message -eq 'not-utf8') {
      Send-Error $Context.Response 415 'This file is not UTF-8 text, so Leaflet will not overwrite it.'
      return
    }
    Write-Log "Save of $Name failed: $($_.Exception.Message)"
    Send-Error $Context.Response 500 "Could not write the file: $($_.Exception.Message)"
    return
  }
  Write-Log "Saved $Name"
  Send-Json $Context.Response 200 @{ name = $Name; mtime = [string](Get-Item -LiteralPath $docPath).LastWriteTimeUtc.Ticks }
}

function Invoke-Settings($Context) {
  if ($Context.Request.HttpMethod -eq 'GET') {
    $json = '{}'
    if (Test-Path -LiteralPath $settingsPath) { $json = [System.IO.File]::ReadAllText($settingsPath) }
    Send-Bytes $Context.Response 200 ($script:Utf8NoBom.GetBytes($json)) 'application/json; charset=utf-8'
    return
  }
  $body = Read-Body $Context.Request
  if ($body.Length -gt $maxSettingsBytes) { Send-Error $Context.Response 413 'Settings too large'; return }
  $null = $body | ConvertFrom-Json   # reject anything that is not valid JSON
  if (-not (Test-Path -LiteralPath $appDataDir)) { New-Item -ItemType Directory -Path $appDataDir | Out-Null }
  [System.IO.File]::WriteAllText($settingsPath, $body, $script:Utf8NoBom)
  Send-Json $Context.Response 200 @{ ok = $true }
}

function Invoke-Api($Context, [string]$Route) {
  $request = $Context.Request
  $method = $request.HttpMethod
  $name = Get-QueryValue -Query $request.Url.Query -Name 'name'

  # Writes need a custom header. A plain HTML form or <img> on some other site
  # can never send one, which closes off cross-site request forgery.
  if ($method -ne 'GET' -and $request.Headers['X-Leaflet'] -ne '1' -and $Route -ne 'bye') {
    Send-Error $Context.Response 403 'Missing X-Leaflet header'
    return
  }

  switch ("$method $Route") {
    'GET session'  { Send-Json $Context.Response 200 (Get-SessionInfo) }
    'GET files'    { Send-Json $Context.Response 200 @{ files = @(Get-MarkdownFiles -Folder $folder) } }
    'GET file'     { Invoke-ReadDocument $Context $name }
    'PUT file'     { Invoke-WriteDocument $Context $name }
    'GET settings' { Invoke-Settings $Context }
    'PUT settings' { Invoke-Settings $Context }
    'POST bye'     { $script:closeRequestedAt = Get-Date; Send-Json $Context.Response 200 @{ ok = $true } }
    default        { Send-Error $Context.Response 404 'Unknown API route' }
  }
}

function Invoke-Request($Context) {
  $request = $Context.Request
  if (-not (Test-LocalHostHeader -HostHeader $request.Headers['Host'] -Port $Port)) {
    Send-Error $Context.Response 403 'Forbidden host'
    return
  }

  $path = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
  $prefix = "/$token/"
  if ($path -eq "/$token") { $Context.Response.Redirect($prefix); return }
  if (-not $path.StartsWith($prefix)) { Send-Error $Context.Response 404 'Not found'; return }
  $rest = $path.Substring($prefix.Length)

  if ($rest -eq '') { Send-File $Context.Response (Join-Path $webDir 'index.html') -IsAppPage; return }

  if ($rest.StartsWith('__leaflet__/api/')) {
    Invoke-Api $Context $rest.Substring('__leaflet__/api/'.Length)
    return
  }
  if ($rest.StartsWith('__leaflet__/')) {
    $asset = Get-SafeChildPath -Root $webDir -Relative $rest.Substring('__leaflet__/'.Length)
    if ($null -eq $asset) { Send-Error $Context.Response 404 'Not found' } else { Send-File $Context.Response $asset }
    return
  }

  # Anything else is a file next to the markdown, e.g. an image it embeds.
  $local = Get-SafeChildPath -Root $folder -Relative $rest
  if ($null -eq $local -or -not (Test-ServableFile $local)) { Send-Error $Context.Response 404 'Not found'; return }
  Send-File $Context.Response $local
}

# ---------------------------------------------------------------- browser

function Find-ChromiumBrowser {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Open-Browser([string]$Url) {
  $browser = $null
  if ($Window -ne 'tab') { $browser = Find-ChromiumBrowser }
  if ($null -eq $browser) {
    Start-Process $Url
    return
  }
  # --app gives a clean window with no tabs or address bar. Leaflet uses its own
  # browser profile so the window flags apply even while your normal browser is
  # already open (an existing browser process would otherwise ignore them).
  $profileDir = Join-Path $env:LOCALAPPDATA 'Leaflet\browser-profile'
  $windowFlag = '--start-maximized'
  if ($Window -eq 'fullscreen') { $windowFlag = '--start-fullscreen' }
  $arguments = @("--app=$Url", $windowFlag, "--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check')
  Start-Process -FilePath $browser -ArgumentList $arguments
}

if ($NoBrowser) {
  Write-Output $fileUrl
} else {
  Open-Browser $fileUrl
}

# ---------------------------------------------------------------- serve loop

$lastActivity = Get-Date
$lastTick = Get-Date
$script:closeRequestedAt = $null
$pending = $listener.GetContextAsync()
try {
  while ($true) {
    if (-not $pending.Wait(1000)) {
      $now = Get-Date
      # A tick far longer than a second means the PC slept. Don't count sleep
      # as idle time, or waking up would stop the helper before the page could
      # check in - stranding any unsaved edits.
      if (($now - $lastTick).TotalSeconds -gt 10) {
        $lastActivity = $now
        if ($null -ne $script:closeRequestedAt) { $script:closeRequestedAt = $now }
      }
      $lastTick = $now
      # Closing the window sends "bye"; the grace period covers a page reload.
      if ($null -ne $script:closeRequestedAt -and ($now - $script:closeRequestedAt).TotalSeconds -gt $closeGraceSeconds) { break }
      if (($now - $lastActivity).TotalMinutes -gt $IdleMinutes) { break }
      continue
    }
    $lastTick = Get-Date
    $context = $pending.Result
    $pending = $listener.GetContextAsync()
    $lastActivity = Get-Date
    $route = $context.Request.Url.AbsolutePath
    if (-not $route.EndsWith('/api/bye')) { $script:closeRequestedAt = $null }
    try {
      Invoke-Request $context
    } catch {
      Write-Log "Error handling ${route}: $($_.Exception.Message)"
      try { Send-Error $context.Response 500 'Leaflet hit an error. Details are in %TEMP%\leaflet.log' } catch { }
    } finally {
      try { $context.Response.Close() } catch { }
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
  Write-Log 'Stopped'
}
