# Build one of the sketches and upload it to one or more boards.
#
#   .\flash.ps1 -Role chat -Port COM4,COM6    # same firmware on both boards
#   .\flash.ps1 -Role tracker -Port COM4,COM6 # standalone GPS tracker, same on both
#   .\flash.ps1 -Role ping -Port COM4
#   .\flash.ps1 -Role pong -Port COM6
#   .\flash.ps1 -Role chat -BuildOnly

param(
    [Parameter(Mandatory = $true)][ValidateSet('chat', 'tracker', 'ping', 'pong')][string]$Role,
    [string[]]$Port,
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'

$root  = $PSScriptRoot
$cli   = 'C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe'
$libs  = Join-Path $root 'arduino\libraries'
$build = Join-Path $root "build\$Role"
$fqbn  = 'esp32:esp32:heltec_wifi_lora_32_V3'

if (-not (Test-Path $cli)) {
    throw "arduino-cli not found at $cli - install the Arduino IDE, or edit `$cli in this script"
}

# chat and tracker are each one sketch flashed identically to every board.
# ping/pong share a sketch and are told apart by a preprocessor define.
$props = @()
if ($Role -eq 'chat') {
    $sk = Join-Path $root 'smartphone\lora_chat'
} elseif ($Role -eq 'tracker') {
    $sk = Join-Path $root 'standalone\lora_tracker'
} else {
    $sk = Join-Path $root 'lora_pingpong'
    if ($Role -eq 'ping') {
        $props = @('--build-property', 'compiler.cpp.extra_flags=-DROLE_PING')
    }
}

# --libraries keeps this project's copies ahead of anything in the global
# sketchbook, so no arduino-cli config file (and no absolute user paths) needed.
Write-Host "==> compiling $Role" -ForegroundColor Cyan
& $cli compile -b $fqbn --libraries $libs @props --build-path $build $sk
if ($LASTEXITCODE -ne 0) { throw "compile failed" }

if ($BuildOnly) { return }
if (-not $Port) { throw "-Port is required unless -BuildOnly is used" }

foreach ($p in $Port) {
    Write-Host "==> uploading $Role to $p" -ForegroundColor Cyan
    & $cli upload -p $p -b $fqbn --input-dir $build $sk
    if ($LASTEXITCODE -ne 0) { throw "upload to $p failed" }
}

if ($Role -eq 'chat') {
    Write-Host "==> done. Chat with: python chat.py COM4" -ForegroundColor Green
} elseif ($Role -eq 'tracker') {
    Write-Host "==> done. Watch the boards with: python monitor.py" -ForegroundColor Green
} else {
    Write-Host "==> done. Watch both boards with: python monitor.py" -ForegroundColor Green
}
