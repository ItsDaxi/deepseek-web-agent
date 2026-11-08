# Publishes a release in one command: raises the version, runs the tests, builds the setup, commits,
# pushes, and creates the GitHub release with the setup attached. If dist\<version>\dsx-<version>-firefox.xpi
# exists (the package signed by Mozilla), it is attached too.
#
#   powershell -ExecutionPolicy Bypass -File installer/release.ps1 -Version 0.2.0
#
# -DryRun    does everything except commit, push and publish, then puts the version files back.
# -WithE2E   also runs the end-to-end test, which needs Python with Playwright.
# -ChangesFile is a text file with the list of changes for the notes, instead of the commit subjects.
#            The standard text and the SHA-256 of the setup are added around it.
# -CommitTrailer adds a line to the end of the release commit message.
#
# It needs Node.js, git, and the GitHub CLI (gh) logged in to the account that owns the repository.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$DryRun,
  [switch]$WithE2E,
  [string]$ChangesFile = '',
  [string]$CommitTrailer = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$repo = 'ItsDaxi/deepseek-web-agent'
$tag = "v$Version"
$manifestPath = Join-Path $root 'extension\manifest.json'
$packagePath = Join-Path $root 'package.json'
# Everything a release makes goes in dist\<version>, named dsx-<version>-<what>.
$releaseDir = Join-Path $root "dist\$Version"
$installerName = "dsx-$Version-setup.exe"
$installer = Join-Path $releaseDir $installerName
$firefoxName = "dsx-$Version-firefox.xpi"
$firefox = Join-Path $releaseDir $firefoxName

# Native commands report failure through their exit code, and git writes warnings to stderr that
# must not stop the script, so each one runs through this.
function Invoke-Checked([string]$what, [scriptblock]$command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $command } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)." }
}

# For a command whose failure is an answer rather than an error, such as a release that does not exist.
# Windows PowerShell 5.1 turns anything a native command writes to stderr into a terminating error
# while $ErrorActionPreference is Stop, so the preference is relaxed for the call.
function Test-Succeeds([scriptblock]$command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $command *> $null } finally { $ErrorActionPreference = $previous }
  return ($LASTEXITCODE -eq 0)
}

function Get-Output([scriptblock]$command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = & $command 2> $null } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { return $null }
  return $output
}

function Write-Step([string]$text) { Write-Output "`n== $text" }

function Set-JsonVersion([string]$path, [string]$value) {
  $text = [IO.File]::ReadAllText($path)
  $pattern = [regex]'("version"\s*:\s*")[^"]+(")'
  if (-not $pattern.IsMatch($text)) { throw "No version found in $path." }
  [IO.File]::WriteAllText($path, $pattern.Replace($text, ('${1}' + $value + '${2}'), 1), (New-Object Text.UTF8Encoding($false)))
}

# ---- Checks ------------------------------------------------------------------------------------
Write-Step 'Checking'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "The version must look like 1.2.3, not '$Version'." }
$current = (Get-Content -Raw $manifestPath | ConvertFrom-Json).version
if ([version]$Version -le [version]$current) { throw "The version must be higher than the current one ($current)." }

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh -and (Test-Path 'C:\Program Files\GitHub CLI\gh.exe')) { $gh = 'C:\Program Files\GitHub CLI\gh.exe' }
if (-not $gh) { throw 'The GitHub CLI (gh) is not installed.' }
Invoke-Checked 'gh auth status' { & $gh auth status *> $null }

if ((git rev-parse --abbrev-ref HEAD) -ne 'main') { throw 'Switch to the main branch first.' }
if (git status --porcelain) { throw 'There are uncommitted changes. Commit them first.' }
Invoke-Checked 'git fetch' { git fetch --quiet --tags origin }
if ([int](git rev-list --count 'HEAD..origin/main') -gt 0) { throw 'The remote has commits you do not have. Pull first.' }
if (Test-Succeeds { & $gh release view $tag --repo $repo }) { throw "The release $tag already exists." }
Write-Output "Releasing $tag (current version $current)."

# ---- Version, tests and build -------------------------------------------------------------------
Write-Step 'Raising the version'
Set-JsonVersion $manifestPath $Version
Set-JsonVersion $packagePath $Version

