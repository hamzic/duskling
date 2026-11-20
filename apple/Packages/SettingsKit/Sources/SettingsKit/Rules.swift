import Foundation

// Mirrors extension/src/shared/rules.ts.

public struct EffectiveRule: Codable, Sendable, Equatable {
    public var enabled: Bool
    public var mode: Mode
    public var modeIsExplicit: Bool
    public var theme: ThemeID
    public var respectNativeDark: Bool
    /// A `"use"` rule: follow the site's declared dark theme even when it looks light.
    public var trustNativeDark: Bool
    public var dimImages: Bool
    public var matchedHost: String?

    public init(enabled: Bool, mode: Mode, modeIsExplicit: Bool, theme: ThemeID, respectNativeDark: Bool, trustNativeDark: Bool = false,
                dimImages: Bool, matchedHost: String?) {
        self.enabled = enabled
        self.mode = mode
        self.modeIsExplicit = modeIsExplicit
        self.theme = theme
        self.respectNativeDark = respectNativeDark
        self.trustNativeDark = trustNativeDark
        self.dimImages = dimImages
        self.matchedHost = matchedHost
    }
}

public let maxSites = 2000
let tombstoneTTLMillis: Int64 = 30 * 24 * 60 * 60 * 1000

/// `^\d{1,3}(\.\d{1,3}){3}$` with ASCII digits only (JS `\d`).
func isIPv4(_ s: String) -> Bool {
    let parts = s.split(separator: ".", omittingEmptySubsequences: false)
    return parts.count == 4 && parts.allSatisfy { p in
        (1...3).contains(p.utf8.count) && p.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }
}

/// The code points matched by JS `\s` (ECMAScript WhiteSpace + LineTerminator), including U+FEFF, which
/// `Character.isWhitespace` does not cover.
/// https://tc39.es/ecma262/#sec-white-space
func isJSWhitespace(_ u: Unicode.Scalar) -> Bool {
    switch u.value {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
}

/// Lowercase, strip one leading "www." and a trailing ".". Nil for empty input or input containing "/", ":" or whitespace.
public func normalizeHost(_ hostname: String) -> String? {
    if hostname.unicodeScalars.contains(where: { $0 == "/" || $0 == ":" || isJSWhitespace($0) }) { return nil }
    var h = hostname.lowercased()
    if isIPv4(h) { return h }
    if h.hasPrefix("www.") { h.removeFirst(4) }
    if h.hasSuffix(".") { h.removeLast() }
    return h.isEmpty ? nil : h
}

/// "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com", "com"]. IPv4 addresses are not split.
public func hostChain(_ host: String) -> [String] {
    if isIPv4(host) { return [host] }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    return labels.indices.map { labels[$0...].joined(separator: ".") }
}

/// `now - updatedAt > TTL` without trapping on Int64 overflow (a synced stamp can be any Int64).
func isOlderThanTTL(_ updatedAt: Int64, now: Int64) -> Bool {
    let (diff, overflow) = now.subtractingReportingOverflow(updatedAt)
    return overflow ? now > updatedAt : diff > tombstoneTTLMillis
}

extension Settings {
    /// Matches TypeScript `resolveSiteRule`: per field, the most specific live rule that sets it wins.
    public func resolve(host: String?) -> EffectiveRule {
        var mode: Mode?
        var theme = global.theme.value
        var themeSet = false
        var ignoreNative = false
        var native: String?
        var dimImages: Bool?
        var matchedHost: String?
        if let host, let normalized = normalizeHost(host) {
            for h in hostChain(normalized) {
                guard let rule = sites[h], rule.deleted != true else { continue }
                if matchedHost == nil { matchedHost = h }
                if mode == nil { mode = rule.mode }
                if !themeSet, let t = rule.theme {
                    theme = t
                    themeSet = true
                }
                if rule.nativeDark == "ignore" { ignoreNative = true }
                if native == nil { native = rule.nativeDark }
                if dimImages == nil { dimImages = rule.dimImages }
            }
        }
        return EffectiveRule(
            enabled: global.enabled.value,
            mode: mode ?? .full,
            modeIsExplicit: mode != nil,
            theme: theme,
            respectNativeDark: global.respectNativeDark.value && !ignoreNative,
            trustNativeDark: global.respectNativeDark.value && !ignoreNative && native == "use",
            dimImages: dimImages ?? global.dimImages.value,
            matchedHost: matchedHost)
    }

    /// Drops tombstones older than 30 days, then enforces `maxSites` (oldest tombstones first, then oldest rules).
    public func purgedAndLimited(now: Int64) -> Settings {
        var kept = sites.filter { !($0.value.deleted == true && isOlderThanTTL($0.value.updatedAt, now: now)) }
        if kept.count > maxSites {
            let byDrop = kept.sorted { l, r in
                let (lr, rr) = (l.value.deleted == true ? 0 : 1, r.value.deleted == true ? 0 : 1)
                if lr != rr { return lr < rr }
                if l.value.updatedAt != r.value.updatedAt { return l.value.updatedAt < r.value.updatedAt }
                return l.key.utf16.lexicographicallyPrecedes(r.key.utf16)
            }
            for (host, _) in byDrop.prefix(kept.count - maxSites) { kept[host] = nil }
        }
        var out = self
        out.sites = kept
        return out
    }
}
