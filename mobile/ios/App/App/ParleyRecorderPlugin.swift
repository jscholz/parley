import Foundation
import Capacitor

/// JS bridge for the native meeting recorder (2026-11-16). Reached at
/// `window.Capacitor.Plugins.ParleyRecorder`; the TypeScript adapter is
/// src/capture/engines/native.ts and the contract it fulfils is
/// src/capture/engine.ts.
///
/// Thin on purpose: method calls go straight to `NativeRecorder` /
/// `SegmentUploader`, and their delegate callbacks come back out as plugin
/// events (`state`, `segment`, `uploaded`, `network`, `audio`). No state of
/// its own.
///
/// Registered by hand in WebViewDelegate.capacitorDidLoad() via
/// `bridge.registerPluginInstance(_:)` — Capacitor 8 does not auto-discover
/// local plugins (see ExternalBrowserPlugin.swift).
@objc(ParleyRecorderPlugin)
public class ParleyRecorderPlugin: CAPPlugin, CAPBridgedPlugin, NativeRecorderDelegate, SegmentUploaderDelegate {
    public let identifier = "ParleyRecorderPlugin"
    public let jsName = "ParleyRecorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "kick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pending", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        NativeRecorder.shared.delegate = self
        SegmentUploader.shared.delegate = self
        // Anything a previous process left on disk starts draining now.
        SegmentUploader.shared.kick()
    }

    // MARK: - Methods

    @objc func start(_ call: CAPPluginCall) {
        guard let captureId = call.getString("captureId"), !captureId.isEmpty,
              let uploadBase = call.getString("uploadBase"), !uploadBase.isEmpty else {
            call.reject("captureId and uploadBase are required")
            return
        }
        let segmentMs = call.getInt("segmentMs") ?? 45_000
        let startedAtMs = Int64(call.getDouble("startedAtMs") ?? Date().timeIntervalSince1970 * 1000)
        let client = call.getString("client") ?? "cap-recorder"
        do {
            try NativeRecorder.shared.start(captureId: captureId, segmentMs: segmentMs, startedAtMs: startedAtMs,
                                            uploadBase: uploadBase, client: client)
            call.resolve(["ok": true])
        } catch {
            call.reject("recorder start failed: \(error.localizedDescription)")
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        let sealed = NativeRecorder.shared.stop()
        SegmentUploader.shared.kick()
        call.resolve(["sealed": sealed])
    }

    @objc func cancel(_ call: CAPPluginCall) {
        NativeRecorder.shared.cancel()
        call.resolve()
    }

    @objc func pause(_ call: CAPPluginCall) {
        NativeRecorder.shared.pause()
        call.resolve()
    }

    @objc func resume(_ call: CAPPluginCall) {
        do {
            try NativeRecorder.shared.resume()
            call.resolve()
        } catch {
            call.reject("resume failed: \(error.localizedDescription)")
        }
    }

    @objc func kick(_ call: CAPPluginCall) {
        SegmentUploader.shared.kick()
        call.resolve()
    }

    @objc func status(_ call: CAPPluginCall) {
        let s = NativeRecorder.shared.status()
        let p = SegmentUploader.shared.pending(captureId: nil)
        var out: [String: Any] = [
            "state": s.state.rawValue,
            "buffers": s.buffers,
            "pending": p.count,
            "sealed": s.sealed,
            "session_category": s.sessionCategory,
            "input_route": s.route,
            "app_state": appStateName(),
        ]
        // Only JSON-representable values go into the result: an absent
        // optional is simply absent (the JS side treats missing as null).
        if let v = s.captureId { out["captureId"] = v }
        if let v = s.lastBufferAgeMs { out["lastBufferAgeMs"] = v }
        if let v = s.mime { out["mime"] = v }
        if let v = s.reason { out["reason"] = v }
        call.resolve(out)
    }

    @objc func pending(_ call: CAPPluginCall) {
        let p = SegmentUploader.shared.pending(captureId: call.getString("captureId"))
        call.resolve(["count": p.count, "captureIds": p.captureIds])
    }

    private func appStateName() -> String {
        var name = "unknown"
        let read = { name = UIApplication.shared.applicationState == .active ? "active"
            : UIApplication.shared.applicationState == .inactive ? "inactive" : "background" }
        if Thread.isMainThread { read() } else { DispatchQueue.main.sync(execute: read) }
        return name
    }

    // MARK: - NativeRecorderDelegate → events

    func recorder(_ r: NativeRecorder, didChange state: NativeRecorder.State, reason: String?) {
        var data: [String: Any] = ["state": state.rawValue]
        if let reason = reason { data["reason"] = reason }
        notifyListeners("state", data: data)
    }

    func recorder(_ r: NativeRecorder, didSeal segment: NativeRecorder.SealedSegment) {
        notifyListeners("segment", data: [
            "captureId": segment.captureId, "seq": segment.seq, "t0Ms": segment.t0Ms,
            "bytes": segment.bytes, "mime": segment.mime,
        ])
    }

    func recorder(_ r: NativeRecorder, audioBuffers count: Int) {
        notifyListeners("audio", data: ["buffers": count])
    }

    // MARK: - SegmentUploaderDelegate → events

    func uploader(_ u: SegmentUploader, didUpload captureId: String, seq: Int) {
        notifyListeners("uploaded", data: ["captureId": captureId, "seq": seq])
    }

    func uploader(_ u: SegmentUploader, didFail captureId: String, seq: Int, status: Int, parked: Bool) {
        notifyListeners("uploadFailed", data: ["captureId": captureId, "seq": seq, "status": status, "parked": parked])
    }

    func uploader(_ u: SegmentUploader, networkOnline online: Bool) {
        notifyListeners("network", data: ["online": online])
    }
}
