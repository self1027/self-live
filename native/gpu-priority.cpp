#include <windows.h>
#include <d3dkmthk.h>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>

// One helper holds one process handle and its original GPU priority. Closing
// stdin (including parent termination) restores it without relying on PID reuse.
static void report(const char* phase, DWORD pid, const char* status,
    int original = -1, int effective = -1, NTSTATUS result = 0, DWORD win32 = 0) {
    std::printf("{\"phase\":\"%s\",\"pid\":%lu,\"status\":\"%s\",\"original\":%d,"
        "\"requested\":%d,\"effective\":%d,\"ntstatus\":\"0x%08lX\",\"win32Error\":%lu}\n",
        phase, pid, status, original, std::string(phase) == "restore" ? original : 4,
        effective, static_cast<unsigned long>(result), win32);
    std::fflush(stdout);
}

int main(int argc, char** argv) {
    if (argc != 3) return 2;
    char* end = nullptr;
    const unsigned long parsed = std::strtoul(argv[1], &end, 10);
    if (!parsed || *end) return 2;
    const DWORD pid = static_cast<DWORD>(parsed);
    const unsigned long long expectedMs = std::strtoull(argv[2], &end, 10);
    if (!expectedMs || *end) return 2;
    HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (!process) { report("apply", pid, "open_failed", -1, -1, 0, GetLastError()); return 1; }
    FILETIME created, exited, kernel, user;
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) {
        report("apply", pid, "identity_failed", -1, -1, 0, GetLastError()); CloseHandle(process); return 1;
    }
    ULARGE_INTEGER ticks; ticks.LowPart = created.dwLowDateTime; ticks.HighPart = created.dwHighDateTime;
    const unsigned long long actualMs = (ticks.QuadPart - 116444736000000000ULL) / 10000;
    if (actualMs > expectedMs + 2 || expectedMs > actualMs + 2) {
        report("apply", pid, "identity_mismatch"); CloseHandle(process); return 1;
    }
    D3DKMT_SCHEDULINGPRIORITYCLASS original, effective;
    NTSTATUS result = D3DKMTGetProcessSchedulingPriorityClass(process, &original);
    if (result < 0) { report("apply", pid, "query_failed", -1, -1, result); CloseHandle(process); return 1; }
    if (original >= D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH) {
        report("apply", pid, "already_high", original, original); CloseHandle(process); return 0;
    }
    result = D3DKMTSetProcessSchedulingPriorityClass(process, D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH);
    if (result < 0) { report("apply", pid, "set_failed", original, original, result); CloseHandle(process); return 1; }
    result = D3DKMTGetProcessSchedulingPriorityClass(process, &effective);
    if (result < 0 || effective != D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH) {
        report("apply", pid, "verify_failed", original, result < 0 ? -1 : effective, result);
        NTSTATUS rollback = D3DKMTSetProcessSchedulingPriorityClass(process, original);
        if (rollback < 0) report("restore", pid, "restore_failed", original, -1, rollback);
        else {
            rollback = D3DKMTGetProcessSchedulingPriorityClass(process, &effective);
            report("restore", pid, rollback >= 0 && effective == original ? "restored" : "verify_failed",
                original, rollback < 0 ? -1 : effective, rollback);
        }
        CloseHandle(process); return 1;
    }
    report("apply", pid, "applied", original, effective);
    std::string command;
    std::getline(std::cin, command); // EOF also restores; no renderer-controlled commands.
    if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
        report("restore", pid, "process_exited", original);
    } else {
        result = D3DKMTGetProcessSchedulingPriorityClass(process, &effective);
        if (result < 0) report("restore", pid, "query_failed", original, -1, result);
        else if (effective != D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH)
            report("restore", pid, "externally_changed", original, effective);
        else {
            result = D3DKMTSetProcessSchedulingPriorityClass(process, original);
            if (result < 0) report("restore", pid, "restore_failed", original, effective, result);
            else {
                result = D3DKMTGetProcessSchedulingPriorityClass(process, &effective);
                report("restore", pid, result >= 0 && effective == original ? "restored" : "verify_failed",
                    original, result < 0 ? -1 : effective, result);
            }
        }
    }
    CloseHandle(process);
    return 0;
}
