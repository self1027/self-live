#include <windows.h>
#include <winternl.h>
#include <d3dkmthk.h>
#include "wgc-capture.h"
#include "gpu-load.h"
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Data.Json.h>
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <gst/d3d11/gstd3d11.h>
#include <gst/webrtc/webrtc.h>
#include <gst/sdp/sdp.h>
#include <mmsystem.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <thread>

using namespace native_video;
using namespace winrt::Windows::Data::Json;
using winrt::to_string;
static std::mutex outputMutex;
static std::string jsonString(const std::string& value) {
  std::ostringstream result; result << '"';
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') result << '\\' << c;
    else if (c < 32) { const char hex[] = "0123456789abcdef"; result << "\\u00" << hex[c >> 4] << hex[c & 15]; }
    else result << c;
  }
  result << '"'; return result.str();
}
static void emit(const std::string& object) { std::lock_guard lock(outputMutex); std::cout << object << '\n' << std::flush; }
static void response(int id, const std::string& fields = "") {
  emit("{\"type\":\"response\",\"id\":" + std::to_string(id) + ",\"ok\":true" + fields + "}");
}
static uint64_t nowNs() {
  LARGE_INTEGER ticks, frequency; QueryPerformanceCounter(&ticks); QueryPerformanceFrequency(&frequency);
  return gst_util_uint64_scale(static_cast<uint64_t>(ticks.QuadPart), GST_SECOND, static_cast<uint64_t>(frequency.QuadPart));
}
static double percentile(std::vector<double> values, double fraction) {
  if (values.empty()) return 0;
  std::sort(values.begin(), values.end()); return values[static_cast<size_t>((values.size() - 1) * fraction)];
}
static GstClockTime runningTime(GstPad* pad, GstBuffer* buffer) {
  GstClockTime time = GST_BUFFER_PTS(buffer);
  GstEvent* event = gst_pad_get_sticky_event(pad, GST_EVENT_SEGMENT, 0);
  if (event) { const GstSegment* segment = nullptr; gst_event_parse_segment(event, &segment);
    if (segment && segment->format == GST_FORMAT_TIME) time = gst_segment_to_running_time(segment, GST_FORMAT_TIME, time);
    gst_event_unref(event); }
  return time;
}
static std::string text(JsonObject const& object, const wchar_t* key, const wchar_t* fallback = L"") {
  return to_string(object.GetNamedString(key, fallback));
}
static int number(JsonObject const& object, const wchar_t* key, int fallback) {
  const double value = object.GetNamedNumber(key, fallback);
  if (!std::isfinite(value) || std::floor(value) != value || value < -1 || value > 1000000000) throw std::runtime_error("Parametro numerico invalido.");
  return static_cast<int>(value);
}

struct TextureSlot { winrt::com_ptr<ID3D11Texture2D> texture; std::atomic<bool> busy{false}; int width = 0, height = 0; };
struct PeerContext { GstElement* peer; unsigned generation; std::atomic<bool> live{true}, offered{false};
  ~PeerContext() { gst_object_unref(peer); } };
