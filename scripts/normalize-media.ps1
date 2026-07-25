param(
  [Parameter(Mandatory = $true)]
  [string[]] $InputFiles
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectRoot "media"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

for ($index = 0; $index -lt $InputFiles.Count; $index += 1) {
  $source = (Resolve-Path -LiteralPath $InputFiles[$index]).Path
  $destination = Join-Path $outputDirectory "$($index + 1).mp4"
  & ffmpeg -y -i $source `
    -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,setsar=1" `
    -af "aresample=48000" `
    -c:v libx264 -preset veryfast -crf 20 -g 60 -keyint_min 60 -sc_threshold 0 `
    -c:a aac -b:a 160k -movflags +faststart $destination
  if ($LASTEXITCODE -ne 0) {
    throw "FFmpeg failed for $source"
  }
}
