# Pure helper functions used by Leaflet.ps1. Kept separate so they can be
# unit-tested (see tests/Leaflet.Helpers.Tests.ps1) without starting a server.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a .ps1 without
# a BOM as the system ANSI code page.

$script:MarkdownExtensions = @('.md', '.markdown')
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Utf8Bom = New-Object System.Text.UTF8Encoding($true)
$script:Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)

function Test-MarkdownName {
  <# True when $Name is a plain markdown file name: no folders, no traversal. #>
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
  if ($Name.Length -gt 200) { return $false }
  if ($Name.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0) { return $false }
  if ($Name -match '^\.+$') { return $false }
  # Windows silently strips trailing dots/spaces, which would let "a.md." alias "a.md".
  if ($Name -ne $Name.TrimEnd('.', ' ')) { return $false }
  $ext = [System.IO.Path]::GetExtension($Name).ToLowerInvariant()
  return $script:MarkdownExtensions -contains $ext
}

function Get-SafeChildPath {
  <#
    Resolves $Relative (a URL path, forward slashes) under $Root and returns the
    full path, or $null when the result would escape $Root.
  #>
  param([string]$Root, [string]$Relative)

  if ([string]::IsNullOrEmpty($Relative)) { return $null }
  if ($Relative.Contains([char]0)) { return $null }
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $candidate = $Relative.Replace('/', '\')
  # Reject UNC (\\server\share) and drive-qualified (C:...) paths outright.
  if ($candidate.StartsWith('\\') -or $candidate -match '^\\?[a-zA-Z]:') { return $null }
  $candidate = $candidate.TrimStart('\')

  try {
    $full = [System.IO.Path]::GetFullPath((Join-Path $rootFull $candidate))
  } catch {
    return $null
  }
  if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
  return $full
}

function Read-TextDocument {
  <#
    Reads a text file and reports the BOM and line-ending style it used.
    IsUtf8 is false for anything that is not valid UTF-8 (a Windows-1252 or
    UTF-16 file). Such a file is shown decoded as best we can, but must never be
    saved back: the lossy decode would silently replace its characters.
  #>
  param([string]$Path)

  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $isUtf16 = $bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF))
  $offset = 0
  if ($hasBom) { $offset = 3 }

  $isUtf8 = -not $isUtf16
  try {
    $text = $script:Utf8Strict.GetString($bytes, $offset, $bytes.Length - $offset)
  } catch {
    $isUtf8 = $false
    $text = $script:Utf8NoBom.GetString($bytes, $offset, $bytes.Length - $offset)
  }
  if ($isUtf16) {
    $utf16 = [System.Text.Encoding]::Unicode
    if ($bytes[0] -eq 0xFE) { $utf16 = [System.Text.Encoding]::BigEndianUnicode }
    $text = $utf16.GetString($bytes, 2, $bytes.Length - 2)
  }

  # A file is CRLF when most of its line breaks are; one stray CRLF in an LF
  # file must not turn the whole file into CRLF on save.
  $crlfCount = ([regex]::Matches($text, "`r`n")).Count
  $lfCount = ([regex]::Matches($text, "`n")).Count

  return [pscustomobject]@{
    Text   = $text
    HasBom = $hasBom
    IsUtf8 = $isUtf8
    IsCrlf = $crlfCount -gt 0 -and $crlfCount * 2 -ge $lfCount
  }
}

function ConvertTo-LineEnding {
  <# Normalises every line break in $Text to LF, or to CRLF when -Crlf is set. #>
  param([string]$Text, [switch]$Crlf)

  $lf = $Text.Replace("`r`n", "`n").Replace("`r", "`n")
  if ($Crlf) { return $lf.Replace("`n", "`r`n") }
  return $lf
}

