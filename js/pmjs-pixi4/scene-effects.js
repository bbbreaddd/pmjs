// Effect topology: the simple/advanced split. Like Pixi 4's simple
// renderWebGL versus renderAdvancedWebGL, ordinary nodes skip the mask and
// filter machinery entirely; only effect-bearing nodes pay for it.
//
// The boundary test reuses already-read traversal state, so it adds no
// observable reads. Per-filter translation stays in scene-filters.js, which
// the simple lane never calls.

// Anything set here means the node carries effects. Generic nodes use the
// same rule as containers: with no effects they take the simple lane.
function nativeNodeNeedsAdvancedEffects(enabledFilterCount, nodeMask,
    forcedMask, pictureBlend) {
  return enabledFilterCount !== 0 || !!nodeMask || !!forcedMask ||
    pictureBlend >= 0;
}

// Scratch for advanced-effect resolution, copied to traversal locals before
// child traversal can reuse it.
var nativeEffectClip = null;
var nativeEffectAlphaMask = null;

// Filter planning, then rectangle clips and alpha masks, then mask and
// picture-blend groups around the node's own filter groups. Returns the
// plan, or null when the node is rejected (flags already recorded).
function resolveNativeAdvancedEffects(node, particleContext, activeFilters,
    nodeMask, forcedMask, pictureBlend, forcedClip) {
  var filterPlan = nativeSceneFilter(node, activeFilters);
  if (filterPlan.unsupported) {
    var filterNames = filterPlan.filters.map(function(filter) {
      return filter && filter.constructor && filter.constructor.name || 'filter';
    }).join(',');
    nativeCompatibilityHit('render.filter',
      (node.constructor && node.constructor.name || 'node') + ':' + filterNames);
    nativeSceneUnsupported = true;
    nativeSceneUnsupportedReason =
      (node.constructor && node.constructor.name || 'node') + ':filter';
    return null;
  }
  // A scissor is exact only while no post-mask filter can expand or transform
  // pixels. Pixi pops its mask before applying the filter chain.
  var maskClip = !particleContext && nodeMask && !filterPlan.groups.length ?
    nativeRectangleMask(nodeMask) : null;
  var nativeClip = nativeIntersectClip(forcedClip, maskClip);
  var nativeMask = !particleContext && nodeMask && !maskClip ?
    nativeAlphaMask(nodeMask) : null;
  if (!particleContext && nodeMask && !nativeClip && !nativeMask) {
    // Stock hides content with a pixel-less mask; skip the node, not the frame.
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
    // Pixi pushes its filter target before its mask, then pops the mask before
    // applying the filter chain. Since groups are emitted in reverse below,
    // the mask belongs first in application order.
    filterPlan.groups.unshift({ kind: 3, resource: currentMask.handle,
      parameters: currentMask.transform.concat(currentMask.frame,
        [currentMask.alpha, currentMask.usesRed ? 1 : 0,
          currentMask.rotation, currentMask.size[0], currentMask.size[1]]) });
  }
  // pixi-picture reads the destination after Pixi has rendered the complete
  // filtered and masked sprite. Keeping this group last makes it outermost in
  // the reverse-emitted native filter stack.
  if (pictureBlend >= 0) {
    filterPlan.groups.push({ kind: 26, resource: 0,
      parameters: [pictureBlend] });
  }
  nativeEffectClip = nativeClip;
  // The record itself carries no direct mask: masks travel as filter markers
  // (the reference nulled its mask local here for the same reason).
  nativeEffectAlphaMask = null;
  return filterPlan;
}
