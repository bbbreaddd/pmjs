PMJS.mv = PMJS.mv || {};
PMJS.mv.hasBitmapMesh = function(mesh) { return PMJS.pixi4.meshNativeMaterialOwner(mesh) === 'mv-bitmap'; };
PMJS.mv.bitmapMeshColor = function(mesh) { return PMJS.mv.hasBitmapMesh(mesh) ? mesh._pmjsMvBitmapBlendColor : null; };
PMJS.mv.setBitmapMeshBlend = function(mesh, color, bounds) {
  if (!bounds && !PMJS.mv.hasBitmapMesh(mesh)) throw new TypeError('MV bitmap blend requires retained texel bounds');
  if (bounds && (bounds.length !== 4 || !Array.prototype.every.call(bounds, Number.isFinite))) {
    throw new TypeError('MV bitmap blend requires four finite texel bounds');
  }
  if (bounds) {
    var retainedBounds = Array.from(bounds);
    PMJS.pixi4.setMeshNativeMaterial(mesh, 'mv-bitmap', { texelBounds: retainedBounds });
    mesh._pmjsMvBitmapBounds = retainedBounds;
  }
  mesh._pmjsMvBitmapBlendColor = color;
};