function Write-TextDocument {
  <#
    Writes $Text to $Path, keeping the BOM and line-ending style the file already
    had so that saving from Leaflet does not turn every line into a git diff.
    New files are written as UTF-8 without BOM, LF endings.
    The write goes to a temp file first and is then swapped in, so a crash or a
    full disk never leaves a half-written document behind.
  #>
  param([string]$Path, [string]$Text)

  $hasBom = $false
  $crlf = $false
  if (Test-Path -LiteralPath $Path) {
    $existing = Read-TextDocument -Path $Path
    if (-not $existing.IsUtf8) { throw 'not-utf8' }
    $hasBom = $existing.HasBom
    $crlf = $existing.IsCrlf
  }

  $encoding = $script:Utf8NoBom
  if ($hasBom) { $encoding = $script:Utf8Bom }
  $content = ConvertTo-LineEnding -Text $Text -Crlf:$crlf

  $temp = $Path + '.leaflet-tmp'
  try {
    [System.IO.File]::WriteAllText($temp, $content, $encoding)
    if (Test-Path -LiteralPath $Path) {
      [System.IO.File]::Replace($temp, $Path, [NullString]::Value)
    } else {
      [System.IO.File]::Move($temp, $Path)
    }
  } finally {
    # Only left behind if the swap failed, e.g. the file was locked.
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
}

function Get-QueryValue {
  <#
    Reads one query-string parameter as UTF-8. HttpListener's own QueryString
    decodes with the ANSI code page, which turns "cafe" with an accent into
    mojibake and makes any non-ASCII file name unreachable.
  #>
  param([string]$Query, [string]$Name)

  foreach ($pair in $Query.TrimStart('?').Split('&')) {
    $parts = $pair.Split('=', 2)
    $key = [System.Uri]::UnescapeDataString($parts[0].Replace('+', ' '))
    if ($key -ne $Name) { continue }
    if ($parts.Length -lt 2) { return '' }
    return [System.Uri]::UnescapeDataString($parts[1].Replace('+', ' '))
  }
  return $null
}

# Files from the opened folder that Leaflet will serve to the page (so that a
# markdown document can embed them). Anything that a browser could run as a
# page - .html, .svg, .js - is deliberately absent: it would execute on
# Leaflet's own origin and could use the save API.
$script:ServableExtensions = @('.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.pdf')

function Test-ServableFile {
  param([string]$Path)
  return $script:ServableExtensions -contains [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
}

function Get-MarkdownFiles {
  <# Lists markdown files directly inside $Folder as name + modified-time pairs. #>
  param([string]$Folder)

  Get-ChildItem -LiteralPath $Folder -File |
    Where-Object { $script:MarkdownExtensions -contains $_.Extension.ToLowerInvariant() } |
    Sort-Object Name |
    ForEach-Object {
      [pscustomobject]@{
        name  = $_.Name
        mtime = [string]$_.LastWriteTimeUtc.Ticks
        size  = $_.Length
      }
    }
}

function Get-ContentType {
  param([string]$Path)

  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    '.html' { 'text/html; charset=utf-8' }
    '.css'  { 'text/css; charset=utf-8' }
    '.js'   { 'text/javascript; charset=utf-8' }
    '.json' { 'application/json; charset=utf-8' }
    '.svg'  { 'image/svg+xml' }
    '.png'  { 'image/png' }
    '.jpg'  { 'image/jpeg' }
    '.jpeg' { 'image/jpeg' }
    '.gif'  { 'image/gif' }
    '.webp' { 'image/webp' }
    '.avif' { 'image/avif' }
    '.ico'  { 'image/x-icon' }
    '.bmp'  { 'image/bmp' }
    '.mp4'  { 'video/mp4' }
    '.webm' { 'video/webm' }
    '.pdf'  { 'application/pdf' }
    '.md'   { 'text/plain; charset=utf-8' }
    '.txt'  { 'text/plain; charset=utf-8' }
    default { 'application/octet-stream' }
  }
}

function Test-LocalHostHeader {
  <# Guards against DNS-rebinding: only accept requests addressed to this machine. #>
  param([string]$HostHeader, [int]$Port)

  $allowed = @("localhost:$Port", "127.0.0.1:$Port", "[::1]:$Port")
  return $allowed -contains $HostHeader
}
