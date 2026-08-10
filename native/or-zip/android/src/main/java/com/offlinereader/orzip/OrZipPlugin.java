package com.offlinereader.orzip;

import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Enumeration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * OrZip — the only committed native code in Offline Reader.
 *
 * Two methods, nothing else:
 *
 *   list({ path })                         → { entries: [{ name, size }] }
 *   extract({ path, entryNames, destDir }) → { paths: [absolute paths, in entryNames order] }
 *
 * The point of going native is that archive bytes never cross the Capacitor
 * bridge: list() reads only the zip central directory (java.util.zip.ZipFile
 * — platform API, no third-party dependency on this side), extract() streams
 * entries straight to disk. JS receives names, sizes and paths — never
 * content.
 *
 * Security posture: `path` and `destDir` must resolve inside the app
 * container, and entry names come from arbitrary downloaded archives, so
 * every extraction target is canonicalized and prefix-checked against destDir
 * before a byte is written. A "../../shared_prefs/x.xml" entry dies here, not
 * in JS. (java.util.zip has no symlink concept — entries always land as
 * regular files — so the canonical-path check cannot be undermined by a
 * planted link the way it could on iOS.)
 */
@CapacitorPlugin(name = "OrZip")
public class OrZipPlugin extends Plugin {

    // One worker keeps extraction off the bridge's shared plugin-call thread,
    // so a long chapter extraction cannot stall unrelated plugin traffic
    // (Preferences writes, haptics). One is enough: callers extract chapters
    // sequentially by design.
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void list(final PluginCall call) {
        final File src = containedFile(call.getString("path"));
        if (src == null) {
            call.reject("path must be an absolute path inside the app container");
            return;
        }
        worker.execute(() -> {
            try (ZipFile zip = new ZipFile(src)) {
                // The central directory alone: every entry verbatim
                // (directories included, trailing "/" and all) so JS-side name
                // heuristics see exactly what JSZip would have shown them.
                JSArray entries = new JSArray();
                Enumeration<? extends ZipEntry> en = zip.entries();
                while (en.hasMoreElements()) {
                    ZipEntry entry = en.nextElement();
                    JSObject row = new JSObject();
                    row.put("name", entry.getName());
                    row.put("size", Math.max(0L, entry.getSize()));
                    entries.put(row);
                }
                JSObject ret = new JSObject();
                ret.put("entries", entries);
                call.resolve(ret);
            } catch (IOException ex) {
                call.reject("cannot read archive: " + ex.getMessage());
            }
        });
    }

    @PluginMethod
    public void extract(final PluginCall call) {
        final File src = containedFile(call.getString("path"));
        final File destParam = containedFile(call.getString("destDir"));
        final JSArray names = call.getArray("entryNames");
        if (src == null) {
            call.reject("path must be an absolute path inside the app container");
            return;
        }
        if (destParam == null) {
            call.reject("destDir must be an absolute path inside the app container");
            return;
        }
        if (names == null || names.length() == 0) {
            call.reject("entryNames must be a non-empty array of strings");
            return;
        }
        worker.execute(() -> {
            try (ZipFile zip = new ZipFile(src)) {
                if (!destParam.isDirectory() && !destParam.mkdirs()) {
                    throw new IOException("cannot create destDir");
                }
                // Canonicalize the root once so every entry compares against
                // the same resolved prefix.
                String destRoot = destParam.getCanonicalPath();
                JSArray paths = new JSArray();
                for (int i = 0; i < names.length(); i++) {
                    String name = names.getString(i);
                    ZipEntry entry = zip.getEntry(name);
                    if (entry == null) {
                        call.reject("entry not found in archive: " + name);
                        return;
                    }
                    // Containment: entry names are attacker-controlled.
                    // getCanonicalPath resolves ".." and symlinked parents;
                    // anything that lands outside destRoot is refused.
                    String canonical = new File(destParam, name).getCanonicalPath();
                    if (!canonical.equals(destRoot) && !canonical.startsWith(destRoot + File.separator)) {
                        call.reject("entry resolves outside destDir: " + name);
                        return;
                    }
                    if (entry.isDirectory()) {
                        new File(canonical).mkdirs();
                        paths.put(canonical);
                        continue;
                    }
                    File parent = new File(canonical).getParentFile();
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                        throw new IOException("cannot create " + parent);
                    }
                    // FileOutputStream truncates, which quietly heals leftovers
                    // from an interrupted extraction after a page-cache prune.
                    try (InputStream in = zip.getInputStream(entry);
                         OutputStream out = new FileOutputStream(canonical)) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            out.write(buf, 0, n);
                        }
                    }
                    paths.put(canonical);
                }
                JSObject ret = new JSObject();
                ret.put("paths", paths);
                call.resolve(ret);
            } catch (Exception ex) {
                call.reject("extract failed: " + ex.getMessage());
            }
        });
    }

    /**
     * Resolve raw (an absolute path or a file:// URL) to a canonical File, but
     * only when it lives inside the app container — the data dir plus the
     * app-specific external dirs, which is everywhere Capacitor's Filesystem
     * plugin can legitimately point us. Anything else returns null.
     */
    private File containedFile(String raw) {
        if (raw == null) {
            return null;
        }
        String path = raw;
        if (raw.startsWith("file://")) {
            path = Uri.parse(raw).getPath();
        }
        if (path == null || !path.startsWith("/")) {
            return null;
        }
        try {
            String canonical = new File(path).getCanonicalPath();
            File[] roots = {
                getContext().getDataDir(),
                getContext().getExternalFilesDir(null),
                getContext().getExternalCacheDir()
            };
            for (File root : roots) {
                if (root == null) {
                    continue;
                }
                String r = root.getCanonicalPath();
                if (canonical.equals(r) || canonical.startsWith(r + File.separator)) {
                    return new File(canonical);
                }
            }
        } catch (IOException ignored) {
            // Fall through to null: an unresolvable path is an uncontained one.
        }
        return null;
    }
}
