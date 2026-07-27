# Generates the toolbar icon set. The extension swaps icons per tab, so there is one set per
# platform: the default blue set in this folder, and a Zapier-orange set in ./zapier.
#
#   .\make-icons.ps1                                               # Pabbly / default (blue)
#   .\make-icons.ps1 -Color1 '#FF4A00' -Color2 '#D93F00' -OutDir zapier   # Zapier (orange)

param(
  [string]$Color1 = '#5B8CFF',
  [string]$Color2 = '#3F6FE0',
  [string]$OutDir = '.',
  [string]$Glyph = '{ }'
)

Add-Type -AssemblyName System.Drawing

$sizes = 16, 32, 48, 128
$target = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $PSScriptRoot $OutDir }
if (-not (Test-Path $target)) { New-Item -ItemType Directory -Force -Path $target | Out-Null }

function ConvertTo-Color([string]$hex) {
  $h = $hex.TrimStart('#')
  return [System.Drawing.Color]::FromArgb(
    [Convert]::ToInt32($h.Substring(0, 2), 16),
    [Convert]::ToInt32($h.Substring(2, 2), 16),
    [Convert]::ToInt32($h.Substring(4, 2), 16)
  )
}

function New-RoundedPath([int]$w, [int]$h, [int]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($w - $d, 0, $d, $d, 270, 90)
  $path.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
  $path.AddArc(0, $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

$c1 = ConvertTo-Color $Color1
$c2 = ConvertTo-Color $Color2

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $radius = [int]([Math]::Max(2, $s * 0.22))
  $path = New-RoundedPath $s $s $radius

  $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $c1, $c2, 45.0
  $g.FillPath($grad, $path)

  $fontSize = [Math]::Max(6.0, $s * 0.46)
  $font = New-Object System.Drawing.Font "Segoe UI", $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $textRect = New-Object System.Drawing.RectangleF 0, 0, $s, $s
  $g.DrawString($Glyph, $font, $white, $textRect, $fmt)

  $g.Dispose()
  $out = Join-Path $target "icon$s.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "wrote $out"
}
