$ErrorActionPreference = "Stop"

function Fail([string] $message) {
  Write-Error $message
  exit 1
}

function Test-ListeningPort([int] $port) {
  $matches = @(netstat -ano -p TCP | Select-String -Pattern "^\s*TCP\s+\S+:$port\s+\S+\s+LISTENING\s+\d+\s*$")
  return $matches.Count -gt 0
}

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
  Fail "adb was not found on PATH. Install Android platform-tools or add the Android SDK platform-tools directory to PATH."
}

$connectedDevices = @(
  & adb devices | Select-String -Pattern "\sdevice$"
)

if ($connectedDevices.Count -eq 0) {
  Fail "No Android device is connected. Connect the phone over USB, enable USB debugging, accept the RSA prompt, and run npm run start:e2e again."
}

& adb reverse tcp:8080 tcp:8080
if ($LASTEXITCODE -ne 0) {
  Fail "Could not reverse backend port 8080 through adb. Check that the connected device is authorized."
}

$metroPort = 8082
if (Test-ListeningPort $metroPort) {
  $metroPort = 8083
  if (Test-ListeningPort $metroPort) {
    Fail "Metro ports 8082 and 8083 are already in use. Stop the old Expo/Metro process and run npm run start:e2e again."
  }
  Write-Host "Metro port 8082 is already in use; using localhost port 8083 instead."
}

& adb reverse "tcp:$metroPort" "tcp:$metroPort"
if ($LASTEXITCODE -ne 0) {
  Fail "Could not reverse Metro port $metroPort through adb. Check that the connected device is authorized."
}

$mobileRoot = Split-Path -Parent $PSScriptRoot
$expoCommand = Join-Path $mobileRoot "node_modules\.bin\expo.cmd"
if (-not (Test-Path $expoCommand)) {
  Fail "Expo was not found at $expoCommand. Run npm install in the mobile directory first."
}

# The Android app resolves localhost through adb reverse, so neither Metro nor
# the local API needs to be exposed on the LAN or the public internet.
$env:EXPO_PUBLIC_API_URL = "http://127.0.0.1:8080"
$env:EXPO_PUBLIC_WS_URL = "ws://127.0.0.1:8080"
# Expo's localhost mode binds to IPv6 (::1) on some Windows setups. LAN mode
# binds IPv4 as well, while this hostname keeps the generated device URL on
# localhost so adb reverse remains the only network path.
$env:REACT_NATIVE_PACKAGER_HOSTNAME = "127.0.0.1"

Write-Host "USB E2E mode enabled. Forwarded API :8080 and Metro :$metroPort."
Write-Host "Keep the server running on the host at http://127.0.0.1:8080."
Write-Host "Starting Expo with a localhost device URL; the development build will open on the phone."

Push-Location $mobileRoot
try {
  & $expoCommand start --host lan --port $metroPort --dev-client --android
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
