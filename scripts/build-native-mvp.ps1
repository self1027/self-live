$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$sdkRoot = Join-Path $projectRoot '.native-deps\gstreamer'
if (!(Test-Path -LiteralPath "$sdkRoot\include\gstreamer-1.0\gst\gst.h")) {
  throw 'Execute npm run setup:native-mvp para preparar o SDK local.'
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw 'Instale Visual Studio Build Tools com Desktop development with C++ e Windows SDK.' }
$vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
$output = Join-Path $projectRoot 'native\bin'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$sourceRoot = Join-Path $projectRoot 'native\mvp'
$includes = @('include\gstreamer-1.0', 'include\glib-2.0', 'lib\glib-2.0\include', 'lib\gstreamer-1.0\include') | ForEach-Object { '/I"' + (Join-Path $sdkRoot $_) + '"' }
$compile = "`"$vcvars`" && cl /nologo /EHsc /std:c++20 /W4 /MD /O2 /utf-8 /DWIN32_LEAN_AND_MEAN /DNOMINMAX /DGST_USE_UNSTABLE_API $($includes -join ' ') `"$sourceRoot\wgc-capture.cpp`" `"$sourceRoot\main.cpp`" /Fe:`"$output\native-video.exe`" /Fo:`"$output\\`" /link /LIBPATH:`"$sdkRoot\lib`" gstreamer-1.0.lib gstapp-1.0.lib gstvideo-1.0.lib gstd3d11-1.0.lib gstwebrtc-1.0.lib gstsdp-1.0.lib gobject-2.0.lib glib-2.0.lib d3d11.lib dxgi.lib windowsapp.lib user32.lib dwmapi.lib winmm.lib gdi32.lib pdh.lib"
& cmd.exe /d /s /c $compile
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar motor nativo de video.' }
$fixtureCompile = "`"$vcvars`" && cl /nologo /EHsc /std:c++20 /W4 /MD /O2 /DWIN32_LEAN_AND_MEAN /DNOMINMAX `"$sourceRoot\test-window.cpp`" /Fe:`"$output\native-mvp-test-window.exe`" /Fo:`"$output\native-mvp-test-window.obj`" /link user32.lib gdi32.lib winmm.lib"
& cmd.exe /d /s /c $fixtureCompile
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar janela de teste.' }
