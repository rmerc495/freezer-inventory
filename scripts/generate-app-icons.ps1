Add-Type -AssemblyName System.Drawing
$iconDirectory = Join-Path $PSScriptRoot '../public/icons'
New-Item -ItemType Directory -Force -Path $iconDirectory | Out-Null
foreach ($size in @(192, 512)) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#184d43'))
    $graphics.ScaleTransform($size / 512.0, $size / 512.0)
    $cream = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#fffefb'))
    $green = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#184d43'), 12)
    $gold = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#c0a151'))
    # Keep the complete freezer inside Android's circular mask safe area.
    $graphics.FillRectangle($cream, 158, 120, 196, 272)
    $graphics.DrawLine($green, 158, 216, 354, 216)
    $graphics.DrawLine($green, 184, 150, 184, 186)
    $graphics.DrawLine($green, 184, 244, 184, 300)
    $graphics.FillEllipse($gold, 302, 338, 18, 18)
    $bitmap.Save((Join-Path $iconDirectory "freezer-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    if ($size -eq 512) {
        $bitmap.Save((Join-Path $iconDirectory 'freezer-maskable-512.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $gold.Dispose(); $green.Dispose(); $cream.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
