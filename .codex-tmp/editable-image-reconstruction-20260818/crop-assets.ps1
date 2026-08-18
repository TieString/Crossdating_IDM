Add-Type -AssemblyName System.Drawing

$sourceDir = 'D:\Code\Crossdating_Tauri_js-diagnosis-events-v1\docs\conference-dating-recommendation-imagegen-v1'
$assetDir = 'D:\Code\Crossdating_Tauri_js-diagnosis-events-v1\.codex-tmp\editable-image-reconstruction-20260818\assets'
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null

function Export-Crop {
    param(
        [string]$Source,
        [string]$Destination,
        [int]$X,
        [int]$Y,
        [int]$Width,
        [int]$Height
    )

    $image = [System.Drawing.Image]::FromFile($Source)
    try {
        $bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.DrawImage(
                    $image,
                    [System.Drawing.Rectangle]::new(0, 0, $Width, $Height),
                    [System.Drawing.Rectangle]::new($X, $Y, $Width, $Height),
                    [System.Drawing.GraphicsUnit]::Pixel
                )
            }
            finally {
                $graphics.Dispose()
            }
            $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $bitmap.Dispose()
        }
    }
    finally {
        $image.Dispose()
    }
}

Export-Crop -Source "$sourceDir\slide-01.png" -Destination "$assetDir\foliage-corner.png" -X 0 -Y 0 -Width 360 -Height 90
Export-Crop -Source "$sourceDir\slide-03.png" -Destination "$assetDir\target-core.png" -X 138 -Y 262 -Width 300 -Height 54
Export-Crop -Source "$sourceDir\slide-03.png" -Destination "$assetDir\anchor-cores.png" -X 132 -Y 558 -Width 320 -Height 92
Export-Crop -Source "$sourceDir\slide-04.png" -Destination "$assetDir\global-core.png" -X 72 -Y 238 -Width 470 -Height 82
Export-Crop -Source "$sourceDir\slide-04.png" -Destination "$assetDir\segmented-core.png" -X 1100 -Y 230 -Width 520 -Height 88

Get-ChildItem -LiteralPath $assetDir -Filter '*.png' | Sort-Object Name | Select-Object Name, Length
