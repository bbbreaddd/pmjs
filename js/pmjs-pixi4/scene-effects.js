function nativeNodeNeedsAdvancedEffects(enabledFilterCount, nodeMask,
    forcedMask, pictureBlend) {
  return enabledFilterCount !== 0 || !!nodeMask || !!forcedMask ||
    pictureBlend >= 0;
}

var nativeEffectClip = null;
var nativeEffectAlphaMask = null;

function nativeFilterGroupPreservesTransparentBounds(group) {
  return !!group && group.preservesTransparentBlack === true;
}

function resolveNativeAdvancedEffects(node, particleContext, activeFilters,
    nodeMask, forcedMask, pictureBlend, forcedClip) {
  var filterPlan = nativeSceneFilter(node, activeFilters);
  if (filterPlan.unsupported) {
    var filterNames = filterPlan.filters.map(function(filter) {
      return filter && filter.constructor && filter.constructor.name || 'filter';
    }).join(',');
    rejectNativeScene(node, 'render.filter',
      node.constructor && node.constructor.name || 'node', filterNames);
    return null;
  }

  var canKeepRectangleMask = !filterPlan.groups.length ||
    filterPlan.groups.every(nativeFilterGroupPreservesTransparentBounds);
  var maskClip = !particleContext && nodeMask && canKeepRectangleMask ?
    nativeRectangleMask(nodeMask) : null;
  var nativeClip = nativeIntersectClip(forcedClip, maskClip);
  var nativeMask = !particleContext && nodeMask && !maskClip ?
    nativeAlphaMask(nodeMask) : null;
  if (!particleContext && nodeMask && !nativeClip && !nativeMask) {

    nativeCompatibilityHit('render.mask',
      node.constructor && node.constructor.name || 'node');
    return null;
  }
  var nativeMasks = [];
  if (nativeMask) nativeMasks.push(nativeMask);
  if (forcedMask) nativeMasks.push(forcedMask);
  for (var nativeMaskIndex = 0; nativeMaskIndex < nativeMasks.length;
      nativeMaskIndex++) {
    var currentMask = nativeMasks[nativeMaskIndex];

    filterPlan.groups.unshift({ kind: 3, resource: currentMask.handle,
      parameters: currentMask.transform.concat(currentMask.frame,
        [currentMask.alpha, currentMask.usesRed ? 1 : 0,
          currentMask.rotation, currentMask.size[0], currentMask.size[1]]) });
  }

  if (pictureBlend >= 0) {
    filterPlan.groups.push({ kind: 26, resource: 0,
      parameters: [pictureBlend] });
  }
  nativeEffectClip = nativeClip;

  nativeEffectAlphaMask = null;
  return filterPlan;
}

