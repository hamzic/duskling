import Foundation

/// Newer `updatedAt` wins; on a tie the value with the byte-wise larger canonical JSON wins. Total order, so the
/// pick is commutative, associative and idempotent.
private func pick<T: Encodable & Stampable>(_ a: T, _ b: T) -> T {
    if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt ? a : b }
    return canonicalJSON(b).lexicographicallyPrecedes(canonicalJSON(a)) ? a : b
}

/// Global fields and site rules alike are last-writer-wins per field/rule; sites are unioned and
/// tombstones count as entries. Whole rules are compared, never merged field by field.
public func merge(_ a: Settings, _ b: Settings) -> Settings {
    var sites = a.sites
    for (host, rule) in b.sites {
        sites[host] = sites[host].map { pick($0, rule) } ?? rule
    }
    return Settings(
        schemaVersion: 1,
        global: Global(
            enabled: pick(a.global.enabled, b.global.enabled),
            theme: pick(a.global.theme, b.global.theme),
            respectNativeDark: pick(a.global.respectNativeDark, b.global.respectNativeDark),
            dimImages: pick(a.global.dimImages, b.global.dimImages)),
        sites: sites)
}
