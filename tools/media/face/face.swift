// Local face analysis with Apple Vision (macOS only, no downloads, nothing leaves the machine).
//
//   face detect <image>...            → one JSON line per image: faces with box, pose, capture quality, geometry
//   face crop <image> <out.png> [px]  → the largest face, roll-aligned, tight square crop (default 256 px)
//   face print <crop.png>...          → one JSON line per crop: Vision feature print (float array)
//
// Vision has no public face-identity embedding, so likeness (tools/media/src/likeness.ts) combines
// the generic image feature print of tight, aligned face crops with landmark geometry (eye size,
// face length, nose and mouth width relative to the eye distance). Calibrated against the references.
import AppKit
import CoreImage
import Foundation
import Vision

struct Geometry: Codable {
  /// Eye width ÷ inter-pupil distance (bigger = larger eyes).
  var eyeWidth: Double
  /// Eye opening height ÷ eye width.
  var eyeOpen: Double
  /// Face contour height (brow line → chin) ÷ contour width.
  var faceLength: Double
  /// Nose width ÷ inter-pupil distance.
  var noseWidth: Double
  /// Mouth width ÷ inter-pupil distance.
  var mouthWidth: Double
  /// Pupil line → mouth centre ÷ inter-pupil distance.
  var eyeMouth: Double
  /// Mouth centre → chin ÷ inter-pupil distance.
  var chin: Double
}

struct Face: Codable {
  var x: Double; var y: Double; var w: Double; var h: Double  // pixels, top-left origin
  var yaw: Double?; var pitch: Double?; var roll: Double?  // degrees
  var quality: Double?
  var geometry: Geometry?
}

struct DetectResult: Codable { var file: String; var width: Int; var height: Int; var faces: [Face] }
struct PrintResult: Codable { var file: String; var print: [Float] }

func loadCG(_ path: String) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldAllowFloat: false] as CFDictionary)
}

func deg(_ n: NSNumber?) -> Double? { n.map { $0.doubleValue * 180 / .pi } }

func dist(_ a: CGPoint, _ b: CGPoint) -> Double { Double(hypot(a.x - b.x, a.y - b.y)) }

func centroid(_ pts: [CGPoint]) -> CGPoint {
  let n = CGFloat(max(pts.count, 1))
  return CGPoint(x: pts.map(\.x).reduce(0, +) / n, y: pts.map(\.y).reduce(0, +) / n)
}

func span(_ pts: [CGPoint]) -> (w: Double, h: Double) {
  guard let minX = pts.map(\.x).min(), let maxX = pts.map(\.x).max(), let minY = pts.map(\.y).min(), let maxY = pts.map(\.y).max() else { return (0, 0) }
  return (Double(maxX - minX), Double(maxY - minY))
}

/// Landmark ratios in image pixel space (so non-square boxes do not distort them).
func geometry(_ obs: VNFaceObservation, _ w: Int, _ h: Int) -> Geometry? {
  guard let lm = obs.landmarks,
        let le = lm.leftEye?.pointsInImage(imageSize: CGSize(width: w, height: h)),
        let re = lm.rightEye?.pointsInImage(imageSize: CGSize(width: w, height: h)),
        let nose = lm.nose?.pointsInImage(imageSize: CGSize(width: w, height: h)),
        let lips = lm.outerLips?.pointsInImage(imageSize: CGSize(width: w, height: h)),
        let contour = lm.faceContour?.pointsInImage(imageSize: CGSize(width: w, height: h)),
        let lb = lm.leftEyebrow?.pointsInImage(imageSize: CGSize(width: w, height: h)),
        let rb = lm.rightEyebrow?.pointsInImage(imageSize: CGSize(width: w, height: h))
  else { return nil }
  let lp = lm.leftPupil?.pointsInImage(imageSize: CGSize(width: w, height: h)).first ?? centroid(le)
  let rp = lm.rightPupil?.pointsInImage(imageSize: CGSize(width: w, height: h)).first ?? centroid(re)
  let ipd = dist(lp, rp)
  guard ipd > 1 else { return nil }
  let les = span(le), res = span(re)
  let eyeW = (les.w + res.w) / 2, eyeH = (les.h + res.h) / 2
  let cs = span(contour)
  let browY = Double((centroid(lb).y + centroid(rb).y) / 2)
  // Image space from Vision has a bottom-left origin: larger y is higher in the picture.
  let chinY = Double(contour.map(\.y).min() ?? 0)
  let mouth = centroid(lips)
  let eyeMid = CGPoint(x: (lp.x + rp.x) / 2, y: (lp.y + rp.y) / 2)
  return Geometry(
    eyeWidth: eyeW / ipd, eyeOpen: eyeW > 0 ? eyeH / eyeW : 0,
    faceLength: cs.w > 0 ? (browY - chinY) / cs.w : 0,
    noseWidth: span(nose).w / ipd, mouthWidth: span(lips).w / ipd,
    eyeMouth: dist(eyeMid, mouth) / ipd, chin: (Double(mouth.y) - chinY) / ipd)
}

