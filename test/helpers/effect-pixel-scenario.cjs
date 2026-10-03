'use strict';

async function effectPixelScenario(fixture, name) {
  const { fx, factory, capture, snapshot } = fixture;
  const resource = await fixture.load(name);
  const handle = fx.play(resource, 0, 0, 0);
  const scale = fixture.scale(name);
  handle.setScale(scale, scale, scale);
  const rotation = fixture.rotation(name);
  handle.setRotation(rotation, 0, 0);
  handle.setRandomSeed(1);
  const stage = factory.container();
  stage.addChild(factory.solid(64, 64, '#204080', 0, 0));
  const target = factory.solid(4, 4, '#ffffff', 32, 34);
  stage.addChild(target);
  const animation = factory.animation(handle, target);
  stage.addChild(animation);
  stage.addChild(factory.solid(10, 12, '#00ff00', 28, 3));
  const frames = [];
  function record(label) { frames.push({ label, pixels: capture(stage) }); }
  fx.update(1); record('frame-1');
  if (fixture.trigger(name) !== undefined) {
    handle.sendTrigger(1); fx.update(2); record('unrelated-trigger');
    handle.sendTrigger(fixture.trigger(name)); fx.update(2); record('triggered');
  }
  fx.update(5); record('frame-6');
  if (fixture.dynamic(name)) {
    handle.setDynamicInput(0, 6); handle.setDynamicInput(1, 2);
    fx.update(1); record('dynamic-input');
    handle.setDynamicInput(0, -6); handle.setDynamicInput(1, 0);
    fx.update(1); record('dynamic-restored');
  }
  fx.update(8); record('frame-14');
  fx.update(8); record('frame-22');
  handle.setAllColor(96, 160, 224, 128);
  fx.update(1); record('color');
  handle.setAllColor(255, 255, 255, 0);
  fx.update(1); record('transparent');
  handle.setShown(false); record('hidden'); handle.setShown(true);
  handle.setAllColor(255, 255, 255, 255);
  fx.update(1); record('color-restored');
  if (fixture.seek(name)) {
    handle.setFrame(4); record('seek-backward');
    handle.setFrame(22); record('seek-forward');
    handle.setFrame(22.5); record('seek-fractional');
  }
  handle.setScale(scale * 0.65, scale * 0.65, scale * 0.65);
  handle.setRotation(rotation, 0, 0.3);
  handle.setLocation(2, 0.5, 0);
  animation._mirror = true;
  factory.move(target, 20, 26);
  fx.update(1); record('transformed');
  stage.filterArea = factory.rectangle(8, 9, 39, 37);
  stage.filters = [factory.alpha(1)]; record('clipped');
  stage.filters = [factory.alpha(0.5)]; record('alpha');
  stage.filters = [factory.alpha(1)]; stage.filterArea = null; record('neutral-bounds');
  stage.filterArea = factory.rectangle(-4, 5, 80, 40); record('fitted-clip');
  stage.filters = null; stage.filterArea = null;
  animation.filters = [factory.alpha(0.5)];
  animation.filterArea = factory.rectangle(18, 20, 16, 20); record('animation-clip');
  animation.filters = [factory.alpha(1)]; animation.filterArea = null; record('animation-bounds');
  animation.filters = null;
  const localStage = factory.container(), localParent = factory.container();
  localStage.addChild(factory.solid(64, 64, '#204080', 0, 0));
  const localTarget = factory.solid(4, 4, '#ffffff', 20, 26);
  const localAnimation = factory.animation(handle, localTarget);
  localAnimation._mirror = animation._mirror;
  localParent.addChild(localTarget); localParent.addChild(localAnimation);
  localParent.filters = [factory.alpha(1)];
  localStage.addChild(localParent);
  localStage.addChild(factory.solid(10, 12, '#00ff00', 28, 3));
  frames.push({ label: 'narrow-parent-bounds', pixels: capture(localStage) });
  frames.push({ label: 'snapshot', pixels: snapshot(stage, 48, 40) });
  record('restored');
  fx.releaseEffect(resource); record('cache-release');
  handle.stop(); fx.update(2); record('stopped');
  return frames;
}

module.exports = { effectPixelScenario };
