#include "wgc-capture.h"
#include <dwmapi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <stdexcept>
#include <algorithm>

namespace native_video {
using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;

std::vector<WindowInfo> windows() {
  std::vector<WindowInfo> result;
  EnumWindows([](HWND handle, LPARAM data) -> BOOL {
    DWORD pid = 0, cloaked = 0;
    GetWindowThreadProcessId(handle, &pid);
    DwmGetWindowAttribute(handle, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    if (!IsWindowVisible(handle) || cloaked || pid == GetCurrentProcessId() || GetWindowTextLengthW(handle) == 0) return TRUE;
    std::wstring title(static_cast<size_t>(GetWindowTextLengthW(handle)) + 1, L'\0');
    const int length = GetWindowTextW(handle, title.data(), static_cast<int>(title.size()));
    title.resize(static_cast<size_t>(std::max(0, length)));
    if (!title.empty()) reinterpret_cast<std::vector<WindowInfo>*>(data)->push_back({handle, pid, to_string(title)});
    return TRUE;
  }, reinterpret_cast<LPARAM>(&result));
  return result;
}

std::vector<AdapterInfo> adapters() {
  com_ptr<IDXGIFactory1> factory;
  check_hresult(CreateDXGIFactory1(__uuidof(IDXGIFactory1), factory.put_void()));
  std::vector<AdapterInfo> result;
  for (unsigned i = 0;; ++i) {
    com_ptr<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(i, adapter.put()) == DXGI_ERROR_NOT_FOUND) break;
    DXGI_ADAPTER_DESC1 desc{};
    check_hresult(adapter->GetDesc1(&desc));
    const int64_t luid = static_cast<int64_t>((static_cast<uint64_t>(static_cast<uint32_t>(desc.AdapterLuid.HighPart)) << 32) | desc.AdapterLuid.LowPart);
    if (!(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) result.push_back({i, desc.VendorId, desc.DedicatedVideoMemory, to_string(desc.Description), luid});
  }
  return result;
}

com_ptr<ID3D11Device> createDevice(int index, AdapterInfo& selected) {
  const auto choices = adapters();
  if (choices.empty()) throw std::runtime_error("Nenhuma GPU Direct3D11 disponivel.");
  auto choice = index < 0 ? std::max_element(choices.begin(), choices.end(), [](auto& a, auto& b) { return a.memory < b.memory; }) :
    std::find_if(choices.begin(), choices.end(), [index](auto& row) { return row.index == static_cast<unsigned>(index); });
  if (choice == choices.end()) throw std::runtime_error("GPU selecionada nao encontrada.");
  selected = *choice;
  com_ptr<IDXGIFactory1> factory;
  check_hresult(CreateDXGIFactory1(__uuidof(IDXGIFactory1), factory.put_void()));
  com_ptr<IDXGIAdapter1> adapter;
  check_hresult(factory->EnumAdapters1(selected.index, adapter.put()));
  com_ptr<ID3D11Device> device;
  check_hresult(D3D11CreateDevice(adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, nullptr));
  return device;
}

void WgcCapture::start(HWND window, ID3D11Device* d3d) {
  stop();
  if (!GraphicsCaptureSession::IsSupported() || !IsWindow(window) || IsIconic(window))
    throw std::runtime_error("Abra/restaure a janela antes de iniciar a captura WGC.");
  window_ = window;
  GetWindowThreadProcessId(window, &owner_);
  state_ = std::make_shared<SharedState>();
  auto interop = get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  check_hresult(interop->CreateForWindow(window, guid_of<GraphicsCaptureItem>(), put_abi(item_)));
  com_ptr<IDXGIDevice> dxgi;
  check_hresult(d3d->QueryInterface(__uuidof(IDXGIDevice), dxgi.put_void()));
  com_ptr<IInspectable> inspectable;
  check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()));
  device_ = inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
  const auto size = item_.Size();
  width_ = size.Width; height_ = size.Height;
  pool_ = Direct3D11CaptureFramePool::CreateFreeThreaded(device_, DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, size);
  // A revoked callback may already be queued. Its state belongs to this
  // session, so it cannot publish an old frame into a restarted capture or
  // access a destroyed WgcCapture object.
  arrived_ = pool_.FrameArrived([state = state_](auto const& sender, auto const&) {
    try {
      auto frame = sender.TryGetNextFrame();
      if (!frame) return;
      std::lock_guard lock(state->mutex);
      if (state->stopping) { frame.Close(); return; }
      state->received++;
      if (state->latest) { state->latest.Close(); state->superseded++; }
      state->latest = std::move(frame);
    } catch (hresult_error const& failure) { if (!state->stopping) state->error = failure.code(); }
  });
  closedToken_ = item_.Closed([state = state_](auto const&, auto const&) { state->closed = true; });
  session_ = pool_.CreateCaptureSession(item_);
  session_.IsCursorCaptureEnabled(true);
  session_.StartCapture();
}

WgcCapture::Frame WgcCapture::take() {
  std::lock_guard lock(state_->mutex);
  auto frame = std::move(state_->latest);
  state_->latest = nullptr;
  return frame;
}

FrameRegion WgcCapture::clientRegion(int surfaceWidth, int surfaceHeight) const {
  // WGC includes the visible non-client frame. ClientToScreen and DWM bounds
  // use physical coordinates because this helper is per-monitor DPI aware.
  // Resolve them again on every frame: caption/borders can change after
  // maximize, restoring, monitor changes or entering a borderless game mode.
  RECT client{}, bounds{};
  if (!IsWindow(window_) || IsIconic(window_) || !GetClientRect(window_, &client)) return {};
  if (FAILED(DwmGetWindowAttribute(window_, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds))) && !GetWindowRect(window_, &bounds)) return {};
  POINT topLeft{client.left, client.top}, bottomRight{client.right, client.bottom};
  if (!ClientToScreen(window_, &topLeft) || !ClientToScreen(window_, &bottomRight)) return {};
  const int x = std::clamp(static_cast<int>(topLeft.x - bounds.left), 0, surfaceWidth);
  const int y = std::clamp(static_cast<int>(topLeft.y - bounds.top), 0, surfaceHeight);
  const int right = std::clamp(static_cast<int>(bottomRight.x - bounds.left), x, surfaceWidth);
  const int bottom = std::clamp(static_cast<int>(bottomRight.y - bounds.top), y, surfaceHeight);
  return {x, y, right - x, bottom - y};
}

void WgcCapture::resize(int width, int height) {
  if (width <= 0 || height <= 0 || (width == width_ && height == height_)) return;
  { std::lock_guard lock(state_->mutex); if (state_->latest) { state_->latest.Close(); state_->latest = nullptr; state_->superseded++; } }
  pool_.Recreate(device_, DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, {width, height});
  width_ = width; height_ = height;
}

void WgcCapture::stop() {
  state_->stopping = true;
  // Do not hold the callback mutex while revoking/closing the free-threaded pool.
  if (pool_) { try { pool_.FrameArrived(arrived_); } catch (...) {} }
  if (item_) { try { item_.Closed(closedToken_); } catch (...) {} }
  // WGC may wait for outstanding capture frames during Close. Release the
  // mailbox before closing the session/pool, including when the source exited.
  { std::lock_guard lock(state_->mutex); if (state_->latest) { state_->latest.Close(); state_->latest = nullptr; } }
  if (session_) { try { session_.Close(); } catch (...) {} session_ = nullptr; }
  if (pool_) { try { pool_.Close(); } catch (...) {} pool_ = nullptr; }
  item_ = nullptr; device_ = nullptr; window_ = nullptr; owner_ = 0;
}
}
