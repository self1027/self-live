$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw 'Instale Visual Studio Build Tools com Desktop development with C++.' }
$vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
$output = Join-Path $projectRoot 'native\bin'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$source = Join-Path $projectRoot 'native\gpu-priority.cpp'
$compile = "`"$vcvars`" && cl /nologo /EHsc /std:c++17 /W4 /MT /DUNICODE /D_UNICODE `"$source`" /Fe:`"$output\gpu-priority.exe`" /Fo:`"$output\gpu-priority.obj`" /link gdi32.lib"
& cmd.exe /d /s /c $compile
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar prioridade de GPU.' }