func detect(_ path: String) -> DetectResult {
  guard let cg = loadCG(path) else { return DetectResult(file: path, width: 0, height: 0, faces: []) }
  let w = cg.width, h = cg.height
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  let rects = VNDetectFaceRectanglesRequest()
  rects.revision = VNDetectFaceRectanglesRequestRevision3
  try? handler.perform([rects])
  let found = rects.results ?? []
  let land = VNDetectFaceLandmarksRequest(); land.inputFaceObservations = found
  let qual = VNDetectFaceCaptureQualityRequest(); qual.inputFaceObservations = found
  try? handler.perform([land, qual])
  let lms = land.results ?? [], qs = qual.results ?? []
  let faces: [Face] = found.enumerated().map { i, f in
    let b = f.boundingBox
    let l = i < lms.count ? lms[i] : nil
    return Face(
      x: Double(b.minX) * Double(w), y: Double(1 - b.maxY) * Double(h), w: Double(b.width) * Double(w), h: Double(b.height) * Double(h),
      yaw: deg(f.yaw), pitch: deg(f.pitch), roll: deg(f.roll),
      quality: i < qs.count ? qs[i].faceCaptureQuality.map(Double.init) : nil,
      geometry: l.flatMap { geometry($0, w, h) })
  }
  return DetectResult(file: path, width: w, height: h, faces: faces.sorted { $0.w * $0.h > $1.w * $1.h })
}

/// Largest face, rotated upright by its roll, cropped to a square of `scale` × the face box.
func crop(_ path: String, _ out: String, _ px: Int, _ scale: Double) -> Bool {
  guard let cg = loadCG(path) else { return false }
  let r = detect(path)
  guard let f = r.faces.first else { return false }
  let ci = CIImage(cgImage: cg)
  let cx = f.x + f.w / 2, cyTop = f.y + f.h / 2
  let cy = Double(cg.height) - cyTop  // CI space, bottom-left origin
  let side = max(f.w, f.h) * scale
  let roll = (f.roll ?? 0) * .pi / 180
  let rotated = ci.transformed(by: CGAffineTransform(translationX: -cx, y: -cy).concatenating(CGAffineTransform(rotationAngle: CGFloat(roll))))
  let rect = CGRect(x: -side / 2, y: -side / 2, width: side, height: side)
  let s = Double(px) / side
  let final = rotated.cropped(to: rect).transformed(by: CGAffineTransform(translationX: side / 2, y: side / 2).concatenating(CGAffineTransform(scaleX: s, y: s)))
  let ctx = CIContext()
  guard let outCG = ctx.createCGImage(final, from: CGRect(x: 0, y: 0, width: px, height: px)) else { return false }
  let rep = NSBitmapImageRep(cgImage: outCG)
  guard let data = rep.representation(using: .png, properties: [:]) else { return false }
  return (try? data.write(to: URL(fileURLWithPath: out))) != nil
}

func featurePrint(_ path: String) -> [Float] {
  guard let cg = loadCG(path) else { return [] }
  let req = VNGenerateImageFeaturePrintRequest()
  req.imageCropAndScaleOption = .scaleFill
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  guard let obs = req.results?.first as? VNFeaturePrintObservation, obs.elementType == .float else { return [] }
  return obs.data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
}

let args = Array(CommandLine.arguments.dropFirst())
let enc = JSONEncoder()
func emit<T: Encodable>(_ v: T) { if let d = try? enc.encode(v), let s = String(data: d, encoding: .utf8) { print(s) } }

switch args.first {
case "detect": for p in args.dropFirst() { emit(detect(p)) }
case "crop":
  guard args.count >= 3 else { fputs("usage: face crop <image> <out.png> [px] [scale]\n", stderr); exit(2) }
  let ok = crop(args[1], args[2], args.count > 3 ? Int(args[3]) ?? 256 : 256, args.count > 4 ? Double(args[4]) ?? 1.15 : 1.15)
  if !ok { fputs("no face: \(args[1])\n", stderr); exit(1) }
case "print": for p in args.dropFirst() { emit(PrintResult(file: p, print: featurePrint(p))) }
default:
  fputs("usage: face detect|crop|print …\n", stderr); exit(2)
}
