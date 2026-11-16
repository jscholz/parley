import Foundation
import UIKit

/// Drains sealed segment files to the server (2026-11-16).
///
/// The native twin of src/capture/uploader.ts's segment lane, speaking the
/// same wire protocol: `POST {uploadBase}/api/parley/captures/{id}/segments/{seq}`
/// with the file as the body, `x-parley-t0-ms`, `x-parley-sha256` and
/// `x-parley-client` headers. Everything else the web uploader does
/// (register / activate / marks / stop) stays on the JS side, which also
/// waits for this lane to be empty before it posts the deferred stop.
///
/// A *background* URLSession carries the uploads, so they continue while
/// the app is suspended (screen locked for the whole meeting) and even
/// after it is killed; `AppDelegate` hands the session's completion handler
/// back through `backgroundCompletionHandler`.
///
/// Durability: the segment file and its sidecar JSON stay on disk until the
/// server has acknowledged the segment. Outcomes mirror the web uploader:
///   2xx            → acked, files deleted, `uploaded` event
///   409 "frozen"   → the capture was finalized before this landed: PARK
///                    (keep the file for the retention window, stop retrying)
///   404            → the capture is not registered yet (JS does that):
///                    retry with backoff
///   429 / 5xx / no network → retry with backoff
///   other 4xx      → permanent, dropped
/// Sidecars record attempts and the next retry time; `kick()` is the only
/// scheduler, called after every seal, every completion, on resume and
/// from JS.
/// Uploader → plugin callbacks (delivered on the uploader's queue).
protocol SegmentUploaderDelegate: AnyObject {
    func uploader(_ u: SegmentUploader, didUpload captureId: String, seq: Int)
    func uploader(_ u: SegmentUploader, didFail captureId: String, seq: Int, status: Int, parked: Bool)
    func uploader(_ u: SegmentUploader, networkOnline online: Bool)
}

final class SegmentUploader: NSObject {
    static let shared = SegmentUploader()

    weak var delegate: SegmentUploaderDelegate?

    /// Set by AppDelegate.application(_:handleEventsForBackgroundURLSession:…)
    /// and called once this session has delivered every pending event.
    var backgroundCompletionHandler: (() -> Void)?

    static let sessionIdentifier = "ai.parley.capture-uploads"
    private let maxConcurrent = 2
    private let retentionDays = 7.0
    private let queue = DispatchQueue(label: "ai.parley.uploader")
    private var inFlight = Set<String>()        // meta paths with a task running
    private var bodies = [Int: Data]()          // task id → response body
    private var lastKick = Date.distantPast

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.background(withIdentifier: SegmentUploader.sessionIdentifier)
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        cfg.waitsForConnectivity = true
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 24 * 60 * 60
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(onForeground),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    @objc private func onForeground() { kick() }

    // MARK: - Public API

    func enqueue(_ seg: NativeRecorder.SealedSegment) {
        excludeFromBackup(seg.fileURL)
        excludeFromBackup(seg.metaURL)
        kick()
    }

    /// Scan the capture tree and start uploads for everything due. Safe to
    /// call often; coalesces onto one queue.
    func kick() {
        queue.async { [self] in
            lastKick = Date()
            reconcileInFlightLocked()
            purgeOldParkedLocked()
            let due = pendingMetasLocked().filter { !inFlight.contains($0.path) && isDue($0) }
            for metaURL in due.prefix(max(0, maxConcurrent - inFlight.count)) {
                startUploadLocked(metaURL)
            }
        }
    }

    /// Sealed segments not yet acknowledged (parked ones excluded).
    func pending(captureId: String?) -> (count: Int, captureIds: [String]) {
        return queue.sync {
            let metas = pendingMetasLocked().compactMap { url -> (String, Bool)? in
                guard let m = readMeta(url), let id = m["captureId"] as? String else { return nil }
                return (id, (m["parked"] as? Bool) ?? false)
            }.filter { !$0.1 && (captureId == nil || $0.0 == captureId!) }
            return (metas.count, Array(Set(metas.map { $0.0 })).sorted())
        }
    }

    // MARK: - Scheduling (queue-locked)

    private func pendingMetasLocked() -> [URL] {
        let root = NativeRecorder.capturesRoot()
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
        var out: [URL] = []
        for case let url as URL in e where url.pathExtension == "json" {
            out.append(url)
        }
        // Oldest capture, lowest seq first: the server's manifest stays
        // append-mostly and the rolling transcriber's life stays easy.
        return out.sorted { a, b in
            let ma = readMeta(a), mb = readMeta(b)
            let ca = ma?["captureId"] as? String ?? "", cb = mb?["captureId"] as? String ?? ""
            if ca != cb { return ca < cb }
            return (ma?["seq"] as? Int ?? 0) < (mb?["seq"] as? Int ?? 0)
        }
    }

    private func isDue(_ metaURL: URL) -> Bool {
        guard let m = readMeta(metaURL) else { return false }
        if (m["parked"] as? Bool) == true { return false }
        let nextAt = (m["nextAt"] as? Double) ?? 0
        return Date().timeIntervalSince1970 >= nextAt
    }

    /// A background session outlives the process: on relaunch, tasks it is
    /// still running are not in `inFlight`. Ask it, so we never double-post.
    private func reconcileInFlightLocked() {
        let group = DispatchGroup()
        group.enter()
        var running = Set<String>()
        session.getAllTasks { tasks in
            for t in tasks where t.state == .running || t.state == .suspended {
                if let d = t.taskDescription { running.insert(d) }
            }
            group.leave()
        }
        _ = group.wait(timeout: .now() + 2.0)
        inFlight = running
    }

