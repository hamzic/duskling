import Foundation

// Mirrors extension/src/shared/{types,settings}.ts. Keep the two in step; the shared/settings/*.json fixtures
// are the contract (see ContractTests).

public enum ThemeID: String, Codable, Sendable, Equatable, CaseIterable {
    case dark, midnight, dim
}

public enum Mode: String, Codable, Sendable, Equatable, CaseIterable {
    case full, gentle, filter, off
}

/// Anything last-writer-wins merge can order.
protocol Stampable {
    var updatedAt: Int64 { get }
}

public struct Stamped<T: Codable & Sendable & Equatable>: Codable, Sendable, Equatable, Stampable {
    public var value: T
    public var updatedAt: Int64

    public init(value: T, updatedAt: Int64) {
        self.value = value
        self.updatedAt = updatedAt
    }
}

public struct SiteRule: Codable, Sendable, Equatable, Stampable {
    public var mode: Mode?
    public var theme: ThemeID?
    /// `"ignore"` or `"use"` (absent = follow global; `"use"` follows the site's dark theme even when it looks light).
    public var nativeDark: String?
    /// Overrides the global "Dim images" for this host and its subdomains (absent = follow global).
    public var dimImages: Bool?
    public var updatedAt: Int64
    /// Tombstone marker. Only ever `true` or absent (a decoded `false` is normalised to absent, as in `parseRule`).
    public var deleted: Bool?

    public init(mode: Mode? = nil, theme: ThemeID? = nil, nativeDark: String? = nil, dimImages: Bool? = nil, updatedAt: Int64,
                deleted: Bool? = nil) {
        self.mode = mode
        self.theme = theme
        self.nativeDark = nativeDark
        self.dimImages = dimImages
        self.updatedAt = updatedAt
        self.deleted = deleted
    }

    private enum CodingKeys: String, CodingKey { case mode, theme, nativeDark, dimImages, updatedAt, deleted }

    /// Strict like `parseRule`: a present-but-invalid field (including `null`) or a missing/non-integer `updatedAt`
    /// throws, and `Settings` then drops the rule. Unknown keys are ignored.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        updatedAt = try c.decode(Int64.self, forKey: .updatedAt)
        mode = c.contains(.mode) ? try c.decode(Mode.self, forKey: .mode) : nil
        theme = c.contains(.theme) ? try c.decode(ThemeID.self, forKey: .theme) : nil
        if c.contains(.nativeDark) {
            let v = try c.decode(String.self, forKey: .nativeDark)
            guard v == "ignore" || v == "use" else {
                throw DecodingError.dataCorruptedError(forKey: .nativeDark, in: c, debugDescription: "nativeDark must be \"ignore\" or \"use\"")
            }
            nativeDark = v
        } else {
            nativeDark = nil
        }
        dimImages = c.contains(.dimImages) ? try c.decode(Bool.self, forKey: .dimImages) : nil
        deleted = (try? c.decode(Bool.self, forKey: .deleted)) == true ? true : nil
    }
}

public struct Global: Codable, Sendable, Equatable {
    public var enabled: Stamped<Bool>
    public var theme: Stamped<ThemeID>
    public var respectNativeDark: Stamped<Bool>
    public var dimImages: Stamped<Bool>

    public init(enabled: Stamped<Bool>, theme: Stamped<ThemeID>, respectNativeDark: Stamped<Bool>, dimImages: Stamped<Bool>) {
        self.enabled = enabled
        self.theme = theme
        self.respectNativeDark = respectNativeDark
        self.dimImages = dimImages
    }
}

public struct Settings: Codable, Sendable, Equatable {
    public var schemaVersion: Int
    public var global: Global
    public var sites: [String: SiteRule]

    public init(schemaVersion: Int = 1, global: Global, sites: [String: SiteRule] = [:]) {
        self.schemaVersion = schemaVersion
        self.global = global
        self.sites = sites
    }

    public static let defaults = Settings(
        schemaVersion: 1,
        global: Global(
            enabled: Stamped(value: true, updatedAt: 0),
            theme: Stamped(value: .dark, updatedAt: 0),
            respectNativeDark: Stamped(value: true, updatedAt: 0),
            dimImages: Stamped(value: false, updatedAt: 0)),
        sites: [:])

    private enum CodingKeys: String, CodingKey { case schemaVersion, global, sites }
    private enum GlobalKeys: String, CodingKey { case enabled, theme, respectNativeDark, dimImages }

    /// Tolerant, mirroring `parseSettings`: an invalid global field becomes its default, an invalid site rule is
    /// dropped, unknown keys are ignored. Throws only when the top level is not a JSON object; use `parse(_:)` for a
    /// never-throwing variant. `updatedAt` is a JSON integer (Int64); a fractional stamp counts as invalid.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Settings.defaults.global
        let g = try? c.nestedContainer(keyedBy: GlobalKeys.self, forKey: .global)
        func field<V: Codable & Sendable & Equatable>(_ key: GlobalKeys, _ fallback: Stamped<V>) -> Stamped<V> {
            (try? g?.decode(Stamped<V>.self, forKey: key)) ?? fallback
        }
        schemaVersion = 1
        global = Global(
            enabled: field(.enabled, d.enabled),
            theme: field(.theme, d.theme),
            respectNativeDark: field(.respectNativeDark, d.respectNativeDark),
            dimImages: field(.dimImages, d.dimImages))
        let raw = (try? c.decode([String: Lossy<SiteRule>].self, forKey: .sites)) ?? [:]
        sites = raw.compactMapValues(\.value)
    }

    /// Never throws: anything that is not a JSON object yields `defaults`.
    public static func parse(_ data: Data) -> Settings {
        (try? JSONDecoder().decode(Settings.self, from: data)) ?? defaults
    }
}

private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// Sorted keys, no whitespace, unescaped slashes. Equivalent to the TypeScript `canonicalJson`: that sorts keys by
/// UTF-16 code units and `.sortedKeys` sorts by Unicode scalars; the two only differ for non-BMP keys, and site keys
/// are ASCII (punycode) hosts, so they agree.
public func canonicalJSON<T: Encodable>(_ v: T) -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // Encoding these plain value types cannot fail.
    return (try? e.encode(v)) ?? Data()
}