using PeerRef = std::shared_ptr<PeerContext>;
static void deletePeerRef(gpointer data) { delete static_cast<PeerRef*>(data); }
static void onOffer(GstPromise* promise, gpointer data) {
  const auto context = *static_cast<PeerRef*>(data);
  if (gst_promise_wait(promise) == GST_PROMISE_RESULT_REPLIED && context->live) {
    GstWebRTCSessionDescription* offer = nullptr;
    const GstStructure* reply = gst_promise_get_reply(promise);
    if (reply && gst_structure_get(reply, "offer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &offer, nullptr) && offer) {
      g_signal_emit_by_name(context->peer, "set-local-description", offer, nullptr);
      gchar* sdp = gst_sdp_message_as_text(offer->sdp);
      emit("{\"type\":\"offer\",\"generation\":" + std::to_string(context->generation) + ",\"sdp\":" + jsonString(sdp) + "}");
      g_free(sdp); gst_webrtc_session_description_free(offer);
    }
  }
  gst_promise_unref(promise);
}
static void onNegotiation(GstElement*, gpointer data) {
  auto context = *static_cast<PeerRef*>(data);
  if (!context->live || context->offered.exchange(true)) return;
  GstPromise* promise = gst_promise_new_with_change_func(onOffer, new PeerRef(context), deletePeerRef);
  g_signal_emit_by_name(context->peer, "create-offer", nullptr, promise);
}
static void onIce(GstElement*, guint index, gchar* candidate, gpointer data) {
  const auto context = *static_cast<PeerRef*>(data);
  if (context->live) emit("{\"type\":\"ice\",\"generation\":" + std::to_string(context->generation) + ",\"sdpMLineIndex\":" + std::to_string(index) + ",\"candidate\":" + jsonString(candidate) + "}");
}

class Engine {
  GMainLoop* loop_;
  WgcCapture capture_;
  GpuLoad gpuLoad_;
  AdapterInfo adapter_{};
  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext> deviceContext_;
  GstD3D11Device* gstDevice_ = nullptr;
  GstElement *pipeline_ = nullptr, *source_ = nullptr, *encoder_ = nullptr, *peer_ = nullptr;
  PeerRef peerContext_;
  std::array<std::shared_ptr<TextureSlot>, 4> slots_;
  GstBuffer* previous_ = nullptr;
  std::vector<WindowInfo> choices_;
  bool active_ = false, priorityChanged_ = false;
  int fps_ = 60, width_ = 0, height_ = 0, sourceWidth_ = 0, sourceHeight_ = 0, bitrate_ = 8000;
  std::string encoderName_;
  D3DKMT_SCHEDULINGPRIORITYCLASS originalPriority_{};
  unsigned generation_ = 0;
  uint64_t epoch_ = 0, nextPush_ = 0, lastFresh_ = 0, lastStats_ = 0, lastCaptureCount_ = 0, lastSubmitted_ = 0, lastEncoded_ = 0;
  uint64_t submitted_ = 0, poolDrops_ = 0, repeats_ = 0, gpuCopies_ = 0;
  std::atomic<uint64_t> encoded_{0}, encodedBytes_{0};
  std::mutex timingsMutex_;
  struct Timing { uint64_t submitted; uint64_t entered = 0; };
  std::map<uint64_t, Timing> timings_;
  std::vector<double> submitLatency_, encoderLatency_, gaps_;
  uint64_t previousEncodedTime_ = 0;
  auto findTiming(GstClockTime pts) {
    auto found = timings_.lower_bound(pts);
    if (found != timings_.end() && found->first - pts <= 1000) return found;
    if (found != timings_.begin()) { --found; if (pts - found->first <= 1000) return found; }
    return timings_.end();
  }
  static GstPadProbeReturn enterEncoder(GstPad* pad, GstPadProbeInfo* info, gpointer data) {
    auto engine = static_cast<Engine*>(data);
    const auto buffer = GST_PAD_PROBE_INFO_BUFFER(info);
    if (buffer) { std::lock_guard lock(engine->timingsMutex_); auto found = engine->findTiming(runningTime(pad,buffer));
      if (found != engine->timings_.end()) found->second.entered = nowNs(); }
    return GST_PAD_PROBE_OK;
  }
  static GstPadProbeReturn leaveEncoder(GstPad* pad, GstPadProbeInfo* info, gpointer data) {
    auto engine = static_cast<Engine*>(data);
    const auto buffer = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!buffer) return GST_PAD_PROBE_OK;
    const uint64_t now = nowNs(); engine->encoded_++; engine->encodedBytes_ += gst_buffer_get_size(buffer);
    std::lock_guard lock(engine->timingsMutex_);
    const auto found = engine->findTiming(runningTime(pad,buffer));
    if (found != engine->timings_.end()) {
      engine->submitLatency_.push_back((now - found->second.submitted) / 1e6);
      if (found->second.entered) engine->encoderLatency_.push_back((now - found->second.entered) / 1e6);
      engine->timings_.erase(found);
    }
    if (engine->previousEncodedTime_) engine->gaps_.push_back((now - engine->previousEncodedTime_) / 1e6);
    engine->previousEncodedTime_ = now;
    return GST_PAD_PROBE_OK;
  }
  std::string chooseEncoder() {
    const std::string prefix = adapter_.vendor == 0x1002 ? "amfh264" : adapter_.vendor == 0x10de ? "nvd3d11h264" : adapter_.vendor == 0x8086 ? "qsvh264" : "unsupported";
    GList* factories = gst_element_factory_list_get_elements(GST_ELEMENT_FACTORY_TYPE_ENCODER | GST_ELEMENT_FACTORY_TYPE_MEDIA_VIDEO, GST_RANK_NONE);
    std::string match;
    for (GList* row = factories; row; row = row->next) {
      auto factory = GST_ELEMENT_FACTORY(row->data);
      const std::string name = gst_plugin_feature_get_name(GST_PLUGIN_FEATURE(factory));
      if (name.rfind(prefix, 0) != 0) continue;
      GstElement* candidate = gst_element_factory_create(factory, nullptr);
      if (!candidate) continue;
      gint64 luid = 0;
      if (g_object_class_find_property(G_OBJECT_GET_CLASS(candidate), "adapter-luid")) g_object_get(candidate, "adapter-luid", &luid, nullptr);
      if (luid == adapter_.luid) match = name;
      gst_object_unref(candidate);
      if (!match.empty()) break;
    }
    gst_plugin_feature_list_free(factories);
    if (match.empty()) throw std::runtime_error("Encoder H.264 de hardware indisponivel na GPU escolhida. Nao ha fallback para CPU.");
    return match;
  }
  void stopPeer() {
    if (peerContext_) peerContext_->live = false;
    if (pipeline_) gst_element_set_state(pipeline_, GST_STATE_NULL);
    if (previous_) { gst_buffer_unref(previous_); previous_ = nullptr; }
    for (auto element : {source_, encoder_, peer_}) if (element) gst_object_unref(element);
    source_ = encoder_ = peer_ = nullptr;
    if (pipeline_) { gst_object_unref(pipeline_); pipeline_ = nullptr; }
    peerContext_.reset();
    std::lock_guard lock(timingsMutex_); timings_.clear(); submitLatency_.clear(); encoderLatency_.clear(); gaps_.clear(); previousEncodedTime_ = 0;
  }
  void connect(unsigned generation) {
    if (!active_) throw std::runtime_error("Inicie a captura antes de conectar o espectador.");
    stopPeer(); generation_ = generation;
    std::ostringstream description;
    description << "appsrc name=frames is-live=true format=time block=false max-buffers=1 leaky-type=downstream ! "
      "queue max-size-buffers=1 max-size-bytes=0 max-size-time=0 leaky=downstream ! d3d11convert ! "
      "video/x-raw(memory:D3D11Memory),format=NV12,pixel-aspect-ratio=1/1,width=" << width_ << ",height=" << height_ << ",framerate=" << fps_ << "/1 ! " << encoderName_ << " name=encoder ! "
      "h264parse ! video/x-h264,profile=(string){baseline,constrained-baseline},stream-format=byte-stream,alignment=au ! "
      "rtph264pay pt=96 config-interval=-1 aggregate-mode=zero-latency ! "
      "application/x-rtp,media=video,encoding-name=H264,clock-rate=90000,payload=96 ! "
      "webrtcbin name=peer bundle-policy=max-bundle latency=0";
    GError* failure = nullptr;
    pipeline_ = gst_parse_launch(description.str().c_str(), &failure);
    if (failure) { const std::string message = failure->message; g_error_free(failure); stopPeer(); throw std::runtime_error(message); }
    source_ = gst_bin_get_by_name(GST_BIN(pipeline_), "frames");
    encoder_ = gst_bin_get_by_name(GST_BIN(pipeline_), "encoder");
    peer_ = gst_bin_get_by_name(GST_BIN(pipeline_), "peer");
    GstContext* context = gst_context_new(GST_D3D11_DEVICE_HANDLE_CONTEXT_TYPE, TRUE);
    gst_structure_set(gst_context_writable_structure(context), "device", GST_TYPE_D3D11_DEVICE, gstDevice_, nullptr);
    gst_element_set_context(pipeline_, context); gst_context_unref(context);
    g_object_set(encoder_, "bitrate", bitrate_, nullptr);
    if (adapter_.vendor == 0x1002) {
      gst_util_set_object_arg(G_OBJECT(encoder_), "usage", "ultra-low-latency");
      gst_util_set_object_arg(G_OBJECT(encoder_), "preset", "speed");
      gst_util_set_object_arg(G_OBJECT(encoder_), "rate-control", "cbr");
      g_object_set(encoder_, "gop-size", fps_, "b-frames", 0, nullptr);
    } else if (adapter_.vendor == 0x10de) {
      gst_util_set_object_arg(G_OBJECT(encoder_), "preset", "p1");
      gst_util_set_object_arg(G_OBJECT(encoder_), "tune", "ultra-low-latency");
      gst_util_set_object_arg(G_OBJECT(encoder_), "rc-mode", "cbr");
      g_object_set(encoder_, "gop-size", fps_, "bframes", 0u, "zerolatency", TRUE, nullptr);
    } else {
      gst_util_set_object_arg(G_OBJECT(encoder_), "rate-control", "cbr");
      g_object_set(encoder_, "gop-size", static_cast<guint>(fps_), "b-frames", 0u, "low-latency", TRUE, nullptr);
    }
    peerContext_ = std::make_shared<PeerContext>(); peerContext_->peer = GST_ELEMENT(gst_object_ref(peer_)); peerContext_->generation = generation;
    auto cleanup = [](gpointer data, GClosure*) { deletePeerRef(data); };
    g_signal_connect_data(peer_, "on-negotiation-needed", G_CALLBACK(onNegotiation), new PeerRef(peerContext_), cleanup, G_CONNECT_DEFAULT);
    g_signal_connect_data(peer_, "on-ice-candidate", G_CALLBACK(onIce), new PeerRef(peerContext_), cleanup, G_CONNECT_DEFAULT);
    for (const auto& item : {std::pair{"sink", enterEncoder}, std::pair{"src", leaveEncoder}}) {
      GstPad* pad = gst_element_get_static_pad(encoder_, item.first); gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BUFFER, item.second, this, nullptr); gst_object_unref(pad);
    }
    epoch_ = nowNs(); nextPush_ = 0; lastFresh_ = epoch_; sourceWidth_ = sourceHeight_ = 0;
    if (gst_element_set_state(pipeline_, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) { stopPeer(); throw std::runtime_error("Falha ao iniciar pipeline de hardware."); }
  }
  void push(uint64_t now) {
    if (!source_ || now < nextPush_) return;
    const uint64_t period = GST_SECOND / fps_;
    nextPush_ = nextPush_ && now - nextPush_ < period ? nextPush_ + period : now + period;
    auto frame = capture_.take();
    if (!frame) {
      if (previous_ && now - lastFresh_ > GST_SECOND && now - lastFresh_ < 24ULL * 3600 * GST_SECOND) {
        GstBuffer* buffer = gst_buffer_copy(previous_);
        GST_BUFFER_PTS(buffer) = now - epoch_; GST_BUFFER_DTS(buffer) = GST_CLOCK_TIME_NONE;
        GST_BUFFER_DURATION(buffer) = GST_SECOND;
        gst_app_src_push_buffer(GST_APP_SRC(source_), buffer); repeats_++; lastFresh_ = now;
      }
      return;
    }
    const auto size = frame.ContentSize();
    if (size.Width <= 0 || size.Height <= 0 || size.Width > 16384 || size.Height > 16384) { frame.Close(); return; }
    const auto surface = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    winrt::com_ptr<ID3D11Texture2D> incoming;
    winrt::check_hresult(surface->GetInterface(__uuidof(ID3D11Texture2D), incoming.put_void()));
    D3D11_TEXTURE2D_DESC desc{}; incoming->GetDesc(&desc);
    const auto client = capture_.clientRegion(std::min(size.Width, static_cast<int>(desc.Width)), std::min(size.Height, static_cast<int>(desc.Height)));
    const int contentWidth = client.width, contentHeight = client.height;
    if (contentWidth <= 0 || contentHeight <= 0) { frame.Close(); return; }
    std::shared_ptr<TextureSlot> slot;
    for (auto& candidate : slots_) {
      if (!candidate || (!candidate->busy && (candidate->width != contentWidth || candidate->height != contentHeight))) {
        candidate = std::make_shared<TextureSlot>(); candidate->width = contentWidth; candidate->height = contentHeight;
        D3D11_TEXTURE2D_DESC copy{}; copy.Width = contentWidth; copy.Height = contentHeight; copy.MipLevels = copy.ArraySize = 1;
        copy.Format = DXGI_FORMAT_B8G8R8A8_UNORM; copy.SampleDesc.Count = 1; copy.Usage = D3D11_USAGE_DEFAULT; copy.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
        winrt::check_hresult(device_->CreateTexture2D(&copy, nullptr, candidate->texture.put()));
      }
      bool expected = false;
      if (candidate->width == contentWidth && candidate->height == contentHeight && candidate->busy.compare_exchange_strong(expected, true)) { slot = candidate; break; }
    }
    if (!slot) { poolDrops_++; frame.Close(); return; }
    D3D11_BOX region{static_cast<UINT>(client.x), static_cast<UINT>(client.y), 0, static_cast<UINT>(client.x + contentWidth), static_cast<UINT>(client.y + contentHeight), 1};
    gst_d3d11_device_lock(gstDevice_);
    deviceContext_->CopySubresourceRegion(slot->texture.get(), 0, 0, 0, 0, incoming.get(), 0, &region);
    deviceContext_->Flush();
    gst_d3d11_device_unlock(gstDevice_); gpuCopies_++;
    frame.Close(); incoming = nullptr;
    if (size.Width != capture_.width() || size.Height != capture_.height()) {
      capture_.resize(size.Width, size.Height);
      emit("{\"type\":\"source-resize\",\"width\":" + std::to_string(contentWidth) + ",\"height\":" + std::to_string(contentHeight) + ",\"region\":\"client\"}");
    }
    auto retained = new std::shared_ptr<TextureSlot>(slot);
    GstMemory* memory = gst_d3d11_allocator_alloc_wrapped(nullptr, gstDevice_, slot->texture.get(), static_cast<gsize>(contentWidth) * contentHeight * 4, retained,
      [](gpointer data) { auto retainedSlot = static_cast<std::shared_ptr<TextureSlot>*>(data); (*retainedSlot)->busy = false; delete retainedSlot; });
    if (!memory) { slot->busy = false; delete retained; throw std::runtime_error("Falha ao compartilhar textura Direct3D11."); }
    GstBuffer* buffer = gst_buffer_new(); gst_buffer_append_memory(buffer, memory);
    gst_buffer_add_video_meta(buffer, GST_VIDEO_FRAME_FLAG_NONE, GST_VIDEO_FORMAT_BGRA, contentWidth, contentHeight);
    if (sourceWidth_ != contentWidth || sourceHeight_ != contentHeight) {
      GstCaps* caps = gst_caps_new_simple("video/x-raw", "format", G_TYPE_STRING, "BGRA", "width", G_TYPE_INT, contentWidth,
        "height", G_TYPE_INT, contentHeight, "framerate", GST_TYPE_FRACTION, fps_, 1, nullptr);
      gst_caps_set_features(caps, 0, gst_caps_features_new(GST_CAPS_FEATURE_MEMORY_D3D11_MEMORY, nullptr));
      gst_app_src_set_caps(GST_APP_SRC(source_), caps); gst_caps_unref(caps); sourceWidth_ = contentWidth; sourceHeight_ = contentHeight;
    }
    const uint64_t pts = now - epoch_;
    GST_BUFFER_PTS(buffer) = pts; GST_BUFFER_DTS(buffer) = GST_CLOCK_TIME_NONE; GST_BUFFER_DURATION(buffer) = GST_SECOND / fps_;
    { std::lock_guard lock(timingsMutex_); timings_[pts] = {now, 0}; while (timings_.size() > 256) timings_.erase(timings_.begin()); }
    if (previous_) gst_buffer_unref(previous_);
    previous_ = gst_buffer_copy(buffer);
    const auto flow = gst_app_src_push_buffer(GST_APP_SRC(source_), buffer);
    if (flow != GST_FLOW_OK && flow != GST_FLOW_FLUSHING) throw std::runtime_error("O pipeline recusou o frame capturado.");
    submitted_++; lastFresh_ = now;
  }
  void stats(uint64_t now) {
    const double seconds = (now - lastStats_) / 1e9;
    const auto captured = capture_.received(), encoded = encoded_.load();
    DWORD foreground = 0, owner = 0; GetWindowThreadProcessId(GetForegroundWindow(), &foreground); GetWindowThreadProcessId(capture_.window(), &owner);
    const bool exists = IsWindow(capture_.window()) && owner == capture_.owner();
    D3DKMT_SCHEDULINGPRIORITYCLASS priority{};
    const NTSTATUS priorityResult = D3DKMTGetProcessSchedulingPriorityClass(GetCurrentProcess(), &priority);
    std::lock_guard lock(timingsMutex_);
    std::ostringstream out;
    out << "{\"type\":\"sample\",\"captureFps\":" << (captured - lastCaptureCount_) / seconds
      << ",\"submittedFps\":" << (submitted_ - lastSubmitted_) / seconds << ",\"encodedFps\":" << (encoded - lastEncoded_) / seconds
      << ",\"captured\":" << captured << ",\"submitted\":" << submitted_ << ",\"encoded\":" << encoded
      << ",\"superseded\":" << capture_.superseded() << ",\"poolDrops\":" << poolDrops_ << ",\"keepaliveFrames\":" << repeats_
      << ",\"gpuCopies\":" << gpuCopies_ << ",\"explicitCpuReadbacks\":0,\"encodedBytes\":" << encodedBytes_
      << ",\"latencySamples\":" << submitLatency_.size()
      << ",\"submitToEncodedP95Ms\":" << (submitLatency_.empty() ? "null" : std::to_string(percentile(submitLatency_, .95)))
      << ",\"encoderStageP95Ms\":" << (encoderLatency_.empty() ? "null" : std::to_string(percentile(encoderLatency_, .95)))
      << ",\"encodedGapP95Ms\":" << (gaps_.empty() ? "null" : std::to_string(percentile(gaps_, .95))) << ",\"sourceWidth\":" << sourceWidth_ << ",\"sourceHeight\":" << sourceHeight_
      << ",\"surfaceWidth\":" << capture_.width() << ",\"surfaceHeight\":" << capture_.height() << ",\"captureRegion\":\"client\""
      << ",\"exists\":" << (exists ? "true" : "false") << ",\"minimized\":" << (IsIconic(capture_.window()) ? "true" : "false")
      << ",\"focused\":" << (foreground == capture_.owner() ? "true" : "false") << ",\"gpuPriority\":" << (priorityResult >= 0 ? static_cast<int>(priority) : -1)
      << ",\"peerActive\":" << (peer_ ? "true" : "false") << ",\"gpu\":" << gpuLoad_.json() << "}";
    emit(out.str());
    submitLatency_.clear(); encoderLatency_.clear(); gaps_.clear();
    lastCaptureCount_ = captured; lastSubmitted_ = submitted_; lastEncoded_ = encoded; lastStats_ = now;
  }
public:
  explicit Engine(GMainLoop* loop) : loop_(loop) {}
  void stop() {
    active_ = false; capture_.stop(); stopPeer(); slots_.fill(nullptr); gpuLoad_.stop();
    if (gstDevice_) { gst_object_unref(gstDevice_); gstDevice_ = nullptr; }
    deviceContext_ = nullptr; device_ = nullptr;
    if (priorityChanged_) {
      D3DKMT_SCHEDULINGPRIORITYCLASS current{};
      if (D3DKMTGetProcessSchedulingPriorityClass(GetCurrentProcess(), &current) >= 0 && current == D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH)
        D3DKMTSetProcessSchedulingPriorityClass(GetCurrentProcess(), originalPriority_);
      priorityChanged_ = false;
    }
  }
  void tick() {
    if (!active_) return;
    try {
      DWORD owner = 0; GetWindowThreadProcessId(capture_.window(), &owner);
      if (capture_.closed() || !IsWindow(capture_.window()) || owner != capture_.owner()) { stop(); emit("{\"type\":\"stopped\",\"reason\":\"source_closed\"}"); return; }
      if (capture_.error()) throw std::runtime_error("A sessao WGC apresentou erro.");
      if (pipeline_) {
        GstBus* bus = gst_element_get_bus(pipeline_);
        GstMessage* message = gst_bus_pop_filtered(bus, GST_MESSAGE_ERROR);
        gst_object_unref(bus);
        if (message) { GError* failure = nullptr; gst_message_parse_error(message, &failure, nullptr);
          const std::string error = std::string(GST_OBJECT_NAME(message->src)) + ": " + (failure ? failure->message : "Falha no pipeline");
          g_clear_error(&failure); gst_message_unref(message); throw std::runtime_error(error); }
      }
      const uint64_t now = nowNs(); push(now);
      if (now - lastStats_ >= GST_SECOND) stats(now);
    } catch (winrt::hresult_error const& failure) { stop(); emit("{\"type\":\"error\",\"message\":" + jsonString(to_string(failure.message())) + "}"); }
    catch (std::exception const& failure) { stop(); emit("{\"type\":\"error\",\"message\":" + jsonString(failure.what()) + "}"); }
  }
  void command(const std::string& line) {
    int id = 0;
    try {
      const auto value = JsonObject::Parse(winrt::to_hstring(line)); id = number(value, L"id", 0);
      const auto op = text(value, L"op");
      if (op == "list") {
        choices_ = windows(); std::ostringstream out; out << ",\"windows\":["; bool first = true;
        for (auto& item : choices_) { if (!first) out << ','; first = false; out << "{\"id\":" << jsonString(std::to_string(reinterpret_cast<uintptr_t>(item.handle))) << ",\"owner\":" << item.pid << ",\"name\":" << jsonString(item.title) << '}'; }
        out << "],\"adapters\":["; first = true;
        for (auto& item : adapters()) { if (!first) out << ','; first = false; out << "{\"index\":" << item.index << ",\"vendor\":" << item.vendor << ",\"name\":" << jsonString(item.name) << '}'; }
        out << ']'; response(id, out.str());
      } else if (op == "start") {
        if (active_) throw std::runtime_error("Pare a captura atual antes de iniciar outra.");
        const auto selected = text(value, L"window");
        const auto found = std::find_if(choices_.begin(), choices_.end(), [&](auto& item) { return std::to_string(reinterpret_cast<uintptr_t>(item.handle)) == selected; });
        DWORD owner = 0;
        if (found == choices_.end() || !IsWindow(found->handle)) throw std::runtime_error("Selecione uma janela da lista atualizada.");
        GetWindowThreadProcessId(found->handle, &owner);
        if (owner != found->pid) throw std::runtime_error("A janela selecionada mudou de processo.");
        fps_ = number(value, L"fps", 60); bitrate_ = number(value, L"bitrateKbps", 8000);
        const int maxHeight = number(value, L"height", 1080), index = number(value, L"adapter", -1);
        if ((fps_ != 30 && fps_ != 60) || (maxHeight != 720 && maxHeight != 1080) || bitrate_ < 1000 || bitrate_ > 20000) throw std::runtime_error("Qualidade invalida.");
        try {
          device_ = createDevice(index, adapter_); device_->GetImmediateContext(deviceContext_.put());
          gstDevice_ = gst_d3d11_device_new_wrapped(device_.get());
          if (!gstDevice_) throw std::runtime_error("Falha ao integrar o dispositivo Direct3D11.");
          encoderName_ = chooseEncoder(); capture_.start(found->handle, device_.get());
          const auto client = capture_.clientRegion(capture_.width(), capture_.height());
          if (client.width <= 0 || client.height <= 0) throw std::runtime_error("A area interna da janela esta indisponivel.");
          const double scale = std::min({1.0, maxHeight * (16.0 / 9.0) / client.width, static_cast<double>(maxHeight) / client.height});
          width_ = static_cast<int>(client.width * scale) & ~1; height_ = static_cast<int>(client.height * scale) & ~1;
          if (width_ < 160 || height_ < 128 || width_ > 1920 || height_ > 1080) throw std::runtime_error("Dimensoes da janela incompativeis com o encoder.");
          if (value.GetNamedBoolean(L"gpuPriority", false) && D3DKMTGetProcessSchedulingPriorityClass(GetCurrentProcess(), &originalPriority_) >= 0 && originalPriority_ < D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH) {
            priorityChanged_ = D3DKMTSetProcessSchedulingPriorityClass(GetCurrentProcess(), D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH) >= 0;
          }
          submitted_ = poolDrops_ = repeats_ = gpuCopies_ = lastCaptureCount_ = lastSubmitted_ = lastEncoded_ = 0; encoded_ = 0; encodedBytes_ = 0;
          gpuLoad_.start(adapter_.luid); lastStats_ = nowNs(); active_ = true;
        } catch (...) { stop(); throw; }
        response(id, ",\"width\":" + std::to_string(width_) + ",\"height\":" + std::to_string(height_) + ",\"fps\":" + std::to_string(fps_) + ",\"encoder\":" + jsonString(encoderName_) + ",\"adapter\":" + jsonString(adapter_.name) + ",\"adapterLuid\":" + jsonString(std::to_string(adapter_.luid)) + ",\"capture\":\"WGC-C++\",\"memory\":\"D3D11\"");
      } else if (op == "connect") {
        const auto generation = number(value, L"generation", 0);
        if (generation <= 0) throw std::runtime_error("Sessao invalida.");
        connect(static_cast<unsigned>(generation)); response(id);
      } else if (op == "answer") {
        if (!peer_ || number(value, L"generation", 0) != static_cast<int>(generation_)) throw std::runtime_error("Sessao expirada.");
        const auto sdp = text(value, L"sdp");
        if (sdp.size() > 128 * 1024) throw std::runtime_error("SDP excede limite.");
        GstSDPMessage* message = nullptr; gst_sdp_message_new(&message);
        if (gst_sdp_message_parse_buffer(reinterpret_cast<const guint8*>(sdp.data()), static_cast<guint>(sdp.size()), message) != GST_SDP_OK) { gst_sdp_message_free(message); throw std::runtime_error("SDP invalido."); }
        auto answer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_ANSWER, message);
        g_signal_emit_by_name(peer_, "set-remote-description", answer, nullptr); gst_webrtc_session_description_free(answer); response(id);
      } else if (op == "ice") {
        if (peer_ && number(value, L"generation", 0) == static_cast<int>(generation_)) {
          const auto candidate = text(value, L"candidate"); const int index = number(value, L"sdpMLineIndex", 0);
          if (candidate.size() > 4096 || index > 8) throw std::runtime_error("ICE invalido.");
          g_signal_emit_by_name(peer_, "add-ice-candidate", index, candidate.c_str());
        }
        response(id);
      } else if (op == "disconnect") { stopPeer(); response(id); }
      else if (op == "stop") { stop(); response(id); }
      else if (op == "quit") { stop(); response(id); g_main_loop_quit(loop_); }
      else throw std::runtime_error("Comando desconhecido.");
    } catch (winrt::hresult_error const& failure) { emit("{\"type\":\"response\",\"id\":" + std::to_string(id) + ",\"ok\":false,\"message\":" + jsonString(to_string(failure.message())) + "}"); }
    catch (std::exception const& failure) { emit("{\"type\":\"response\",\"id\":" + std::to_string(id) + ",\"ok\":false,\"message\":" + jsonString(failure.what()) + "}"); }
  }
};

