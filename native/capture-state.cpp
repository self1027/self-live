#include <windows.h>
#include <cstdio>
#include <cstdlib>

// Receives only the HWND from the source already selected in Electron. No
// titles, paths or foreground application identifiers are returned to the UI.
int main(int argc, char** argv) {
    if (argc != 2) return 2;
    char* end = nullptr;
    const unsigned long long value = std::strtoull(argv[1], &end, 10);
    if (!value || *end) return 2;
    const HWND window = reinterpret_cast<HWND>(static_cast<ULONG_PTR>(value));
    if (!IsWindow(window)) {
        std::puts("{\"available\":true,\"exists\":false}"); return 0;
    }
    DWORD owner = 0, foregroundOwner = 0;
    GetWindowThreadProcessId(window, &owner);
    const HWND foreground = GetForegroundWindow();
    GetWindowThreadProcessId(foreground, &foregroundOwner);
    const bool focused = window == foreground || IsChild(window, foreground) || (owner && owner == foregroundOwner);
    std::printf("{\"available\":true,\"exists\":true,\"owner\":%lu,\"minimized\":%s,\"visible\":%s,\"focused\":%s}\n",
        owner, IsIconic(window) ? "true" : "false", IsWindowVisible(window) ? "true" : "false", focused ? "true" : "false");
    return 0;
}
