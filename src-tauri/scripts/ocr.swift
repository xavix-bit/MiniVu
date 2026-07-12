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

@available(macOS 10.15, *)
func recognizeText(in cgImage: CGImage) {
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

    print(lines.joined(separator: "\n"))
}

if #available(macOS 10.15, *) {
    recognizeText(in: cgImage)
} else {
    fputs("OCR requires macOS 10.15 or newer\n", stderr)
    exit(1)
}
