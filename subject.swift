// Finds the subject of a cover, as Photos does when you lift one out of a picture, and
// writes it as a greyscale mask: white where the subject is, black behind it.
// Usage: subject <cover> <mask.png>. Exits 4 when the cover has no clear subject.
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

let args = CommandLine.arguments
guard args.count == 3,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(2) }

let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(cgImage: image)
do { try handler.perform([request]) } catch { exit(3) }
guard let found = request.results?.first, !found.allInstances.isEmpty,
      let buffer = try? found.generateScaledMaskForImage(forInstances: found.allInstances, from: handler) else { exit(4) }

let mask = CIImage(cvPixelBuffer: buffer)
guard let grey = CIContext().createCGImage(mask, from: mask.extent, format: .L8, colorSpace: CGColorSpaceCreateDeviceGray()),
      let out = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)
else { exit(5) }
CGImageDestinationAddImage(out, grey, nil)
exit(CGImageDestinationFinalize(out) ? 0 : 6)
