import SwiftUI

/// THIRD_PARTY_NOTICES.md, bundled as an app resource (project.yml), with headings and code blocks styled.
struct LicensesView: View {
    private let blocks = NoticeBlock.load()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(blocks) { block in
                    switch block.kind {
                    case .heading:
                        Text(block.text).font(.headline).accessibilityAddTraits(.isHeader)
                    case .paragraph:
                        Text((try? AttributedString(markdown: block.text)) ?? AttributedString(block.text))
                    case .code:
                        Text(block.text).font(.footnote)
                    }
                }
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .navigationTitle("Open-source licenses")
        .toolbarTitleDisplayMode(.inline)
    }
}

struct NoticeBlock: Identifiable {
    enum Kind { case heading, paragraph, code }
    var id: Int
    var kind: Kind
    var text: String

    static func load(bundle: Bundle = .main) -> [NoticeBlock] {
        guard let url = bundle.url(forResource: "THIRD_PARTY_NOTICES", withExtension: "md"),
              let source = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return parse(source)
    }

    /// Minimal Markdown: "#" headings, ``` fenced blocks (license text, reflowed per paragraph so it wraps to the
    /// screen), and paragraphs separated by blank lines.
    static func parse(_ source: String) -> [NoticeBlock] {
        var blocks: [NoticeBlock] = []
        var buffer: [String] = []
        var inCode = false
        func flush(_ kind: Kind) {
            let text = buffer.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { blocks.append(NoticeBlock(id: blocks.count, kind: kind, text: text)) }
            buffer = []
        }
        for line in source.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                flush(inCode ? .code : .paragraph)
                inCode.toggle()
            } else if inCode {
                if line.trimmingCharacters(in: .whitespaces).isEmpty { flush(.code) } else { buffer.append(line) }
            } else if line.hasPrefix("#") {
                flush(.paragraph)
                buffer = [line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)]
                flush(.heading)
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flush(.paragraph)
            } else {
                buffer.append(line)
            }
        }
        flush(inCode ? .code : .paragraph)
        return blocks
    }
}
