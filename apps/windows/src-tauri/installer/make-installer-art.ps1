# Makes the installer's pictures from Relo's own icon and look (Windows PowerShell 5.1 or PowerShell 7 on Windows; System.Drawing,
# nothing to install):
#
#   powershell -NoProfile -File apps/windows/src-tauri/installer/make-installer-art.ps1
#
# Writes next to this script:
#   header.bmp   150x57   the top strip of the progress page and of the uninstaller's pages (tauri.conf.json: headerImage)
#   sidebar.bmp  164x314  the left side of the welcome and finish pages (sidebarImage)
#   preview/welcome.png, preview/progress.png, preview/finish.png
#                         what the three pages look like, at twice the size: a drawing from the same pictures and the same
#                         words as installer.nsi, for judging the look without running the installer (NSIS bitmaps have no 2x form)
#
# The look is Relo's: the near black of the app's windows (rgb 8 8 14) with the aurora of ReloAurora.swift and Aurora.tsx
# (indigo, coral and mint light, drifting at the edges), and the app icon (icons/icon.png) as the one piece of logo. The words
# below are the same as the ones in installer.nsi (MUI_WELCOMEPAGE_TEXT and its neighbours): change both together.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$icon = [System.Drawing.Image]::FromFile((Join-Path $here '..\icons\icon.png'))
$previewDir = Join-Path $here 'preview'
New-Item -ItemType Directory -Force $previewDir | Out-Null

function Rgb([string]$hex, [int]$alpha = 255) {
  [System.Drawing.Color]::FromArgb($alpha, [Convert]::ToInt32($hex.Substring(0, 2), 16), [Convert]::ToInt32($hex.Substring(2, 2), 16), [Convert]::ToInt32($hex.Substring(4, 2), 16))
}
$ink = Rgb '08080E'          # the app windows' background
$text = Rgb 'F3F3F7'
$soft = [System.Drawing.Color]::FromArgb(160, 255, 255, 255)

function Use-Smooth($g) {
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
  $g.TextRenderingHint = 'ClearTypeGridFit'
}

# One soft disc of light: full colour at the middle, nothing at the edge.
function Add-Light($g, [single]$cx, [single]$cy, [single]$radius, $color) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse($cx - $radius, $cy - $radius, 2 * $radius, 2 * $radius)
  $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
  $brush.CenterColor = $color
  $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $color.R, $color.G, $color.B))
  $g.FillPath($brush, $path)
  $brush.Dispose(); $path.Dispose()
}

