import Foundation
import Capacitor
import ZIPFoundation

/**
 * OrZip — the only committed native code in Offline Reader.
 *
 * Two methods, nothing else:
 *
 *   list({ path })                         → { entries: [{ name, size }] }
 *   extract({ path, entryNames, destDir }) → { paths: [absolute paths, in entryNames order] }
 *
 * The point of going native is that archive bytes never cross the Capacitor
 * bridge: list() reads only the zip central directory, extract() streams
 * entries straight to disk through ZIPFoundation. JS receives names, sizes and
 * paths — never content. A 1.5 GB comic set indexes and reads with the webview
 * heap flat, which is the whole reason this plugin exists (PLAN.md §6.1).
 *
 * Security posture: `path` and `destDir` must resolve inside the app
 * container, and entry names come from arbitrary downloaded archives, so every
 * extraction target is canonicalized and prefix-checked against destDir before
 * a byte is written. A "../../Library/Cookies" entry dies here, not in JS.
 */
@objc(OrZipPlugin)
public class OrZipPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OrZipPlugin"
    public let jsName = "OrZip"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "extract", returnType: CAPPluginReturnPromise)
    ]

    // iOS mounts the app container under /var, which is a symlink to
    // /private/var. Filesystem.getUri hands JS the /var form while
    // canonicalization yields /private/var, so BOTH sides of every containment
    // check must be symlink-resolved or every legitimate path fails the test.
    private var containerRoot: String {
        return URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path
    }

    /// Accepts an absolute path or a file:// URL. Returns the canonical path
    /// only when it lives inside the app container, else nil.
    private func containedPath(_ raw: String?) -> String? {
        guard var path = raw else { return nil }
        if path.hasPrefix("file://") {
            guard let url = URL(string: path), url.isFileURL else { return nil }
            path = url.path
        }
        guard path.hasPrefix("/") else { return nil }
        let resolved = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
        let root = containerRoot
        guard resolved == root || resolved.hasPrefix(root + "/") else { return nil }
        return resolved
    }

    @objc public func list(_ call: CAPPluginCall) {
        guard let src = containedPath(call.getString("path")) else {
            call.reject("path must be an absolute path inside the app container")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let archive = try Archive(url: URL(fileURLWithPath: src), accessMode: .read)
                // The central directory alone: every entry verbatim (directories
                // included, trailing "/" and all) so JS-side name heuristics see
                // exactly what JSZip would have shown them.
                var entries: [[String: Any]] = []
                for entry in archive {
                    entries.append([
                        "name": entry.path,
                        "size": Int(clamping: entry.uncompressedSize)
                    ])
                }
                call.resolve(["entries": entries])
            } catch {
                call.reject("cannot read archive: \(error.localizedDescription)")
            }
        }
    }

    @objc public func extract(_ call: CAPPluginCall) {
        guard let src = containedPath(call.getString("path")) else {
            call.reject("path must be an absolute path inside the app container")
            return
        }
        guard let destParam = containedPath(call.getString("destDir")) else {
            call.reject("destDir must be an absolute path inside the app container")
            return
        }
        guard let names = call.getArray("entryNames", String.self), !names.isEmpty else {
            call.reject("entryNames must be a non-empty array of strings")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let fm = FileManager.default
            do {
                try fm.createDirectory(atPath: destParam, withIntermediateDirectories: true)
                // Re-resolve after creation so the root itself is canonical.
                let destRoot = URL(fileURLWithPath: destParam).resolvingSymlinksInPath().path
                let archive = try Archive(url: URL(fileURLWithPath: src), accessMode: .read)
                var paths: [String] = []
                for name in names {
                    guard let entry = archive[name] else {
                        call.reject("entry not found in archive: \(name)")
                        return
                    }
                    // No legitimate comic archive ships symlinks, and a planted
                    // link is the one thing that could make a later entry's
                    // lexical containment check lie. Refusing them outright is
                    // what keeps the per-entry check below sufficient.
                    if entry.type == .symlink {
                        call.reject("refusing symlink entry: \(name)")
                        return
                    }
                    // Containment: entry names are attacker-controlled, so join
                    // them under destDir as plain path strings (a leading "/" is
                    // neutralized, not honored) and resolve before comparing.
                    let joined = (destRoot as NSString).appendingPathComponent(name)
                    let target = URL(fileURLWithPath: joined).standardizedFileURL.resolvingSymlinksInPath().path
                    guard target == destRoot || target.hasPrefix(destRoot + "/") else {
                        call.reject("entry resolves outside destDir: \(name)")
                        return
                    }
                    if entry.type == .directory {
                        try fm.createDirectory(atPath: target, withIntermediateDirectories: true)
                        paths.append(target)
                        continue
                    }
                    let parent = (target as NSString).deletingLastPathComponent
                    try fm.createDirectory(atPath: parent, withIntermediateDirectories: true)
                    // Re-extraction after a page-cache prune is routine, and
                    // ZIPFoundation refuses to overwrite — clear leftovers first.
                    if fm.fileExists(atPath: target) {
                        try? fm.removeItem(atPath: target)
                    }
                    _ = try archive.extract(entry, to: URL(fileURLWithPath: target))
                    paths.append(target)
                }
                call.resolve(["paths": paths])
            } catch {
                call.reject("extract failed: \(error.localizedDescription)")
            }
        }
    }
}
