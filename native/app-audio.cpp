// Windows process-loopback. stdout: signed PCM16 stereo, 48 kHz. No system mix.
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <wrl.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <string>
#include <vector>
#include <set>
using Microsoft::WRL::ComPtr;
class Completion : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  volatile LONG refs = 1;
public:
  HANDLE event = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  ComPtr<IAudioClient> client;
  ~Completion() { CloseHandle(event); }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs); }
  ULONG STDMETHODCALLTYPE Release() override { LONG n = InterlockedDecrement(&refs); if (!n) delete this; return n; }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (id == __uuidof(IUnknown) || id == __uuidof(IActivateAudioInterfaceCompletionHandler)) *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    else if (id == __uuidof(IAgileObject)) *out = static_cast<IAgileObject*>(this);
    else return E_NOINTERFACE;
    AddRef(); return S_OK;
  }
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    ComPtr<IUnknown> unknown;
    HRESULT activation = E_FAIL;
    result = operation->GetActivateResult(&activation, &unknown);
    if (SUCCEEDED(result)) result = activation;
    if (SUCCEEDED(result)) result = unknown.As(&client);
    SetEvent(event); return S_OK;
  }
};
int fail(HRESULT hr) { fprintf(stderr, "error:%08lx\n", static_cast<unsigned long>(hr)); return 1; }
struct WindowCount { DWORD pid; int count = 0; };
BOOL CALLBACK countWindows(HWND window, LPARAM data) {
  auto state = reinterpret_cast<WindowCount*>(data);
  DWORD pid; GetWindowThreadProcessId(window, &pid);
  if (pid == state->pid && IsWindowVisible(window) && GetWindowTextLength(window) > 0 && !GetWindow(window, GW_OWNER)) state->count++;
  return TRUE;
}
int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && wcscmp(argv[1], L"sessions") == 0) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return fail(hr);
    ComPtr<IMMDeviceEnumerator> enumerator;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) return fail(hr);
    ComPtr<IMMDeviceCollection> devices;
    hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices);
    if (FAILED(hr)) return fail(hr);
    std::set<DWORD> pids; UINT count = 0; devices->GetCount(&count);
    for (UINT i = 0; i < count; i++) {
      ComPtr<IMMDevice> device; ComPtr<IAudioSessionManager2> manager; ComPtr<IAudioSessionEnumerator> sessions;
      if (FAILED(devices->Item(i, &device)) || FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager)) || FAILED(manager->GetSessionEnumerator(&sessions))) return fail(E_FAIL);
      int size = 0; sessions->GetCount(&size);
      for (int j = 0; j < size; j++) {
        ComPtr<IAudioSessionControl> control; ComPtr<IAudioSessionControl2> info;
        DWORD pid = 0;
        if (SUCCEEDED(sessions->GetSession(j, &control)) && SUCCEEDED(control.As(&info)) && SUCCEEDED(info->GetProcessId(&pid)) && pid) pids.insert(pid);
      }
    }
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return fail(E_FAIL);
    printf("{\"processes\":[");
    PROCESSENTRY32 entry{}; entry.dwSize = sizeof(entry); bool first = true;
    for (BOOL ok = Process32First(snapshot, &entry); ok; ok = Process32Next(snapshot, &entry)) {
      char name[2048]; int bytes = WideCharToMultiByte(CP_UTF8, 0, entry.szExeFile, -1, name, sizeof(name), nullptr, nullptr);
      if (!bytes) continue;
      if (!first) printf(","); first = false;
      printf("{\"pid\":%lu,\"parent\":%lu,\"executable\":\"", entry.th32ProcessID, entry.th32ParentProcessID);
      for (int k = 0; k < bytes - 1; k++) { unsigned char ch = name[k]; if (ch == '\\' || ch == '"') putchar('\\'); if (ch < 32) printf("\\u%04x", ch); else putchar(ch); }
      printf("\"}");
    }
    CloseHandle(snapshot); printf("],\"sessions\":["); first = true;
    for (DWORD pid : pids) { if (!first) printf(","); first = false; printf("%lu", pid); }
    printf("]}"); return 0;
  }
  if (argc < 3 || argc > 4) return 2;
  if (wcscmp(argv[1], L"resolve") == 0) {
    HWND window = reinterpret_cast<HWND>(_wcstoui64(argv[2], nullptr, 10));
    DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
    if (!IsWindow(window) || !pid) return 3;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return 3;
    wchar_t filename[32768]; DWORD length = 32768;
    bool ok = QueryFullProcessImageName(process, 0, filename, &length); CloseHandle(process);
    if (!ok) return 3;
    std::wstring full(filename, length);
    std::wstring name = full.substr(full.find_last_of(L"\\/") + 1);
    // Process executable basename only; no user profile paths leave the helper.
    char utf8[2048]; int bytes = WideCharToMultiByte(CP_UTF8, 0, name.data(), static_cast<int>(name.size()), utf8, sizeof(utf8), nullptr, nullptr);
    WindowCount windows{pid}; EnumWindows(countWindows, reinterpret_cast<LPARAM>(&windows));
    printf("%lu\n%d\n", pid, windows.count); fwrite(utf8, 1, bytes, stdout); return 0;
  }
  if (wcscmp(argv[1], L"capture") != 0 || argc != 4) return 2;
  DWORD pid = wcstoul(argv[2], nullptr, 10);
  HWND selected = reinterpret_cast<HWND>(_wcstoui64(argv[3], nullptr, 10)); // 0 = explicit whole-app capture
  if (!pid) return 2;
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail(hr);
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT variant{}; variant.vt = VT_BLOB;
  variant.blob.cbSize = sizeof(params); variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
  ComPtr<Completion> completion; completion.Attach(new Completion());
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &variant, completion.Get(), &operation);
  if (FAILED(hr)) return fail(hr);
  if (WaitForSingleObject(completion->event, 5000) != WAIT_OBJECT_0) return fail(E_ABORT);
  if (FAILED(completion->result)) return fail(completion->result);
  auto client = completion->client;
  WAVEFORMATEX format{WAVE_FORMAT_PCM, 2, 48000, 192000, 4, 16, 0};
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 200000, 0, &format, nullptr);
  if (FAILED(hr)) return fail(hr);
  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(IID_PPV_ARGS(&capture));
  if (FAILED(hr)) return fail(hr);
  hr = client->Start(); if (FAILED(hr)) return fail(hr);
  _setmode(_fileno(stdout), _O_BINARY);
  fprintf(stderr, "ready\n"); fflush(stderr);
  HANDLE target = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (!target) return fail(E_ACCESSDENIED);
  ULONGLONG lastCheck = 0;
  while (WaitForSingleObject(target, 5) == WAIT_TIMEOUT) {
    if (GetTickCount64() - lastCheck >= 250) {
      lastCheck = GetTickCount64();
      DWORD owner = 0; GetWindowThreadProcessId(selected, &owner);
      WindowCount windows{pid}; EnumWindows(countWindows, reinterpret_cast<LPARAM>(&windows));
      // Fail closed if the selected window vanishes or a second window appears.
      if (selected && (!IsWindow(selected) || owner != pid || windows.count != 1)) break;
    }
    UINT32 available = 0;
    hr = capture->GetNextPacketSize(&available); if (FAILED(hr)) break;
    while (available) {
      BYTE* data; UINT32 frames; DWORD flags; UINT64 qpc;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, &qpc); if (FAILED(hr)) break;
      if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) { capture->ReleaseBuffer(frames); hr = E_FAIL; break; }
      std::vector<BYTE> silence;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { silence.resize(frames * 4); data = silence.data(); }
      const size_t bytes = frames * 4;
      // Framed PCM: little-endian byte count (4), shared QPC timestamp/100ns (8), payload.
      const UINT32 length = static_cast<UINT32>(bytes);
      bool written = fwrite(&length, 1, 4, stdout) == 4 && fwrite(&qpc, 1, 8, stdout) == 8 && fwrite(data, 1, bytes, stdout) == bytes;
      capture->ReleaseBuffer(frames); fflush(stdout);
      if (!written) { client->Stop(); CloseHandle(target); return 0; }
      hr = capture->GetNextPacketSize(&available); if (FAILED(hr)) break;
    }
    if (FAILED(hr)) break;
  }
  client->Stop(); CloseHandle(target); return FAILED(hr) ? fail(hr) : 0;
}

