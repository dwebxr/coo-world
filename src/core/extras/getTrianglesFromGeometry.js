export function getTrianglesFromGeometry(geometry) {
  if (!geometry) return 0
  if (geometry.index) return geometry.index.count / 3
  // a primitive without positions has no triangles (a model file may leave the attribute out)
  return (geometry.attributes?.position?.count || 0) / 3
}
