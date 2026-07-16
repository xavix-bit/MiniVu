import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count > 1 else {
    fputs("missing image path\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let nsImage = NSImage(contentsOf: imageURL),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    fputs("unable to load image\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fputs("vision failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}

var lines: [String] = []
if let results = request.results {
    for observation in results {
        if let candidate = observation.topCandidates(1).first {
            lines.append(candidate.string)
        }
    }
}

print("__MINIVU_OCR_BEGIN__")
print(lines.joined(separator: "\n"))
print("__MINIVU_OCR_END__")
