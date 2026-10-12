const { execFile } = require('node:child_process');
// Numeric engine totals only. No process names, PIDs or device identifiers leave PowerShell.
const script = String.raw`$ErrorActionPreference='Stop'; $groups=@{};
Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | ForEach-Object {
  if ($_.Name -match '(luid_.+_phys_\d+_eng_\d+)_engtype_(3D|Copy|VideoEncode|VideoDecode|Compute[^_]*)$') {
    $key=$matches[1]+'|'+$matches[2]; $groups[$key]=[double]$groups[$key]+[double]$_.UtilizationPercentage
  }
}; $result=@{}; foreach ($key in $groups.Keys) {
  $kind=$key.Split('|')[1]; if ($kind -like 'Compute*') {$kind='Compute'};
  $result[$kind]=[math]::Max([double]$result[$kind],[math]::Min(100,[double]$groups[$key]))
}; $result | ConvertTo-Json -Compress`;
function sampleGPU(callback) {
  return execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {windowsHide:true,timeout:4000,maxBuffer:16384}, (error, stdout) => {
      if (error) { callback(null); return; }
      try { const values = JSON.parse(stdout), clean = {};
        for (const key of ['3D','Copy','VideoEncode','VideoDecode','Compute']) if (Number.isFinite(values[key]) && values[key]>=0 && values[key]<=100) clean[key] = values[key];
        callback(Object.keys(clean).length ? clean : null);
      } catch { callback(null); }
    });
}
module.exports = { sampleGPU };