int main(int argc, char** argv) {
  try {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    gst_init(&argc, &argv); timeBeginPeriod(1);
    GMainLoop* loop = g_main_loop_new(nullptr, FALSE);
    Engine engine(loop);
    g_timeout_add(2, [](gpointer data) -> gboolean { static_cast<Engine*>(data)->tick(); return G_SOURCE_CONTINUE; }, &engine);
    emit("{\"type\":\"ready\",\"schema\":1,\"capture\":\"WGC-C++\",\"gstreamer\":" + jsonString(gst_version_string()) + "}");
    std::thread input([&] {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
      struct Operation { Engine* engine; std::string line; };
      std::string line;
      while (std::getline(std::cin, line)) {
        if (line.size() > 256 * 1024) break;
        g_main_context_invoke(nullptr, [](gpointer data) -> gboolean { std::unique_ptr<Operation> operation(static_cast<Operation*>(data)); operation->engine->command(operation->line); return G_SOURCE_REMOVE; }, new Operation{&engine, line});
      }
      g_main_context_invoke(nullptr, [](gpointer data) -> gboolean { g_main_loop_quit(static_cast<GMainLoop*>(data)); return G_SOURCE_REMOVE; }, loop);
    });
    g_main_loop_run(loop); engine.stop();
    // Parent closes stdin for shutdown; no detached worker can outlive Engine.
    input.join(); g_main_loop_unref(loop); timeEndPeriod(1);
    return 0;
  } catch (winrt::hresult_error const& error) { emit("{\"type\":\"error\",\"message\":" + jsonString(to_string(error.message())) + "}"); return 1; }
  catch (std::exception const& error) { emit("{\"type\":\"error\",\"message\":" + jsonString(error.what()) + "}"); return 1; }
}
