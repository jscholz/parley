import Foundation
import UIKit

/// Uploader → plugin callbacks (delivered on the uploader's queue).
protocol SegmentUploaderDelegate: AnyObject {
    func uploader(_ u: SegmentUploader, didUpload captureId: String, seq: Int)
    func uploader(_ u: SegmentUploader, didFail captureId: String, seq: Int, status: Int, parked: Bool, error: String?)
    func uploader(_ u: SegmentUploader, networkOnline online: Bool)
}

/// Drains sealed segment files to the server (2026-11-16, reworked 11-18).
///
/// The native twin of src/capture/uploader.ts's segment lane, speaking the
/// same wire protocol: `POST {uploadBase}/api/parley/captures/{id}/segments/{seq}`
/// with the file as the body, `x-parley-t0-ms`, `x-parley-sha256` and
/// `x-parley-client` headers. Registration / activate / marks / stop stay
/// on the JS side, which waits for this lane to be empty before posting
/// the deferred stop.
///
/// TWO LANES (field 2026-11-17/18: two meetings recorded perfectly to disk
/// and the server received nothing for hours). The first version put every
/// upload on a *background* URLSession. That session lives in a system
/// daemon which retries a failed task on its own slow schedule, invisible
/// to us — 63 segments sat there while the app was open and connected.
///   * FOREGROUND lane: while the app is active, a plain URLSession with our
///     own immediate retry/backoff. Fast, observable, ours.
///   * BACKGROUND lane: only when the app is suspended (locked phone mid-
///     meeting), the background session carries what is due, so uploads
///     continue without us. On return to the foreground its unfinished
///     tasks are cancelled and the files go back to the foreground lane.
///
/// Durability: the segment file and its sidecar JSON stay on disk until the
/// server has acknowledged the segment. Outcomes mirror the web uploader:
///   2xx            → acked, files deleted, `uploaded`
///   409 "frozen"   → the capture was finalized before this landed: PARK
///                    (keep the file for the retention window, stop retrying)
///   404            → the capture is not registered yet (JS does that):
///                    retry with backoff
///   429 / 5xx / no network → retry with backoff
///   other 4xx      → permanent, dropped
/// Every failure is reported with its status and error text so the JS
/// health ping carries it to the server's audit.
final class SegmentUploader: NSObject {
    static let shared = SegmentUploader()

    weak var delegate: SegmentUploaderDelegate?

    /// Set by AppDelegate.application(_:handleEventsForBackgroundURLSession:…)
    /// and called once the background session has delivered every pending event.
    var backgroundCompletionHandler: (() -> Void)?

    static let sessionIdentifier = "ai.parley.capture-uploads"
    private let maxConcurrent = 2
    private let retentionDays = 7.0
    private let queue = DispatchQueue(label: "ai.parley.uploader")
    private var inFlight = Set<String>()         // meta paths with a task running (either lane)
    private var bgBodies = [Int: Data]()         // background task id → response body
    private var bgTaskIds = [Int: String]()      // background task id → meta path
    private var foregroundActive = true
    private var bgTimeTask: UIBackgroundTaskIdentifier = .invalid

    // Diagnostics for status()/health.
    private(set) var stats = Stats()
    struct Stats {
        var uploaded = 0
        var failed = 0
        var lastStatus: Int? = nil
        var lastError: String? = nil
        var lastLane: String? = nil
        var lastAttemptAt: TimeInterval? = nil
        var lastSuccessAt: TimeInterval? = nil
    }

