<#
  Tests for src\Leaflet.Helpers.ps1. No test framework needed:

    powershell -ExecutionPolicy Bypass -File .\tests\Leaflet.Helpers.Tests.ps1

  Exits non-zero if any test fails.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\src\Leaflet.Helpers.ps1')

$script:failures = 0
$script:count = 0
function It([string]$Name, [scriptblock]$Body) {
  $script:count++
  try {
    & $Body
    Write-Host "  PASS  $Name" -ForegroundColor Green
  } catch {
    $script:failures++
    Write-Host "  FAIL  $Name`n        $($_.Exception.Message)" -ForegroundColor Red
  }
}
function Assert-Equal($Expected, $Actual) {
  if ($Expected -cne $Actual) { throw "expected [$Expected] but got [$Actual]" }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('leaflet-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Write-Host 'Test-MarkdownName'
  It 'accepts plain markdown names'      { Assert-Equal $true (Test-MarkdownName 'notes.md'); Assert-Equal $true (Test-MarkdownName 'Read Me.MARKDOWN') }
  It 'rejects other extensions'          { Assert-Equal $false (Test-MarkdownName 'notes.txt'); Assert-Equal $false (Test-MarkdownName 'notes.md.exe') }
  It 'rejects folders and traversal'     { Assert-Equal $false (Test-MarkdownName '..\x.md'); Assert-Equal $false (Test-MarkdownName 'sub/x.md'); Assert-Equal $false (Test-MarkdownName 'C:x.md') }
  It 'rejects trailing dots and spaces'  { Assert-Equal $false (Test-MarkdownName 'x.md.'); Assert-Equal $false (Test-MarkdownName 'x.md ') }
  It 'rejects empty names'               { Assert-Equal $false (Test-MarkdownName ''); Assert-Equal $false (Test-MarkdownName '   ') }

  Write-Host 'Get-SafeChildPath'
  It 'resolves a nested file inside the root' {
    Assert-Equal (Join-Path $tmp 'img\a.png') (Get-SafeChildPath -Root $tmp -Relative 'img/a.png')
  }
  It 'refuses to climb out of the root' {
    Assert-Equal $null (Get-SafeChildPath -Root $tmp -Relative '../secret.txt')
    Assert-Equal $null (Get-SafeChildPath -Root $tmp -Relative 'img/../../secret.txt')
  }
  It 'refuses absolute and UNC paths' {
    Assert-Equal $null (Get-SafeChildPath -Root $tmp -Relative 'C:/Windows/win.ini')
    Assert-Equal $null (Get-SafeChildPath -Root $tmp -Relative '//server/share/x')
  }
  It 'refuses a sibling folder that shares the root as a prefix' {
    Assert-Equal $null (Get-SafeChildPath -Root $tmp -Relative ('../' + (Split-Path -Leaf $tmp) + '-evil/x.md'))
  }

  Write-Host 'ConvertTo-LineEnding'
  It 'normalises CRLF and CR to LF' { Assert-Equal "a`nb`nc" (ConvertTo-LineEnding -Text "a`r`nb`rc") }
  It 'converts LF to CRLF on request' { Assert-Equal "a`r`nb" (ConvertTo-LineEnding -Text "a`nb" -Crlf) }

  Write-Host 'Write-TextDocument'
  It 'keeps CRLF line endings of an existing file' {
    $p = Join-Path $tmp 'crlf.md'
    [System.IO.File]::WriteAllText($p, "one`r`ntwo`r`n")
    Write-TextDocument -Path $p -Text "one`nchanged`n"
    Assert-Equal "one`r`nchanged`r`n" ([System.IO.File]::ReadAllText($p))
  }
  It 'keeps a UTF-8 BOM if the file had one' {
    $p = Join-Path $tmp 'bom.md'
    [System.IO.File]::WriteAllText($p, 'x', (New-Object System.Text.UTF8Encoding($true)))
    Write-TextDocument -Path $p -Text ('caf' + [char]0xE9)
    $bytes = [System.IO.File]::ReadAllBytes($p)
    Assert-Equal 0xEF $bytes[0]
    Assert-Equal ('caf' + [char]0xE9) (Read-TextDocument -Path $p).Text
  }
  It 'writes new files as UTF-8 without BOM and LF' {
    $p = Join-Path $tmp 'new.md'
    Write-TextDocument -Path $p -Text "a`nb"
    $bytes = [System.IO.File]::ReadAllBytes($p)
    Assert-Equal ([byte][char]'a') $bytes[0]
    Assert-Equal "a`nb" ([System.IO.File]::ReadAllText($p))
  }
  It 'leaves no temp file behind' {
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $tmp -Filter '*.leaflet-tmp').Count
  }

  It 'keeps LF when a mostly-LF file has one stray CRLF' {
    $p = Join-Path $tmp 'mixed.md'
    [System.IO.File]::WriteAllText($p, "a`nb`nc`r`nd`n")
    Write-TextDocument -Path $p -Text "a`nb`nc`nd`n"
    Assert-Equal "a`nb`nc`nd`n" ([System.IO.File]::ReadAllText($p))
    Remove-Item -LiteralPath $p
  }
  It 'marks a Windows-1252 file as not UTF-8 and refuses to overwrite it' {
    $p = Join-Path $tmp 'ansi.txt'
    [System.IO.File]::WriteAllBytes($p, [byte[]](0x63, 0x61, 0x66, 0xE9))   # "caf" + e-acute in cp1252
    Assert-Equal $false (Read-TextDocument -Path $p).IsUtf8
    $refused = $false
    try { Write-TextDocument -Path $p -Text 'x' } catch { $refused = $_.Exception.Message -eq 'not-utf8' }
    Assert-Equal $true $refused
    Assert-Equal 4 ([System.IO.File]::ReadAllBytes($p)).Length
    Remove-Item -LiteralPath $p
  }
  It 'reads a UTF-16 file as text but marks it not UTF-8' {
    $p = Join-Path $tmp 'utf16.txt'
    [System.IO.File]::WriteAllText($p, 'hello', [System.Text.Encoding]::Unicode)
    $doc = Read-TextDocument -Path $p
    Assert-Equal 'hello' $doc.Text
    Assert-Equal $false $doc.IsUtf8
    Remove-Item -LiteralPath $p
  }

  Write-Host 'Get-QueryValue'
  It 'decodes UTF-8 percent-escapes' { Assert-Equal ('caf' + [char]0xE9 + '.md') (Get-QueryValue -Query '?name=caf%C3%A9.md' -Name 'name') }
  It 'finds the right key and handles missing ones' {
    Assert-Equal 'b.md' (Get-QueryValue -Query '?x=1&name=b.md' -Name 'name')
    Assert-Equal $null (Get-QueryValue -Query '?x=1' -Name 'name')
  }

  Write-Host 'Test-ServableFile'
  It 'serves images and media' { Assert-Equal $true (Test-ServableFile 'a\pic.PNG'); Assert-Equal $true (Test-ServableFile 'clip.mp4') }
  It 'never serves anything a browser could run' {
    foreach ($f in 'x.html', 'x.htm', 'x.svg', 'x.js', 'x.xml', 'x.md') { Assert-Equal $false (Test-ServableFile $f) }
  }

  Write-Host 'Get-MarkdownFiles'
  It 'lists only markdown files, sorted' {
    New-Item -ItemType File -Path (Join-Path $tmp 'z.txt') | Out-Null
    $names = (Get-MarkdownFiles -Folder $tmp | ForEach-Object { $_.name }) -join ','
    Assert-Equal 'bom.md,crlf.md,new.md' $names
  }

  Write-Host 'Test-LocalHostHeader'
  It 'accepts loopback hosts on the right port' { Assert-Equal $true (Test-LocalHostHeader 'localhost:5000' 5000); Assert-Equal $true (Test-LocalHostHeader '127.0.0.1:5000' 5000) }
  It 'rejects other hosts and ports' { Assert-Equal $false (Test-LocalHostHeader 'evil.com:5000' 5000); Assert-Equal $false (Test-LocalHostHeader 'localhost:5001' 5000) }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force
}

Write-Host ''
if ($script:failures) {
  Write-Host "$($script:failures) of $($script:count) tests failed." -ForegroundColor Red
  exit 1
}
Write-Host "All $($script:count) tests passed." -ForegroundColor Green
