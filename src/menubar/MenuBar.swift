// Menu bar companion for Network File Sharing.
//
// Deliberately a thin viewer over the same state file the CLI reads: it shows
// whether the server is up and what URL to point a phone at, and shells back to
// `nfs` for anything that changes state. Nothing here duplicates server logic.

import AppKit
import Foundation

struct ServiceState: Decodable {
    let pid: Int?
    let port: Int?
    let scheme: String?
}

final class Controller: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private var timer: Timer?
    private let statePath: String
    private let nfsPath: String
    private var lastURL: String?

    init(statePath: String, nfsPath: String) {
        self.statePath = statePath
        self.nfsPath = nfsPath
    }

    func applicationDidFinishLaunching(_: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "arrow.up.arrow.down.circle",
                                   accessibilityDescription: "Network File Sharing")
            button.image?.isTemplate = true
        }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func readState() -> ServiceState? {
        guard let data = FileManager.default.contents(atPath: statePath) else { return nil }
        return try? JSONDecoder().decode(ServiceState.self, from: data)
    }

    private func isRunning(_ pid: Int?) -> Bool {
        guard let pid, pid > 0 else { return false }
        return kill(pid_t(pid), 0) == 0 || errno == EPERM
    }

    /// The Wi-Fi address, preferring the private ranges a phone can reach.
    private func lanAddress() -> String? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return nil }
        defer { freeifaddrs(head) }
        var best: String?
        var bestScore = Int.max
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            guard let addr = ptr.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host,
                              socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: host)
            let score: Int
            if ip.hasPrefix("192.168.") { score = 0 }
            else if ip.hasPrefix("10.") { score = 1 }
            else if ip.hasPrefix("172.") { score = 2 }
            else { score = 3 }
            if score < bestScore { bestScore = score; best = ip }
        }
        return best
    }

    private func refresh() {
        let state = readState()
        let up = isRunning(state?.pid)
        let ip = lanAddress()
        let url: String? = {
            guard let ip, let port = state?.port else { return nil }
            return "\(state?.scheme ?? "https")://\(ip):\(port)"
        }()
        lastURL = url

        item.button?.image = NSImage(
            systemSymbolName: up ? "arrow.up.arrow.down.circle.fill" : "arrow.up.arrow.down.circle",
            accessibilityDescription: "Network File Sharing")
        item.button?.image?.isTemplate = true

        let menu = NSMenu()
        let header = NSMenuItem(title: up ? "Running" : "Not running", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        if let url {
            let urlItem = NSMenuItem(title: url, action: #selector(copyURL), keyEquivalent: "")
            urlItem.target = self
            menu.addItem(urlItem)
            menu.addItem(NSMenuItem(title: "Copy link", action: #selector(copyURL), keyEquivalent: "c").with(target: self))
            menu.addItem(NSMenuItem(title: "Open in browser", action: #selector(openURL), keyEquivalent: "o").with(target: self))
        } else {
            let none = NSMenuItem(title: "No LAN address", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: up ? "Restart" : "Start", action: #selector(startOrRestart), keyEquivalent: "").with(target: self))
        if up { menu.addItem(NSMenuItem(title: "Stop", action: #selector(stopService), keyEquivalent: "").with(target: self)) }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit menu bar", action: #selector(quit), keyEquivalent: "q").with(target: self))
        item.menu = menu
    }

    private func runNfs(_ args: [String]) {
        let proc = Process()
        proc.executableURL = URL(fileURLToPath: nfsPath)
        proc.arguments = args
        try? proc.run()
    }

    @objc private func copyURL() {
        guard let lastURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lastURL, forType: .string)
    }

    @objc private func openURL() {
        guard let lastURL, let u = URL(string: lastURL) else { return }
        NSWorkspace.shared.open(u)
    }

    @objc private func startOrRestart() { runNfs(["restart"]); scheduleRefresh() }
    @objc private func stopService() { runNfs(["stop"]); scheduleRefresh() }
    @objc private func quit() { NSApp.terminate(nil) }

    private func scheduleRefresh() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.refresh() }
    }
}

private extension NSMenuItem {
    func with(target: AnyObject) -> NSMenuItem { self.target = target; return self }
}

private extension URL {
    init(fileURLToPath path: String) { self.init(fileURLWithPath: path) }
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: MenuBar <state.json> <path-to-nfs>\n".data(using: .utf8)!)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
let controller = Controller(statePath: args[1], nfsPath: args[2])
app.delegate = controller
app.run()
