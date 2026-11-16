import Foundation
import AVFoundation
import CryptoKit

/// The native meeting recorder (2026-11-16, after the LocalGlobe loss).
///
/// Records the microphone with AVAudioEngine and writes the audio to
/// self-contained ~45 s AAC segment FILES under the app sandbox as it is
/// captured. Nothing here depends on the WKWebView page being alive: with
/// `UIBackgroundModes = [audio]` iOS keeps a running input engine alive with
/// the screen locked, and the files are the recording whether or not
/// anything ever reads them. Upload is `SegmentUploader`'s job (a sealed
/// segment is handed over with a sidecar JSON describing where it goes).
///
/// Interruptions are the OS's signals, not guesses: an
/// `AVAudioSession.interruptionNotification` seals the running segment and,
/// on `.ended`, restarts the engine; an `AVAudioEngineConfigurationChange`
/// (route change, headset unplug) restarts it in place; a watchdog treats
/// five seconds without an input buffer as an interruption and keeps
/// retrying every three seconds until the mic is back or the user stops.
/// Every entry into `.interrupted` therefore has an owner that leaves it.
///
/// State is reported to a delegate (the Capacitor plugin forwards it to JS
/// as events). The JS side never changes recorder state except through
/// start/stop/pause/resume/cancel.
/// Recorder → plugin callbacks (delivered on the recorder's queue).
protocol NativeRecorderDelegate: AnyObject {
    func recorder(_ r: NativeRecorder, didChange state: NativeRecorder.State, reason: String?)
    func recorder(_ r: NativeRecorder, didSeal segment: NativeRecorder.SealedSegment)
    func recorder(_ r: NativeRecorder, audioBuffers count: Int)
}

final class NativeRecorder {
    static let shared = NativeRecorder()

    enum State: String { case recording, interrupted, paused, stopped }

    struct SealedSegment {
        let captureId: String
        let seq: Int
        let t0Ms: Int64
        let bytes: Int64
        let mime: String
        let fileURL: URL
        let metaURL: URL
    }

    struct Status {
        var state: State
        var captureId: String?
        var buffers: Int
        var lastBufferAgeMs: Int64?
        var sealed: Int
        var mime: String?
        var reason: String?
        var sessionCategory: String
        var route: String
    }

    weak var delegate: NativeRecorderDelegate?

    /// All recorder state is mutated on this queue. The tap callback hops
    /// onto it for everything except the write itself.
    private let queue = DispatchQueue(label: "ai.parley.recorder", qos: .userInitiated)

    private var engine: AVAudioEngine?
    private var file: AVAudioFile?
    private var fileFrames: AVAudioFrameCount = 0
    private var segmentFrames: AVAudioFrameCount = 0
    private var sampleRate: Double = 48_000
    private var channels: AVAudioChannelCount = 1

    private(set) var state: State = .stopped
    private var reason: String?
    private var captureId: String?
    private var startedAtMs: Int64 = 0
    private var segmentMs: Int = 45_000
    private var uploadBase = ""
    private var client = "cap-recorder"
    private var seq = 0
    private var currentSeq = -1
    private var currentT0Ms: Int64 = 0
    private var currentURL: URL?
    private var buffers = 0
    private var lastBufferAt: Date?
    private var sealedCount = 0
    private var watchdog: DispatchSourceTimer?
    private var reacquire: DispatchSourceTimer?
    private var observersInstalled = false

    /// Read without the queue on purpose: AppDelegate asks from audio
    /// session notification handlers, which may run while the recorder
    /// queue is busy. A momentarily stale answer is harmless; a deadlock
    /// is not.
    var isRunning: Bool { state != .stopped }

    // MARK: - Storage layout

