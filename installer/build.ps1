# Builds dist\<version>\dsx-<version>-setup.exe with only what ships with Windows, plus the local Node.js
# runtime it bundles.
param([string]$NodeExe = '')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$work = Join-Path $dist 'work'
Add-Type -AssemblyName System.Drawing, System.IO.Compression.FileSystem

function New-AppImage([int]$size) {
  $image = New-Object Drawing.Bitmap($size, $size)
  $g = [Drawing.Graphics]::FromImage($image)
  $g.SmoothingMode = 'AntiAlias'
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Max(2, [int]($size / 2))
  $last = $size - 1
  $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($last - $d, 0, $d, $d, 270, 90)
  $path.AddArc($last - $d, $last - $d, $d, $d, 0, 90); $path.AddArc(0, $last - $d, $d, $d, 90, 90); $path.CloseFigure()
  $brush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(86, 134, 254))
  $g.FillPath($brush, $path)
  $pen = New-Object Drawing.Pen([Drawing.Color]::White, [float]($size * 0.09))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $points = @(
    (New-Object Drawing.PointF([float]($size * .27), [float]($size * .31))),
    (New-Object Drawing.PointF([float]($size * .46), [float]($size * .5))),
    (New-Object Drawing.PointF([float]($size * .27), [float]($size * .69))))
  $g.DrawLines($pen, [Drawing.PointF[]]$points)
  $g.DrawLine($pen, [float]($size * .52), [float]($size * .69), [float]($size * .75), [float]($size * .69))
  $g.Dispose()
  return $image
}

function Get-PngBytes($image) {
  $stream = New-Object IO.MemoryStream
  $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
  return $stream.ToArray()
}

# An .ico file is a small header followed by PNG images.
function Write-Icon([string]$target) {
  $sizes = 16, 32, 48, 256
  $images = $sizes | ForEach-Object { , (Get-PngBytes (New-AppImage $_)) }
  $stream = [IO.File]::Create($target)
  $writer = New-Object IO.BinaryWriter($stream)
  $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $side = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
    $writer.Write([byte]$side); $writer.Write([byte]$side); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([UInt16]1); $writer.Write([UInt16]32)
    $writer.Write([UInt32]$images[$i].Length); $writer.Write([UInt32]$offset)
    $offset += $images[$i].Length
  }
  foreach ($bytes in $images) { $writer.Write([byte[]]$bytes) }
  $writer.Close()
}

# The setup registers the host for one extension ID, so it must match the extension's key.
$manifest = Get-Content -Raw (Join-Path $root 'extension\manifest.json') | ConvertFrom-Json
$sha = [Security.Cryptography.SHA256]::Create().ComputeHash([Convert]::FromBase64String($manifest.key))
$extensionId = -join ($sha[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
$source = Join-Path $PSScriptRoot 'Setup.cs'
if (-not (Select-String -Path $source -SimpleMatch $extensionId -Quiet)) { throw "Setup.cs does not use the extension ID $extensionId." }
$geckoId = $manifest.browser_specific_settings.gecko.id
if (-not (Select-String -Path $source -SimpleMatch $geckoId -Quiet)) { throw "Setup.cs does not use the Firefox extension ID $geckoId." }
# One folder per version, so older builds stay next to each other and never mix with a newer one.
$release = Join-Path $dist $manifest.version

if (-not $NodeExe) { $NodeExe = (Get-Command node).Source }
$NodeExe = (Get-Item $NodeExe).FullName
$linked = (Get-Item $NodeExe).Target
if ($linked) { $NodeExe = $linked | Select-Object -First 1 }

if (Test-Path $work) { Remove-Item $work -Recurse -Force -Confirm:$false }
New-Item -ItemType Directory -Force (Join-Path $work 'payload\host'), (Join-Path $work 'payload\runtime') | Out-Null

$icons = Join-Path $root 'extension\icons'
New-Item -ItemType Directory -Force $icons | Out-Null
foreach ($size in 16, 48, 128) {
  $image = New-AppImage $size
  $image.Save((Join-Path $icons "icon$size.png"), [Drawing.Imaging.ImageFormat]::Png)
}
$icon = Join-Path $work 'app.ico'
Write-Icon $icon

Copy-Item (Join-Path $root 'extension') (Join-Path $work 'payload\extension') -Recurse
foreach ($file in 'host.js', 'tools.js', 'instructions.js', 'mcp.js', 'mcp-config.js', 'toml.js', 'pick-folder.ps1') { Copy-Item (Join-Path $root "host\$file") (Join-Path $work 'payload\host') }
Copy-Item $NodeExe (Join-Path $work 'payload\runtime\node.exe')
$nodeLicense = Join-Path (Split-Path $NodeExe) 'LICENSE'
if (Test-Path $nodeLicense) { Copy-Item $nodeLicense (Join-Path $work 'payload\runtime\LICENSE') }

$zip = Join-Path $work 'payload.zip'
$archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
$base = (Join-Path $work 'payload') + '\'
Get-ChildItem (Join-Path $work 'payload') -Recurse -File | ForEach-Object {
  $name = $_.FullName.Substring($base.Length).Replace('\', '/')
  [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $name, 'Optimal')
}
$archive.Dispose()

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
New-Item -ItemType Directory -Force $release | Out-Null
$output = Join-Path $release "dsx-$($manifest.version)-setup.exe"
if (Test-Path $output) { Remove-Item $output -Force -Confirm:$false }
$arguments = @(
  '/nologo', '/target:winexe', '/optimize+', '/platform:x64', "/out:$output",
  "/win32icon:$icon", "/win32manifest:$(Join-Path $PSScriptRoot 'app.manifest')", "/resource:$zip,payload.zip",
  '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
  '/r:System.IO.Compression.dll', '/r:Microsoft.CSharp.dll', $source
)
& $csc @arguments
if ($LASTEXITCODE -ne 0) { throw 'The setup failed to compile.' }
Remove-Item $work -Recurse -Force -Confirm:$false
Write-Output ("Built {0} ({1:N1} MB), bundling Node.js {2}" -f $output, ((Get-Item $output).Length / 1MB), (& $NodeExe --version))
