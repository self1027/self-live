$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$dependencyRoot = Join-Path $projectRoot '.native-deps'
$sdkRoot = Join-Path $dependencyRoot 'gstreamer'
if (Test-Path -LiteralPath "$sdkRoot\include\gstreamer-1.0\gst\gst.h") {
  Write-Output "GStreamer pronto: $sdkRoot"
  exit 0
}
New-Item -ItemType Directory -Force -Path $dependencyRoot | Out-Null
$installer = Join-Path $dependencyRoot 'gstreamer-1.28.8.exe'
$expectedHash = 'e4c41ee6ee9c6c32a45d198463ec08d79bac3bd5fa58adc93d13fe4a08abc9d9'
if (!(Test-Path -LiteralPath $installer) -or (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
  & curl.exe --fail --location --retry 3 --output $installer 'https://gstreamer.freedesktop.org/pkg/windows/1.28.8/msvc/gstreamer-1.0-msvc-x86_64-1.28.8.exe'
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar GStreamer.' }
}
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
  throw 'O SHA-256 do SDK nao corresponde ao pacote oficial.'
}
# The upstream installer explicitly supports /portable=1: no registry, global
# environment, VS templates, uninstall registration or VC redistributable install.
$arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/portable=1', '/TYPE=devel', '/NOICONS', "/DIR=`"$sdkRoot`"", "/LOG=`"$dependencyRoot\gstreamer-setup.log`"")
$setupProcess = Start-Process -FilePath $installer -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
if ($setupProcess.ExitCode -ne 0 -or !(Test-Path -LiteralPath "$sdkRoot\include\gstreamer-1.0\gst\gst.h")) {
  throw "Falha ao extrair SDK (codigo $($setupProcess.ExitCode)). Veja .native-deps/gstreamer-setup.log."
}
Write-Output "GStreamer pronto: $sdkRoot"