    /// `<Application Support>/parley-captures/<captureId>/<seq>.m4a` plus
    /// `<seq>.json` (the upload sidecar). Application Support is backed up
    /// by default; the uploader excludes files from backup when it writes
    /// the sidecar.
    static func capturesRoot() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("parley-captures", isDirectory: true)
    }

    static func captureDir(_ id: String) -> URL {
        return capturesRoot().appendingPathComponent(id, isDirectory: true)
    }

    // MARK: - Public API (any thread)

    func start(captureId: String, segmentMs: Int, startedAtMs: Int64, uploadBase: String, client: String) throws {
        try queue.sync {
            guard state == .stopped else { throw RecorderError.busy }
            self.captureId = captureId
            self.segmentMs = max(5_000, segmentMs)
            self.startedAtMs = startedAtMs
            self.uploadBase = uploadBase
            self.client = client
            self.seq = 0
            self.buffers = 0
            self.sealedCount = 0
            self.lastBufferAt = nil
            try FileManager.default.createDirectory(at: NativeRecorder.captureDir(captureId), withIntermediateDirectories: true)
            AudioSessionController.shared.beginCapture()
            installObservers()
            try startEngineLocked()
            try openSegmentLocked()
            startWatchdogLocked()
            setStateLocked(.recording, reason: nil)
            NSLog("[Parley] recorder started capture=\(captureId) rate=\(sampleRate) ch=\(channels)")
        }
    }

    /// Seal the running segment, release the mic. Returns sealed count.
    func stop() -> Int {
        return queue.sync {
            guard state != .stopped else { return sealedCount }
            sealSegmentLocked()
            tearDownLocked()
            setStateLocked(.stopped, reason: "stopped")
            return sealedCount
        }
    }

    /// Stop and DROP the running segment; already-sealed files stay for the
    /// uploader (the server tombstones the capture; their uploads park).
    func cancel() {
        queue.sync {
            guard state != .stopped else { return }
            discardSegmentLocked()
            tearDownLocked()
            setStateLocked(.stopped, reason: "cancelled")
        }
    }

    func pause() {
        queue.sync {
            guard state == .recording || state == .interrupted else { return }
            sealSegmentLocked()
            stopEngineLocked()
            stopReacquireLocked()
            setStateLocked(.paused, reason: "paused")
        }
    }

    func resume() throws {
        try queue.sync {
            guard state == .paused else { return }
            try startEngineLocked()
            try openSegmentLocked()
            setStateLocked(.recording, reason: "resumed")
        }
    }

    func status() -> Status {
        return queue.sync {
            let session = AVAudioSession.sharedInstance()
            let route = session.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ",")
            return Status(
                state: state, captureId: captureId, buffers: buffers,
                lastBufferAgeMs: lastBufferAt.map { Int64(Date().timeIntervalSince($0) * 1000) },
                sealed: sealedCount, mime: captureId == nil ? nil : "audio/mp4", reason: reason,
                sessionCategory: session.category.rawValue, route: route
            )
        }
    }

    // MARK: - Engine (queue-locked)

    private func startEngineLocked() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw RecorderError.noInput }
        sampleRate = format.sampleRate
        channels = format.channelCount
        segmentFrames = AVAudioFrameCount(Double(segmentMs) / 1000.0 * sampleRate)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.handleBuffer(buffer)
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    private func stopEngineLocked() {
        if let engine = engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
    }

    private func tearDownLocked() {
        stopEngineLocked()
        stopWatchdogLocked()
        stopReacquireLocked()
        removeObservers()
        AudioSessionController.shared.endCapture()
        captureId = nil
    }

    /// The tap: write the buffer into the open segment file, rotate when
    /// the segment is full. Runs on the audio thread; the file write is the
    /// only work done there (Apple's own samples write from the tap).
    private func handleBuffer(_ buffer: AVAudioPCMBuffer) {
        queue.async { [self] in
            guard state == .recording, let file = file else { return }
            do {
                try file.write(from: buffer)
            } catch {
                NSLog("[Parley] recorder write failed: \(error.localizedDescription)")
                handleInterruptionLocked(reason: "write failed")
                return
            }
            buffers += 1
            lastBufferAt = Date()
            fileFrames += buffer.frameLength
            if buffers % 25 == 0 { delegate?.recorder(self, audioBuffers: buffers) }
            if fileFrames >= segmentFrames {
                sealSegmentLocked()
                do { try openSegmentLocked() } catch {
                    NSLog("[Parley] recorder could not open next segment: \(error.localizedDescription)")
                    handleInterruptionLocked(reason: "segment open failed")
                }
            }
        }
    }

    // MARK: - Segments (queue-locked)

    private func openSegmentLocked() throws {
        guard let captureId = captureId else { throw RecorderError.noCapture }
        let url = NativeRecorder.captureDir(captureId).appendingPathComponent("\(seq).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: Int(channels),
            AVEncoderBitRateKey: 32_000 * Int(channels),
        ]
        // AVAudioFile converts the tap's PCM into AAC on write.
        file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        fileFrames = 0
        currentSeq = seq
        currentT0Ms = Int64(Date().timeIntervalSince1970 * 1000) - startedAtMs
        currentURL = url
        seq += 1
    }

    /// Close the running file and hand it to the uploader. An empty file
    /// (no frames) is dropped and its seq handed back, like the web engine.
    private func sealSegmentLocked() {
        guard let url = currentURL, let captureId = captureId else { return }
        let frames = fileFrames
        file = nil            // closes + flushes the container
        currentURL = nil
        if frames == 0 {
            try? FileManager.default.removeItem(at: url)
            if seq == currentSeq + 1 { seq = currentSeq }
            return
        }
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
        let sha = NativeRecorder.sha256Hex(url)
        let metaURL = url.deletingPathExtension().appendingPathExtension("json")
        let meta: [String: Any] = [
            "captureId": captureId, "seq": currentSeq, "t0Ms": currentT0Ms, "bytes": bytes,
            "mime": "audio/mp4", "sha256": sha ?? "", "uploadBase": uploadBase, "client": client,
            "attempts": 0, "nextAt": 0, "parked": false, "sealedAt": Date().timeIntervalSince1970,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: meta) {
            try? data.write(to: metaURL, options: .atomic)
        }
        sealedCount += 1
        let seg = SealedSegment(captureId: captureId, seq: currentSeq, t0Ms: currentT0Ms, bytes: bytes,
                                mime: "audio/mp4", fileURL: url, metaURL: metaURL)
        delegate?.recorder(self, didSeal: seg)
        SegmentUploader.shared.enqueue(seg)
    }

    private func discardSegmentLocked() {
        guard let url = currentURL else { return }
        file = nil
        currentURL = nil
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - Interruptions and recovery (queue-locked)

    private func setStateLocked(_ next: State, reason: String?) {
        state = next
        self.reason = reason
        delegate?.recorder(self, didChange: next, reason: reason)
    }

    private func handleInterruptionLocked(reason: String) {
        guard state == .recording || state == .interrupted else { return }
        sealSegmentLocked()
        stopEngineLocked()
        if state != .interrupted { setStateLocked(.interrupted, reason: reason) }
        startReacquireLocked()
    }

    /// Try to get the engine back; keep trying every 3 s until it works
    /// or the user stops/pauses. The only way out of `.interrupted`.
    private func startReacquireLocked() {
        stopReacquireLocked()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1.0, repeating: 3.0)
        t.setEventHandler { [weak self] in self?.tryReacquireLocked() }
        t.resume()
        reacquire = t
    }

    private func stopReacquireLocked() {
        reacquire?.cancel()
        reacquire = nil
    }

    private func tryReacquireLocked() {
        guard state == .interrupted else { stopReacquireLocked(); return }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            try startEngineLocked()
            try openSegmentLocked()
            stopReacquireLocked()
            lastBufferAt = Date()
            setStateLocked(.recording, reason: "mic re-acquired")
            NSLog("[Parley] recorder re-acquired the mic")
        } catch {
            NSLog("[Parley] recorder re-acquire failed (retrying): \(error.localizedDescription)")
            stopEngineLocked()
        }
    }

    /// No input buffer for 5 s while "recording" = the engine is dead in a
    /// way nothing reported. Route it through the interruption path.
    private func startWatchdogLocked() {
        stopWatchdogLocked()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 5.0, repeating: 5.0)
        t.setEventHandler { [weak self] in
            guard let self = self, self.state == .recording, let last = self.lastBufferAt else { return }
            if Date().timeIntervalSince(last) > 5.0 {
                NSLog("[Parley] recorder watchdog: no audio for 5s — recovering")
                self.handleInterruptionLocked(reason: "no audio buffers")
            }
        }
        t.resume()
        watchdog = t
    }

    private func stopWatchdogLocked() {
        watchdog?.cancel()
        watchdog = nil
    }

    private func installObservers() {
        guard !observersInstalled else { return }
        observersInstalled = true
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(onSessionInterruption(_:)),
                       name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(onEngineConfigurationChange(_:)),
                       name: .AVAudioEngineConfigurationChange, object: nil)
        nc.addObserver(self, selector: #selector(onMediaServicesReset(_:)),
                       name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
    }

    private func removeObservers() {
        guard observersInstalled else { return }
        observersInstalled = false
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func onSessionInterruption(_ notif: Notification) {
        guard let info = notif.userInfo,
              let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        queue.async { [self] in
            switch type {
            case .began:
                NSLog("[Parley] recorder: audio interruption began")
                handleInterruptionLocked(reason: "audio interruption")
            case .ended:
                NSLog("[Parley] recorder: audio interruption ended")
                if state == .interrupted { tryReacquireLocked() }
            @unknown default:
                break
            }
        }
    }

    @objc private func onEngineConfigurationChange(_ notif: Notification) {
        guard let engine = engine, (notif.object as? AVAudioEngine) === engine else { return }
        queue.async { [self] in
            guard state == .recording else { return }
            NSLog("[Parley] recorder: engine configuration changed (route) — restarting in place")
            handleInterruptionLocked(reason: "route changed")
            tryReacquireLocked()
        }
    }

    @objc private func onMediaServicesReset(_ notif: Notification) {
        queue.async { [self] in
            guard state == .recording || state == .interrupted else { return }
            NSLog("[Parley] recorder: media services reset — rebuilding")
            handleInterruptionLocked(reason: "media services reset")
        }
    }

    // MARK: - Helpers

    static func sha256Hex(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    enum RecorderError: LocalizedError {
        case busy, noInput, noCapture
        var errorDescription: String? {
            switch self {
            case .busy: return "a recording is already running"
            case .noInput: return "no audio input available"
            case .noCapture: return "no capture in progress"
            }
        }
    }
}
