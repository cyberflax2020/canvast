import Foundation
import CanvastAppCore

enum CanvastProductCapabilityCatalog {
  static let developmentOnlyIDs: Set<CanvastFeatureID> = [
    .evaluation,
    .packaging,
    .guiGuard,
    .offscreenSnapshot,
    .macApp,
  ]

  static let productIDs: Set<CanvastFeatureID> = Set(CanvastFeatureID.allCases)
    .subtracting(developmentOnlyIDs)

  static func features(from features: [CanvastFeature]) -> [CanvastFeature] {
    features.filter { productIDs.contains($0.id) }
  }
}