    private lazy var foregroundSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = false
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 180
        return URLSession(configuration: cfg)
    }()

    private lazy var backgroundSession: URLSession = {
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
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(onForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(onBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    // MARK: - Lifecycle

    @objc private func onForeground() {
        queue.async { [self] in
            foregroundActive = true
            // Take the files back from the daemon: whatever it has not finished
            // is ours to send now, immediately and observably.
            backgroundSession.getAllTasks { tasks in
                for t in tasks { t.cancel() }
                self.queue.async { [self] in
                    inFlight.removeAll()
                    bgTaskIds.removeAll()
                    kickLocked(reason: "foreground")
                }
            }
        }
    }

    @objc private func onBackground() {
        queue.async { [self] in
            foregroundActive = false
            // Hand everything due to the background session so uploads continue
            // while suspended; a foreground task mid-flight gets a few seconds
            // of background time to finish on its own.
            if bgTimeTask == .invalid {
                bgTimeTask = UIApplication.shared.beginBackgroundTask(withName: "parley-upload-handoff") { [weak self] in
                    self?.endBgTime()
                }
            }
            kickLocked(reason: "background")
            queue.asyncAfter(deadline: .now() + 20) { [weak self] in self?.endBgTime() }
        }
    }

    private func endBgTime() {
        if bgTimeTask != .invalid {
            UIApplication.shared.endBackgroundTask(bgTimeTask)
            bgTimeTask = .invalid
        }
    }

    // MARK: - Public API

    func enqueue(_ seg: NativeRecorder.SealedSegment) {
        excludeFromBackup(seg.fileURL)
        excludeFromBackup(seg.metaURL)
        kick()
    }

    /// Start uploads for everything due. Safe to call often.
    func kick() {
        queue.async { [self] in kickLocked(reason: "kick") }
    }

    /// Sealed segments not yet acknowledged (parked ones excluded), plus
    /// the raw counts for diagnosis.
    func pending(captureId: String?) -> (count: Int, captureIds: [String]) {
        return queue.sync {
            let rows = pendingRowsLocked().filter { !$0.parked && (captureId == nil || $0.captureId == captureId!) }
            return (rows.count, Array(Set(rows.map { $0.captureId })).sorted())
        }
    }

    func diagnostics() -> [String: Any] {
        return queue.sync {
            let rows = pendingRowsLocked()
            let now = Date().timeIntervalSince1970
            var out: [String: Any] = [
                "files_on_disk": rows.count,
                "parked": rows.filter { $0.parked }.count,
                "due": rows.filter { !$0.parked && $0.nextAt <= now }.count,
                "in_flight": inFlight.count,
                "lane": foregroundActive ? "foreground" : "background",
                "uploaded": stats.uploaded,
                "failed": stats.failed,
            ]
            if let v = stats.lastStatus { out["last_status"] = v }
            if let v = stats.lastError { out["last_error"] = v }
            if let v = stats.lastLane { out["last_lane"] = v }
            if let v = stats.lastAttemptAt { out["last_attempt_at"] = Int(v * 1000) }
            if let v = stats.lastSuccessAt { out["last_success_at"] = Int(v * 1000) }
            if let first = rows.first(where: { !$0.parked }) { out["next_seq"] = first.seq; out["next_capture"] = first.captureId }
            return out
        }
    }

    // MARK: - Scheduling (queue-locked)

    private struct Row {
        let metaURL: URL
        let captureId: String
        let seq: Int
        let parked: Bool
        let nextAt: TimeInterval
        let meta: [String: Any]
    }

    private func pendingRowsLocked() -> [Row] {
        let root = NativeRecorder.capturesRoot()
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
        var rows: [Row] = []
        for case let url as URL in e where url.pathExtension == "json" {
            guard let m = readMeta(url), let id = m["captureId"] as? String else { continue }
            let seq = (m["seq"] as? Int) ?? Int((m["seq"] as? Double) ?? 0)
            rows.append(Row(metaURL: url, captureId: id, seq: seq, parked: (m["parked"] as? Bool) ?? false,
                            nextAt: (m["nextAt"] as? Double) ?? 0, meta: m))
        }
        // Oldest capture, lowest seq first: the server's manifest stays
        // append-mostly and the rolling transcriber's life stays easy.
        return rows.sorted { a, b in a.captureId != b.captureId ? a.captureId < b.captureId : a.seq < b.seq }
    }

    private func kickLocked(reason: String) {
        purgeOldParkedLocked()
        let now = Date().timeIntervalSince1970
        let due = pendingRowsLocked().filter { !$0.parked && $0.nextAt <= now && !inFlight.contains($0.metaURL.path) }
        let slots = max(0, maxConcurrent - inFlight.count)
        for row in due.prefix(slots) {
            if foregroundActive { startForegroundLocked(row) } else { startBackgroundLocked(row) }
        }
        if !due.isEmpty || !inFlight.isEmpty {
            NSLog("[Parley] upload kick (\(reason)): due=\(due.count) inFlight=\(inFlight.count) lane=\(foregroundActive ? "fg" : "bg")")
        }
    }

    private func makeRequest(_ row: Row) -> (URLRequest, URL)? {
        let m = row.meta
        guard let base = m["uploadBase"] as? String,
              let url = URL(string: "\(base)/api/parley/captures/\(row.captureId)/segments/\(row.seq)") else {
            try? FileManager.default.removeItem(at: row.metaURL)
            return nil
        }
        let fileURL = row.metaURL.deletingPathExtension().appendingPathExtension("m4a")
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            try? FileManager.default.removeItem(at: row.metaURL)   // audio gone: nothing to send
            return nil
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue((m["mime"] as? String) ?? "audio/mp4", forHTTPHeaderField: "Content-Type")
        let t0 = (m["t0Ms"] as? Int64) ?? Int64((m["t0Ms"] as? Double) ?? 0)
        req.setValue(String(t0), forHTTPHeaderField: "x-parley-t0-ms")
        if let sha = m["sha256"] as? String, !sha.isEmpty { req.setValue(sha, forHTTPHeaderField: "x-parley-sha256") }
        req.setValue((m["client"] as? String) ?? "cap-recorder", forHTTPHeaderField: "x-parley-client")
        return (req, fileURL)
    }

    private func startForegroundLocked(_ row: Row) {
        guard let made = makeRequest(row) else { return }
        let (req, fileURL) = made
        let metaPath = row.metaURL.path
        inFlight.insert(metaPath)
        stats.lastAttemptAt = Date().timeIntervalSince1970
        stats.lastLane = "foreground"
        NSLog("[Parley] upload started (fg) capture=\(row.captureId) seq=\(row.seq)")
        let task = foregroundSession.uploadTask(with: req, fromFile: fileURL) { [weak self] data, response, error in
            guard let self = self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            self.queue.async {
                self.inFlight.remove(metaPath)
                self.completeLocked(metaPath: metaPath, status: status, body: data, error: error, lane: "fg")
                self.kickLocked(reason: "fg-complete")
            }
        }
        task.resume()
    }

    private func startBackgroundLocked(_ row: Row) {
        guard let made = makeRequest(row) else { return }
        let (req, fileURL) = made
        let metaPath = row.metaURL.path
        let task = backgroundSession.uploadTask(with: req, fromFile: fileURL)
        task.taskDescription = metaPath
        inFlight.insert(metaPath)
        bgTaskIds[task.taskIdentifier] = metaPath
        stats.lastAttemptAt = Date().timeIntervalSince1970
        stats.lastLane = "background"
        task.resume()
        NSLog("[Parley] upload started (bg) capture=\(row.captureId) seq=\(row.seq)")
    }

    private func purgeOldParkedLocked() {
        let cutoff = Date().timeIntervalSince1970 - retentionDays * 86_400
        for row in pendingRowsLocked() where row.parked {
            let sealedAt = (row.meta["sealedAt"] as? Double) ?? 0
            if sealedAt < cutoff {
                try? FileManager.default.removeItem(at: row.metaURL.deletingPathExtension().appendingPathExtension("m4a"))
                try? FileManager.default.removeItem(at: row.metaURL)
            }
        }
    }

    // MARK: - Outcomes (queue-locked)

    private func completeLocked(metaPath: String, status: Int, body: Data?, error: Error?, lane: String) {
        let metaURL = URL(fileURLWithPath: metaPath)
        guard var m = readMeta(metaURL),
              let captureId = m["captureId"] as? String else { return }
        let seq = (m["seq"] as? Int) ?? Int((m["seq"] as? Double) ?? 0)
        let fileURL = metaURL.deletingPathExtension().appendingPathExtension("m4a")
        stats.lastStatus = status

        if let error = error as NSError? {
            let offline = error.domain == NSURLErrorDomain
                && [NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed].contains(error.code)
            // A cancelled background task (foreground takeover) is not a failure.
            if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
            let text = "\(error.domain) \(error.code): \(error.localizedDescription)"
            stats.failed += 1
            stats.lastError = text
            delegate?.uploader(self, networkOnline: !offline)
            scheduleRetryLocked(m: &m, at: metaURL)
            delegate?.uploader(self, didFail: captureId, seq: seq, status: 0, parked: false, error: text)
            NSLog("[Parley] upload failed (\(lane)) capture=\(captureId) seq=\(seq): \(text)")
            return
        }
        delegate?.uploader(self, networkOnline: true)
        if (200..<300).contains(status) {
            try? FileManager.default.removeItem(at: fileURL)
            try? FileManager.default.removeItem(at: metaURL)
            stats.uploaded += 1
            stats.lastError = nil
            stats.lastSuccessAt = Date().timeIntervalSince1970
            delegate?.uploader(self, didUpload: captureId, seq: seq)
            NSLog("[Parley] upload acked (\(lane)) capture=\(captureId) seq=\(seq)")
            return
        }
        let text = body.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        stats.failed += 1
        stats.lastError = "HTTP \(status) \(text.prefix(160))"
        if status == 409 && text.range(of: "frozen", options: .caseInsensitive) != nil {
            m["parked"] = true
            writeMeta(m, to: metaURL)
            delegate?.uploader(self, didFail: captureId, seq: seq, status: status, parked: true, error: stats.lastError)
            NSLog("[Parley] upload parked (capture frozen) capture=\(captureId) seq=\(seq)")
            return
        }
        if status == 404 || status == 409 || status == 429 || status >= 500 {
            scheduleRetryLocked(m: &m, at: metaURL)
            delegate?.uploader(self, didFail: captureId, seq: seq, status: status, parked: false, error: stats.lastError)
            NSLog("[Parley] upload failed (\(lane)) capture=\(captureId) seq=\(seq): HTTP \(status) \(text.prefix(120))")
            return
        }
        // Other 4xx: permanent. Drop, like the web uploader.
        try? FileManager.default.removeItem(at: fileURL)
        try? FileManager.default.removeItem(at: metaURL)
        delegate?.uploader(self, didFail: captureId, seq: seq, status: status, parked: false, error: stats.lastError)
        NSLog("[Parley] upload dropped (\(status)) capture=\(captureId) seq=\(seq)")
    }

    private func scheduleRetryLocked(m: inout [String: Any], at metaURL: URL) {
        let attempts = ((m["attempts"] as? Int) ?? 0) + 1
        let delay = min(60.0, 2.0 * pow(2.0, Double(min(attempts - 1, 5))))
        m["attempts"] = attempts
        m["nextAt"] = Date().timeIntervalSince1970 + delay
        writeMeta(m, to: metaURL)
        queue.asyncAfter(deadline: .now() + delay + 0.5) { [weak self] in self?.queue.async { self?.kickLocked(reason: "retry") } }
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

// MARK: - Background session delegate

extension SegmentUploader: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        queue.async { [self] in
            var b = bgBodies[dataTask.taskIdentifier] ?? Data()
            if b.count < 4096 { b.append(data) }
            bgBodies[dataTask.taskIdentifier] = b
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        queue.async { [self] in
            let body = bgBodies.removeValue(forKey: task.taskIdentifier)
            let metaPath = bgTaskIds.removeValue(forKey: task.taskIdentifier) ?? task.taskDescription
            if let metaPath = metaPath {
                inFlight.remove(metaPath)
                completeLocked(metaPath: metaPath, status: status, body: body, error: error, lane: "bg")
            }
            kickLocked(reason: "bg-complete")
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { [self] in
            backgroundCompletionHandler?()
            backgroundCompletionHandler = nil
        }
    }
}
