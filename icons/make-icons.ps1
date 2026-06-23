Add-Type -AssemblyName System.Drawing

$dir = $PSScriptRoot
$sizes = 16, 32, 48, 128

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

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $radius = [int]([Math]::Max(2, $s * 0.22))
  $path = New-RoundedPath $s $s $radius

  $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
  $c1 = [System.Drawing.Color]::FromArgb(91, 140, 255)
  $c2 = [System.Drawing.Color]::FromArgb(63, 111, 224)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $c1, $c2, 45.0
  $g.FillPath($grad, $path)

  $txt = "{ }"
  $fontSize = [Math]::Max(6.0, $s * 0.46)
  $font = New-Object System.Drawing.Font "Segoe UI", $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $textRect = New-Object System.Drawing.RectangleF 0, 0, $s, $s
  $g.DrawString($txt, $font, $white, $textRect, $fmt)

  $g.Dispose()
  $bmp.Save((Join-Path $dir "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "wrote icon$s.png"
}
