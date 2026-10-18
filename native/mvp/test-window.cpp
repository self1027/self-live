// Real moving Win32 window used only by the WGC integration test. No synthetic
// MediaStream or Chromium capture API is involved in the test video path.
#include <windows.h>
#include <algorithm>
#include <iostream>
#include <string>
#include <thread>
#include <mmsystem.h>
static HWND sourceWindow;
static LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_TIMER) { InvalidateRect(window, nullptr, FALSE); return 0; }
  if (message == WM_PAINT) {
    PAINTSTRUCT paint{}; HDC dc = BeginPaint(window, &paint); RECT rect{}; GetClientRect(window, &rect);
    const auto elapsed = GetTickCount64();
    HBRUSH background = CreateSolidBrush(RGB(20, 45, 65)); FillRect(dc, &rect, background); DeleteObject(background);
    const int x = static_cast<int>(elapsed / 4 % static_cast<ULONGLONG>(std::max(1L, rect.right)));
    RECT moving{x, 40, x + 120, rect.bottom}; HBRUSH bar = CreateSolidBrush(RGB(70, 225, 160)); FillRect(dc, &moving, bar); DeleteObject(bar);
    SetBkMode(dc, TRANSPARENT); SetTextColor(dc, RGB(240, 245, 255));
    const std::wstring text = L"WGC C++ integration test / frame " + std::to_wstring(elapsed);
    TextOutW(dc, 18, 15, text.c_str(), static_cast<int>(text.size()));
    EndPaint(window, &paint); return 0;
  }
  if (message == WM_APP + 1) { ShowWindow(window, SW_MINIMIZE); return 0; }
  if (message == WM_APP + 2) { ShowWindow(window, SW_SHOWNOACTIVATE); return 0; }
  if (message == WM_APP + 3) { SetWindowPos(window, nullptr, 0, 0, 1200, 750, SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOZORDER); return 0; }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(window, message, wparam, lparam);
}
int main() {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  timeBeginPeriod(1);
  WNDCLASSW type{}; type.lpfnWndProc = procedure; type.hInstance = GetModuleHandle(nullptr); type.lpszClassName = L"SelfLiveNativeMvpTest";
  RegisterClassW(&type);
  sourceWindow = CreateWindowW(type.lpszClassName, L"SelfLive Native MVP source test", WS_OVERLAPPEDWINDOW, 40, 40, 960, 540, nullptr, nullptr, type.hInstance, nullptr);
  if (!sourceWindow) return 1;
  ShowWindow(sourceWindow, SW_SHOWNOACTIVATE); SetTimer(sourceWindow, 1, 16, nullptr);
  RECT client{}; GetClientRect(sourceWindow, &client);
  std::cout << "{\"window\":\"" << reinterpret_cast<uintptr_t>(sourceWindow) << "\",\"clientWidth\":" << client.right << ",\"clientHeight\":" << client.bottom << "}" << std::endl;
  std::thread([] { std::string command; while (std::getline(std::cin, command)) {
    if (command == "minimize") PostMessage(sourceWindow, WM_APP + 1, 0, 0);
    else if (command == "restore") PostMessage(sourceWindow, WM_APP + 2, 0, 0);
    else if (command == "resize") PostMessage(sourceWindow, WM_APP + 3, 0, 0);
    else if (command == "close") break;
  } PostMessage(sourceWindow, WM_CLOSE, 0, 0); }).detach();
  MSG message{}; while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
  timeEndPeriod(1);
}