try {
  Write-Step 'Running the unit tests'
  Invoke-Checked 'The unit tests' { npm test --silent }
  if ($WithE2E) {
    Write-Step 'Running the end-to-end test'
    Invoke-Checked 'The end-to-end tests' { npm run test:e2e --silent }
  }

  Write-Step 'Building the setup'
  Invoke-Checked 'The build' { powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build.ps1') }
  if (-not (Test-Path $installer)) { throw "The build did not produce $installer." }
  Invoke-Checked 'The Firefox package' { node (Join-Path $PSScriptRoot 'build-firefox.js') }
  $hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()
  $nodeVersion = (node --version)
  Write-Output "SHA-256: $hash"

  # ---- Release notes ----------------------------------------------------------------------------
  if ($ChangesFile) {
    $list = ([IO.File]::ReadAllText((Resolve-Path $ChangesFile))).Trim()
  } else {
    $previous = Get-Output { git describe --tags --abbrev=0 }
    $range = if ($previous) { "$previous..HEAD" } else { 'HEAD' }
    $subjects = @(git log --pretty=format:'%s' $range | Where-Object { $_ -notmatch '^Release v' })
    $list = if ($subjects.Count) { ($subjects | ForEach-Object { "- $_" }) -join "`n" } else { '- Small fixes.' }
  }
  $tick = [char]96
  $notes = @(
    '## What changed', '', $list, '',
    "$tick$installerName$tick is the Windows setup for the extension and its native host, for Chromium browsers and Firefox. It needs no admin rights and no Node.js (a copy of Node.js $nodeVersion is bundled), and installs into your user folder. Run it over an older install to update it, then reload the extension in your browser.",
    '',
    'The setup is not signed, so SmartScreen may warn you. Choose More info, then Run anyway, if you trust where you got it. You can check the download against this SHA-256:',
    '', "$tick$hash$tick", '',
    "This is unofficial and not affiliated with DeepSeek. It depends on the site's private web API, so a DeepSeek update can break it. Read the Security section of the README before you use Full access.",
    '', 'On macOS and Linux, install from source as described in the README.'
  ) -join "`n"
  $notesPath = Join-Path $env:TEMP "dsx-release-notes-$Version.md"
  [IO.File]::WriteAllText($notesPath, $notes, (New-Object Text.UTF8Encoding($false)))

  if ($DryRun) {
    Write-Step 'Dry run: nothing was committed, pushed or published'
    Write-Output "Release notes that would be used ($notesPath):`n"
    Write-Output $notes
    return
  }

  # ---- Commit, push, publish ----------------------------------------------------------------------
  Write-Step 'Committing and pushing'
  $message = "Release $tag"
  if ($CommitTrailer) { $message += "`n`n$CommitTrailer" }
  $messagePath = Join-Path $env:TEMP "dsx-release-commit-$Version.txt"
  [IO.File]::WriteAllText($messagePath, $message, (New-Object Text.UTF8Encoding($false)))
  Invoke-Checked 'git add' { git add -- extension/manifest.json package.json }
  Invoke-Checked 'git commit' { git commit --quiet -F $messagePath }
  Invoke-Checked 'git push' { git push origin main }

  Write-Step "Publishing $tag"
  $assets = @($installer)
  if (Test-Path $firefox) { $assets += $firefox } else { Write-Output "No signed Firefox package at $firefox, so the release has the setup only." }
  Invoke-Checked 'gh release create' { & $gh release create $tag @assets --repo $repo --target main --title $tag --notes-file $notesPath }

  Write-Step 'Checking the upload'
  $check = Join-Path $env:TEMP "dsx-release-check-$Version"
  New-Item -ItemType Directory -Force $check | Out-Null
  Invoke-Checked 'gh release download' { & $gh release download $tag --repo $repo --pattern $installerName --dir $check --clobber }
  $remoteHash = (Get-FileHash (Join-Path $check $installerName) -Algorithm SHA256).Hash.ToLower()
  Remove-Item $check -Recurse -Force
  if ($remoteHash -ne $hash) { throw "The uploaded file does not match the build (local $hash, uploaded $remoteHash)." }
  Write-Output "Uploaded file matches the build. https://github.com/$repo/releases/tag/$tag"
}
finally {
  # A dry run, or a failure before the commit, leaves the version files as they were.
  if ($DryRun -or -not ((git log -1 --pretty=%s) -like "Release $tag*")) {
    [void](Test-Succeeds { git checkout -- extension/manifest.json package.json })
  }
}