# Relo's aurora: indigo up left, coral low right, mint low left, on the app's near black.
function New-Aurora([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  Use-Smooth $g
  $g.Clear($ink)
  $big = [Math]::Max($w, $h)
  Add-Light $g ($w * 0.15) ($h * 0.02) ($big * 0.85) (Rgb '8B7CFF' 120)
  Add-Light $g ($w * 0.92) ($h * 0.78) ($big * 0.62) (Rgb 'FF7A66' 95)
  Add-Light $g ($w * 0.05) ($h * 0.98) ($big * 0.5) (Rgb '34D399' 85)
  $g.Dispose()
  return $bmp
}

function Add-Icon($g, [single]$x, [single]$y, [single]$size) {
  # A faint halo so the black tile lifts off the dark.
  Add-Light $g ($x + $size / 2) ($y + $size / 2) ($size * 0.95) ([System.Drawing.Color]::FromArgb(46, 255, 255, 255))
  $g.DrawImage($icon, $x, $y, $size, $size)
}

function Save-Bmp($bmp, [string]$name) {
  $bmp.Save((Join-Path $here $name), [System.Drawing.Imaging.ImageFormat]::Bmp)
}

function Draw-Centered($g, [string]$s, $font, $brush, [single]$cx, [single]$y) {
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = 'Center'
  $g.DrawString($s, $font, $brush, $cx, $y, $format)
}

# ---- sidebar.bmp: 164x314 -------------------------------------------------------------------------------------------------
$sidebar = New-Aurora 164 314
$g = [System.Drawing.Graphics]::FromImage($sidebar); Use-Smooth $g
Add-Icon $g 26 70 112
$semi = New-Object System.Drawing.Font 'Segoe UI Semibold', 10.5, 'Regular', 'Pixel'
$small = New-Object System.Drawing.Font 'Segoe UI', 9.5, 'Regular', 'Pixel'
$whiteBrush = New-Object System.Drawing.SolidBrush $text
$softBrush = New-Object System.Drawing.SolidBrush $soft
Draw-Centered $g 'Relo for Windows' $semi $whiteBrush 82 204
Draw-Centered $g 'Your agents, at the notch' $small $softBrush 82 224
# The sprinkles of the icon, as five dots.
$x = 82 - 5 * 9
foreach ($c in 'FF8A3D', 'FACC15', 'FF6B57', '4D8DFF', '8B7CFF') {
  $b = New-Object System.Drawing.SolidBrush (Rgb $c)
  $g.FillEllipse($b, $x, 280, 7, 7); $b.Dispose(); $x += 18
}
$g.Dispose()
Save-Bmp $sidebar 'sidebar.bmp'

# ---- header.bmp: 150x57 ---------------------------------------------------------------------------------------------------
$header = New-Aurora 150 57
$g = [System.Drawing.Graphics]::FromImage($header); Use-Smooth $g
Add-Icon $g 96 8 41
$g.Dispose()
Save-Bmp $header 'header.bmp'

# ---- previews: the NSIS window as a drawing, at 2x ------------------------------------------------------------------------------
# The window is 500 wide: a 31 high title bar, a 314 high page and a 48 high button strip.
$S = 2; $W = 500; $H = 393; $PAGE_TOP = 31; $PAGE_H = 314; $STRIP = $PAGE_TOP + $PAGE_H
$gray = Rgb 'F0F0F0'
$ui = New-Object System.Drawing.Font 'Segoe UI', 12, 'Regular', 'Pixel'
$uiBold = New-Object System.Drawing.Font 'Segoe UI', 12.5, 'Bold', 'Pixel'
$title = New-Object System.Drawing.Font 'Segoe UI', 16, 'Bold', 'Pixel'
$ink2 = New-Object System.Drawing.SolidBrush $ink
$blackBrush = [System.Drawing.Brushes]::Black

function New-Window([string]$caption) {
  $bmp = New-Object System.Drawing.Bitmap ($W * $S), ($H * $S)
  $g = [System.Drawing.Graphics]::FromImage($bmp); Use-Smooth $g
  $g.ScaleTransform($S, $S)
  $g.Clear($gray)
  $g.FillRectangle([System.Drawing.Brushes]::White, 0, 0, $W, $PAGE_TOP)
  $g.DrawImage($icon, 8, 8, 16, 16)
  $g.DrawString($caption, $ui, $blackBrush, 32, 7)
  $g.DrawString('-', $ui, $blackBrush, 372, 6); $g.DrawString('[ ]', $ui, $blackBrush, 417, 6); $g.DrawString('x', $ui, $blackBrush, 470, 6)
  $line = New-Object System.Drawing.Pen (Rgb 'A0A0A0')
  $g.DrawLine($line, 0, $STRIP, $W, $STRIP)
  $g.DrawString('Relo', $ui, (New-Object System.Drawing.SolidBrush (Rgb '808080')), 8, $STRIP + 17)
  return @{ Bitmap = $bmp; G = $g }
}

function Draw-Button($g, [string]$label, [single]$x, [bool]$primary, [bool]$enabled) {
  $pen = New-Object System.Drawing.Pen (Rgb $(if ($primary) { '0078D7' } else { 'ADADAD' })), $(if ($primary) { 2 } else { 1 })
  $g.FillRectangle((New-Object System.Drawing.SolidBrush (Rgb 'E1E1E1')), $x, $STRIP + 10, 86, 25)
  $g.DrawRectangle($pen, $x, $STRIP + 10, 86, 25)
  $brush = New-Object System.Drawing.SolidBrush (Rgb $(if ($enabled) { '000000' } else { 'A0A0A0' }))
  Draw-Centered $g $label $ui $brush ($x + 43) ($STRIP + 15)
}

function Draw-Wrapped($g, [string]$s, $font, $brush, [single]$x, [single]$y, [single]$w, [single]$h) {
  $g.DrawString($s, $font, $brush, (New-Object System.Drawing.RectangleF $x, $y, $w, $h))
}

function Add-SidePage($g, [string]$heading, [string]$body) {
  $g.FillRectangle($ink2, 164, $PAGE_TOP, $W - 164, $PAGE_H)
  $g.DrawImage($sidebar, 0, $PAGE_TOP, 164, 314)
  Draw-Wrapped $g $heading $title $whiteBrush 184 ($PAGE_TOP + 16) 300 56
  Draw-Wrapped $g $body $ui $whiteBrush 184 ($PAGE_TOP + 80) 296 190
}

function Save-Window($window, [string]$name) {
  $window.G.Dispose()
  $window.Bitmap.Save((Join-Path $previewDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $window.Bitmap.Dispose()
}

# Welcome: the one page with a choice to make, and the choice is "Install".
$w1 = New-Window 'Relo Setup'; $g = $w1.G
Add-SidePage $g 'Welcome to Relo' ("Relo keeps an eye on your AI agents and lets you know the moment one needs you, right at the top of your screen.`r`n`r`nClick Install and Relo will be ready in a moment. There is nothing to set up.")
Draw-Button $g '< Back' 224 $false $false
Draw-Button $g 'Install' 316 $true $true
Draw-Button $g 'Cancel' 408 $false $true
Save-Window $w1 'welcome.png'

# Progress: a short moment, the details out of the way.
$w2 = New-Window 'Relo Setup'; $g = $w2.G
$g.FillRectangle($ink2, 0, $PAGE_TOP, $W, 58)
$g.DrawImage($header, 350, $PAGE_TOP, 150, 57)
$g.DrawString('Getting Relo ready', $uiBold, $whiteBrush, 14, $PAGE_TOP + 10)
$g.DrawString('This only takes a moment.', $ui, $softBrush, 26, $PAGE_TOP + 30)
$g.DrawString('Putting Relo on your PC...', $ui, $blackBrush, 14, $PAGE_TOP + 78)
$g.FillRectangle([System.Drawing.Brushes]::White, 14, $PAGE_TOP + 100, 472, 18)
$g.FillRectangle((New-Object System.Drawing.SolidBrush (Rgb '06B025')), 15, $PAGE_TOP + 101, 292, 16)
$g.DrawRectangle((New-Object System.Drawing.Pen (Rgb 'BCBCBC')), 14, $PAGE_TOP + 100, 472, 18)
$g.FillRectangle((New-Object System.Drawing.SolidBrush (Rgb 'E1E1E1')), 14, $PAGE_TOP + 132, 100, 25)
$g.DrawRectangle((New-Object System.Drawing.Pen (Rgb 'ADADAD')), 14, $PAGE_TOP + 132, 100, 25)
Draw-Centered $g 'Show details' $ui $blackBrush 64 ($PAGE_TOP + 137)
Draw-Button $g '< Back' 224 $false $false
Draw-Button $g 'Next >' 316 $false $false
Draw-Button $g 'Cancel' 408 $false $true
Save-Window $w2 'progress.png'

# Finish: Relo is ready, and "Open Relo" is already ticked.
$w3 = New-Window 'Relo Setup'; $g = $w3.G
Add-SidePage $g 'Relo is ready' "Relo is installed and waits quietly at the top of your screen.`r`n`r`nYou can open it from the Start menu any time."
$g.DrawRectangle((New-Object System.Drawing.Pen (Rgb '8B8B96')), 186, $PAGE_TOP + 180, 13, 13)
$g.DrawString([string][char]0x2713, $ui, $whiteBrush, 186, $PAGE_TOP + 177)
$g.DrawString('Open Relo', $ui, $whiteBrush, 206, $PAGE_TOP + 177)
Draw-Button $g '< Back' 224 $false $false
Draw-Button $g 'Done' 316 $true $true
Draw-Button $g 'Cancel' 408 $false $false
Save-Window $w3 'finish.png'

$icon.Dispose(); $sidebar.Dispose(); $header.Dispose()
Write-Host "installer art: header.bmp, sidebar.bmp and preview/*.png written to $here"