    private func startUploadLocked(_ metaURL: URL) {
        guard let m = readMeta(metaURL),
              let captureId = m["captureId"] as? String,
              let seq = m["seq"] as? Int,
              let base = m["uploadBase"] as? String,
              let url = URL(string: "\(base)/api/parley/captures/\(captureId)/segments/\(seq)") else {
            try? FileManager.default.removeItem(at: metaURL)
            return
        }
        let fileURL = metaURL.deletingPathExtension().appendingPathExtension("m4a")
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            try? FileManager.default.removeItem(at: metaURL)   // audio gone: nothing to send
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue((m["mime"] as? String) ?? "audio/mp4", forHTTPHeaderField: "Content-Type")
        req.setValue(String((m["t0Ms"] as? Int64) ?? Int64((m["t0Ms"] as? Int) ?? 0)), forHTTPHeaderField: "x-parley-t0-ms")
        if let sha = m["sha256"] as? String, !sha.isEmpty { req.setValue(sha, forHTTPHeaderField: "x-parley-sha256") }
        req.setValue((m["client"] as? String) ?? "cap-recorder", forHTTPHeaderField: "x-parley-client")
        let task = session.uploadTask(with: req, fromFile: fileURL)
        task.taskDescription = metaURL.path
        inFlight.insert(metaURL.path)
        task.resume()
        NSLog("[Parley] upload started capture=\(captureId) seq=\(seq)")
    }

    private func purgeOldParkedLocked() {
        let cutoff = Date().timeIntervalSince1970 - retentionDays * 86_400
        for metaURL in pendingMetasLocked() {
            guard let m = readMeta(metaURL), (m["parked"] as? Bool) == true else { continue }
            let sealedAt = (m["sealedAt"] as? Double) ?? 0
            if sealedAt < cutoff {
                try? FileManager.default.removeItem(at: metaURL.deletingPathExtension().appendingPathExtension("m4a"))
                try? FileManager.default.removeItem(at: metaURL)
            }
        }
    }

    // MARK: - Outcomes (queue-locked)

    private func completeLocked(metaPath: String, status: Int, body: Data?, error: Error?) {
        inFlight.remove(metaPath)
        let metaURL = URL(fileURLWithPath: metaPath)
        guard var m = readMeta(metaURL),
              let captureId = m["captureId"] as? String,
              let seq = m["seq"] as? Int else { return }
        let fileURL = metaURL.deletingPathExtension().appendingPathExtension("m4a")

        if let error = error as NSError? {
            let offline = error.domain == NSURLErrorDomain
                && [NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost].contains(error.code)
            delegate?.uploader(self, networkOnline: !offline)
            scheduleRetryLocked(m: &m, at: metaURL)
            NSLog("[Parley] upload failed capture=\(captureId) seq=\(seq): \(error.localizedDescription)")
            return
        }
        delegate?.uploader(self, networkOnline: true)
        if (200..<300).contains(status) {
            try? FileManager.default.removeItem(at: fileURL)
            try? FileManager.default.removeItem(at: metaURL)
            delegate?.uploader(self, didUpload: captureId, seq: seq)
            NSLog("[Parley] upload acked capture=\(captureId) seq=\(seq)")
            return
        }
        let text = body.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        if status == 409 && text.range(of: "frozen", options: .caseInsensitive) != nil {
            m["parked"] = true
            writeMeta(m, to: metaURL)
            delegate?.uploader(self, didFail: captureId, seq: seq, status: status, parked: true)
            NSLog("[Parley] upload parked (capture frozen) capture=\(captureId) seq=\(seq)")
            return
        }
        if status == 404 || status == 409 || status == 429 || status >= 500 {
            scheduleRetryLocked(m: &m, at: metaURL)
            delegate?.uploader(self, didFail: captureId, seq: seq, status: status, parked: false)
            return
        }
        // Other 4xx: permanent. Drop, like the web uploader.
        try? FileManager.default.removeItem(at: fileURL)
        try? FileManager.default.removeItem(at: metaURL)
        delegate?.uploader(self, didFail: captureId, seq: seq, status: status, parked: false)
        NSLog("[Parley] upload dropped (\(status)) capture=\(captureId) seq=\(seq)")
    }

    private func scheduleRetryLocked(m: inout [String: Any], at metaURL: URL) {
        let attempts = ((m["attempts"] as? Int) ?? 0) + 1
        let delay = min(60.0, 2.0 * pow(2.0, Double(min(attempts - 1, 5))))
        m["attempts"] = attempts
        m["nextAt"] = Date().timeIntervalSince1970 + delay
        writeMeta(m, to: metaURL)
        queue.asyncAfter(deadline: .now() + delay + 0.5) { [weak self] in self?.kick() }
    }

    // MARK: - Sidecar IO

    private func readMeta(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func writeMeta(_ m: [String: Any], to url: URL) {
        if let data = try? JSONSerialization.data(withJSONObject: m) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func excludeFromBackup(_ url: URL) {
        var u = url
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        try? u.setResourceValues(rv)
    }
}

// MARK: - URLSession delegate

extension SegmentUploader: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        queue.async { [self] in
            var b = bodies[dataTask.taskIdentifier] ?? Data()
            if b.count < 4096 { b.append(data) }
            bodies[dataTask.taskIdentifier] = b
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        queue.async { [self] in
            let body = bodies.removeValue(forKey: task.taskIdentifier)
            if let metaPath = task.taskDescription {
                completeLocked(metaPath: metaPath, status: status, body: body, error: error)
            }
            // Drain the next one(s).
            let due = pendingMetasLocked().filter { !inFlight.contains($0.path) && isDue($0) }
            for metaURL in due.prefix(max(0, maxConcurrent - inFlight.count)) { startUploadLocked(metaURL) }
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { [self] in
            backgroundCompletionHandler?()
            backgroundCompletionHandler = nil
        }
    }
}
