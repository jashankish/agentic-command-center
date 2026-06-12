// commit-summarizer: generates one-line commit summaries with Apple's on-device
// foundation model (FoundationModels framework, macOS 26+).
//
// Protocol (JSON Lines over stdio):
//   stdin   {"id":"<hash>","text":"<commit message + file stats>"}   one per line
//   stdout  first line, always:  {"available":true}
//                            or  {"available":false,"reason":"deviceNotEligible"|
//                                 "appleIntelligenceNotEnabled"|"modelNotReady"|"other"}
//           then, per request:   {"id":"…","summary":"…"}
//                            or  {"id":"…","error":"guardrail"|"context"|"unavailable"|"other"}
// With --check the process exits right after the availability line.

import Foundation
import FoundationModels

struct Request: Decodable {
  let id: String
  let text: String
}

@main
struct CommitSummarizer {
  static let instructions = """
    You summarize git commits for a developer activity feed.
    Reply with one terse fragment of at most 8 words stating what changed.
    Start with a present-tense verb (adds, fixes, removes, updates).
    Plain text only: no quotes, no trailing period, no emoji, no preamble.
    Describe the change itself, not file names or implementation detail.
    """

  static func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    // print to a pipe is block-buffered; flush so the host sees each line live.
    print(line)
    fflush(stdout)
  }

  static func reasonCode(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
    switch reason {
    case .deviceNotEligible: return "deviceNotEligible"
    case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
    case .modelNotReady: return "modelNotReady"
    @unknown default: return "other"
    }
  }

  static func errorCode(_ error: Error) -> String {
    guard let generationError = error as? LanguageModelSession.GenerationError else {
      return "other"
    }
    switch generationError {
    case .guardrailViolation: return "guardrail"
    case .exceededContextWindowSize: return "context"
    case .assetsUnavailable: return "unavailable"
    default: return "other"
    }
  }

  /// First line of the response, with decoration the model tends to add stripped.
  static func clean(_ raw: String) -> String {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if let newline = s.firstIndex(of: "\n") { s = String(s[..<newline]) }
    if s.lowercased().hasPrefix("summary:") { s = String(s.dropFirst("summary:".count)) }
    while let first = s.first, "\"'`“”".contains(first) { s.removeFirst() }
    while let last = s.last, "\"'`“”.".contains(last) { s.removeLast() }
    return s.trimmingCharacters(in: .whitespaces)
  }

  static func main() async {
    switch SystemLanguageModel.default.availability {
    case .available:
      emit(["available": true])
    case .unavailable(let reason):
      emit(["available": false, "reason": reasonCode(reason)])
      return
    @unknown default:
      emit(["available": false, "reason": "other"])
      return
    }
    if CommandLine.arguments.contains("--check") { return }

    while let line = readLine(strippingNewline: true) {
      guard !line.isEmpty,
            let data = line.data(using: .utf8),
            let request = try? JSONDecoder().decode(Request.self, from: data) else { continue }
      // A fresh session per commit keeps each summary independent — reusing one
      // session grows its transcript until it overflows the context window.
      let session = LanguageModelSession(instructions: instructions)
      let options = GenerationOptions(sampling: .greedy, maximumResponseTokens: 30)
      do {
        let response = try await session.respond(
          to: Prompt("Summarize this git commit:\n\n\(request.text)"),
          options: options
        )
        emit(["id": request.id, "summary": clean(response.content)])
      } catch {
        emit(["id": request.id, "error": errorCode(error)])
      }
    }
  }
}
