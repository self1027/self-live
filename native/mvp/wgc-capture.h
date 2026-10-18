#pragma once
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_6.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <atomic>
#include <mutex>
#include <memory>
#include <string>
#include <vector>

namespace native_video {
struct WindowInfo { HWND handle; DWORD pid; std::string title; };
struct AdapterInfo { unsigned index; unsigned vendor; unsigned long long memory; std::string name; int64_t luid; };
struct FrameRegion { int x = 0, y = 0, width = 0, height = 0; };
std::vector<WindowInfo> windows();
std::vector<AdapterInfo> adapters();
winrt::com_ptr<ID3D11Device> createDevice(int index, AdapterInfo& selected);

// The only screen capture implementation used by this experiment. The callback
// replaces a single pending WGC frame; it never waits for the encoder or JS.
class WgcCapture {
  using Frame = winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame;
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool pool_{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureSession session_{nullptr};
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice device_{nullptr};
  winrt::event_token arrived_{}, closedToken_{};
  struct SharedState {
    std::mutex mutex;
    Frame latest{nullptr};
    std::atomic<uint64_t> received{0}, superseded{0};
    std::atomic<bool> stopping{false}, closed{false};
    std::atomic<long> error{0};
  };
  std::shared_ptr<SharedState> state_ = std::make_shared<SharedState>();
  HWND window_ = nullptr;
  DWORD owner_ = 0;
  int width_ = 0, height_ = 0;
public:
  uint64_t received() const { return state_->received.load(); }
  uint64_t superseded() const { return state_->superseded.load(); }
  bool closed() const { return state_->closed.load(); }
  long error() const { return state_->error.load(); }
  void start(HWND window, ID3D11Device* device);
  Frame take();
  FrameRegion clientRegion(int surfaceWidth, int surfaceHeight) const;
  void resize(int width, int height);
  void stop();
  HWND window() const { return window_; }
  DWORD owner() const { return owner_; }
  int width() const { return width_; }
  int height() const { return height_; }
  ~WgcCapture() { stop(); }
};
}
