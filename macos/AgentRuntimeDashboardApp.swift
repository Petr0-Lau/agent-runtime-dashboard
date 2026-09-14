import Cocoa
import Foundation
import WebKit

@main
final class AgentRuntimeDashboardApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProcess: Process?
    private var outputPipe: Pipe?
    private var outputBuffer = ""
    private var didLoadDashboard = false

    static func main() {
        let application = NSApplication.shared
        let delegate = AgentRuntimeDashboardApp()
        application.delegate = delegate
        application.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false,
        )
        window.title = "Agent Runtime Dashboard"
        window.contentView = webView
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    func windowWillClose(_ notification: Notification) {
        stopServer()
    }

    private func startServer() {
        guard let resourceURL = Bundle.main.resourceURL else {
            showError("找不到 App 资源目录")
            return
        }

        let appRoot = resourceURL.appendingPathComponent("app")
        let nodeURL = resourceURL.appendingPathComponent("node")
        let serverURL = appRoot.appendingPathComponent("server/index.mjs")
        guard FileManager.default.fileExists(atPath: nodeURL.path), FileManager.default.fileExists(atPath: serverURL.path) else {
            showError("App 内缺少 Node 运行时或服务文件")
            return
        }

        let process = Process()
        process.executableURL = nodeURL
        process.arguments = [serverURL.path]
        process.currentDirectoryURL = appRoot

        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let pathEntries = [
            environment["PATH"],
            "\(home)/bin",
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ].compactMap { $0 }.joined(separator: ":")
        environment["PATH"] = pathEntries
        environment["PORT"] = "0"
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        outputPipe = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consumeOutput(data) }
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.didLoadDashboard else { return }
                self.showError("本地服务启动失败或已退出")
            }
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            showError("无法启动本地服务：\(error.localizedDescription)")
        }
    }

    private func consumeOutput(_ data: Data) {
        outputBuffer += String(data: data, encoding: .utf8) ?? ""
        while let newline = outputBuffer.firstIndex(of: "\n") {
            let line = String(outputBuffer[..<newline])
            outputBuffer.removeSubrange(...newline)
            let marker = "Agent Runtime API: http://127.0.0.1:"
            guard let markerRange = line.range(of: marker) else { continue }
            let portText = line[markerRange.upperBound...].prefix { $0.isNumber }
            guard let port = Int(portText), port > 0 else { continue }
            waitUntilReady(port)
        }
    }

    private func waitUntilReady(_ port: Int, attempts: Int = 60) {
        guard !didLoadDashboard else { return }
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] _, response, _ in
            guard let self else { return }
            if (response as? HTTPURLResponse)?.statusCode == 200 {
                DispatchQueue.main.async { self.loadDashboard(port: port) }
                return
            }
            guard attempts > 0 else {
                DispatchQueue.main.async { self.showError("本地服务健康检查超时") }
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) {
                self.waitUntilReady(port, attempts: attempts - 1)
            }
        }.resume()
    }

    private func loadDashboard(port: Int) {
        guard !didLoadDashboard else { return }
        didLoadDashboard = true
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
        webView.load(URLRequest(url: url))
    }

    private func showError(_ message: String) {
        let escaped = message.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        webView.loadHTMLString("<html><body style='font: -apple-system-body; padding: 32px'><h2>Agent Runtime Dashboard</h2><p>\(escaped)</p></body></html>", baseURL: nil)
    }

    private func stopServer() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        if let process = serverProcess, process.isRunning {
            process.terminate()
        }
        serverProcess = nil
        outputPipe = nil
    }
}
