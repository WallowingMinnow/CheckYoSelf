# Draws the FICTIONAL demo images used by the OCR demo page and `npm run check:ocr`.
# All names, teams and phone numbers are made up (555-01xx numbers are reserved
# for fiction). The PNGs are committed, so you only need this to change them.
#
# Windows only (uses .NET System.Drawing). Run from the extension folder:
#   powershell -ExecutionPolicy Bypass -File scripts/make-ocr-demo-images.ps1
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "..\src\ocr\demo\images"
New-Item -ItemType Directory -Force $outDir | Out-Null

function New-Canvas([int]$w, [int]$h, [System.Drawing.Color]$bg) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.TextRenderingHint = "AntiAliasGridFit"
  $g.Clear($bg)
  return @($bmp, $g)
}

function Save-Png($bmp, $g, [string]$name) {
  $g.Dispose()
  $bmp.Save((Join-Path $outDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "wrote $name"
}

$ink = [System.Drawing.Brushes]::Black

# 1. A clear printed banner (should read well).
$c = New-Canvas 900 420 ([System.Drawing.Color]::FromArgb(250, 248, 240))
$bmp = $c[0]; $g = $c[1]
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(30, 90, 160))), 0, 0, 900, 24)
$g.DrawString("Riverside Youth Soccer", (New-Object System.Drawing.Font "Arial", 44, ([System.Drawing.FontStyle]::Bold)), $ink, 40, 60)
$g.DrawString("U10 Tigers - Spring Season", (New-Object System.Drawing.Font "Arial", 34), $ink, 40, 160)
$g.DrawString("Coach Dana 608-555-0142", (New-Object System.Drawing.Font "Arial", 34), $ink, 40, 250)
Save-Png $bmp $g "team-banner.png"

# 2. No text at all: shapes only (a successful scan should say "no text").
$c = New-Canvas 640 400 ([System.Drawing.Color]::FromArgb(200, 225, 245))
$bmp = $c[0]; $g = $c[1]
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(250, 210, 80))), 460, 40, 120, 120)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 160, 90))), 0, 300, 640, 100)
$g.FillPolygon((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 120, 140))), [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point 60, 300), (New-Object System.Drawing.Point 220, 120), (New-Object System.Drawing.Point 380, 300)))
Save-Png $bmp $g "no-text.png"

# 3. The banner text rotated 90 degrees (limitation demo: expect poor results).
$c = New-Canvas 420 900 ([System.Drawing.Color]::FromArgb(250, 248, 240))
$bmp = $c[0]; $g = $c[1]
$g.TranslateTransform(380, 40)
$g.RotateTransform(90)
$g.DrawString("Maple Street Bakery", (New-Object System.Drawing.Font "Arial", 40, ([System.Drawing.FontStyle]::Bold)), $ink, 0, 0)
$g.DrawString("Open daily 7am", (New-Object System.Drawing.Font "Arial", 32), $ink, 0, 90)
Save-Png $bmp $g "rotated-sign.png"

# 4. Script-style lettering (limitation demo: stylized text is often misread).
$c = New-Canvas 900 300 ([System.Drawing.Color]::FromArgb(255, 245, 250))
$bmp = $c[0]; $g = $c[1]
$g.DrawString("Happy 9th Birthday Milo!", (New-Object System.Drawing.Font "Segoe Script", 40), $ink, 30, 60)
$g.DrawString("Party at Oak Hollow Park", (New-Object System.Drawing.Font "Segoe Script", 30), $ink, 30, 170)
Save-Png $bmp $g "script-card.png"
