#pragma once
#include <windows.h>
#include <pdh.h>
#include <pdhmsg.h>
#include <algorithm>
#include <cmath>
#include <cwctype>
#include <condition_variable>
#include <map>
#include <mutex>
#include <sstream>
#include <thread>
#include <vector>

// PDH sampling runs outside the capture/encoding threads. The scope is the
// selected DXGI LUID, rather than the busiest engine on an unrelated GPU.
class GpuLoad {
  struct Sample { bool available = false, has3D = false, hasCopy = false, hasEncode = false, hasDecode = false, hasCodec = false; double threeD = 0, copy = 0, encode = 0, decode = 0, codec = 0, native3D = 0; };
  Sample sample_;
  std::mutex mutex_, waitMutex_;
  std::condition_variable_any wake_;
  std::jthread worker_;
public:
  void stop() {
    if (worker_.joinable()) { worker_.request_stop(); wake_.notify_all(); worker_.join(); }
    std::lock_guard lock(mutex_); sample_ = {};
  }
  void start(int64_t selectedLuid) {
    stop();
    worker_ = std::jthread([this, selectedLuid](std::stop_token stop) {
      PDH_HQUERY query = nullptr; PDH_HCOUNTER counter = nullptr;
      if (PdhOpenQueryW(nullptr, 0, &query) != ERROR_SUCCESS) return;
      if (PdhAddEnglishCounterW(query, L"\\GPU Engine(*)\\Utilization Percentage", 0, &counter) != ERROR_SUCCESS) { PdhCloseQuery(query); return; }
      PdhCollectQueryData(query);
      while (!stop.stop_requested()) {
        { std::unique_lock lock(waitMutex_); wake_.wait_for(lock, stop, std::chrono::seconds(1), [] { return false; }); }
        if (stop.stop_requested()) break;
        Sample current;
        if (PdhCollectQueryData(query) == ERROR_SUCCESS) {
          DWORD bytes = 0, count = 0;
          if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &bytes, &count, nullptr) == PDH_MORE_DATA && bytes <= 16 * 1024 * 1024) {
            std::vector<BYTE> storage(bytes);
            auto rows = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(storage.data());
            if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &bytes, &count, rows) == ERROR_SUCCESS) {
              std::map<std::pair<std::wstring,uint64_t>,double> totals;
              for (DWORD i = 0; i < count; ++i) {
                DWORD pid = 0, high = 0, low = 0; unsigned physical = 0, engine = 0;
                if (swscanf_s(rows[i].szName, L"pid_%lu_luid_0x%lx_0x%lx_phys_%u_eng_%u", &pid, &high, &low, &physical, &engine) != 5) continue;
                const auto marker = wcsstr(rows[i].szName, L"_engtype_"); if (!marker) continue;
                std::wstring type(marker + 9);
                type.erase(std::remove_if(type.begin(),type.end(),[](wchar_t c) { return std::iswspace(c); }),type.end());
                if (((static_cast<uint64_t>(high) << 32) | low) != static_cast<uint64_t>(selectedLuid)) continue;
                if (rows[i].FmtValue.CStatus != PDH_CSTATUS_VALID_DATA && rows[i].FmtValue.CStatus != PDH_CSTATUS_NEW_DATA) continue;
                const double usage = rows[i].FmtValue.doubleValue;
                if (!std::isfinite(usage) || usage < 0) continue;
                current.available = true;
                totals[{type,(static_cast<uint64_t>(physical) << 32) | engine}] += usage;
                if (pid == GetCurrentProcessId() && type == L"3D") current.native3D += usage;
              }
              for (const auto& [key,value] : totals) {
                const double usage = std::min(100.0,value);
                if (key.first == L"3D") { current.has3D = true; current.threeD = std::max(current.threeD,usage); }
                else if (key.first == L"Copy") { current.hasCopy = true; current.copy = std::max(current.copy,usage); }
                else if (key.first.rfind(L"VideoEncode",0) == 0) { current.hasEncode = true; current.encode = std::max(current.encode,usage); }
                else if (key.first.rfind(L"VideoDecode",0) == 0) { current.hasDecode = true; current.decode = std::max(current.decode,usage); }
                else if (key.first.rfind(L"VideoCodec",0) == 0) { current.hasCodec = true; current.codec = std::max(current.codec,usage); }
              }
              current.native3D = std::min(100.0,current.native3D);
            }
          }
        }
        { std::lock_guard lock(mutex_); sample_ = current; }
      }
      PdhCloseQuery(query);
    });
  }
  std::string json() {
    std::lock_guard lock(mutex_);
    if (!sample_.available) return "{\"available\":false,\"scope\":\"selected_adapter\"}";
    const auto value = [](bool present,double usage) { return present ? std::to_string(usage) : "null"; };
    std::ostringstream out; out << "{\"available\":true,\"scope\":\"selected_adapter\",\"threeD\":" << value(sample_.has3D,sample_.threeD) << ",\"copy\":" << value(sample_.hasCopy,sample_.copy)
      << ",\"videoEncode\":" << value(sample_.hasEncode,sample_.encode) << ",\"videoDecode\":" << value(sample_.hasDecode,sample_.decode) << ",\"videoCodec\":" << value(sample_.hasCodec,sample_.codec) << ",\"native3D\":" << value(sample_.has3D,sample_.native3D) << '}'; return out.str();
  }
  ~GpuLoad() { stop(); }
};
