'use strict';

(function() {
  var nativePlay = MzNativeWebAudio.prototype.play;
  PMJS.phases.on('afterGuestPlugins', 'pmjs.java-hut.native-audio', function() {
    if (typeof MzNativeWebAudio === 'undefined' || WebAudio !== MzNativeWebAudio ||
        !globalThis.JavaHut || !JavaHut.AudioManagerEx) return;
    var prototype = WebAudio.prototype;
    var reviewed = {
      play: 'b1bb41283db49a4b9bcf7715f0789e020756f9ed74371ab3a762ca0c1f3b87d5',
      _startPlaying: '844585d3eb3c60833793691ba03709dda325f8d5cf2d6bede6dc46a05a6094f3',
      _updatePanner: 'd41b2c7f1084589be29bdbd92c49140ea13e0bd3aa48915392454307d7f39f92'
    };
    var mismatch;
    if (!globalThis.__pmjsBuiltinRequire || !NativeHost.media.setAudioStereoBalance ||
        Object.keys(reviewed).some(function(name) {
          if (PMJS.methods.matchesSource(prototype[name], reviewed[name])) return false;
          mismatch = name;
          return true;
        })) {
      PMJS.compat.hit('plugins.java-hut.native-audio', 'unrecognized audio method composition' + (mismatch ? ': ' + mismatch : ''));
      return;
    }
    prototype._startPlaying = function(offset) {
      var info = this._bgsInfo || this._seInfo;
      if (this._convRef || this._customLoopEnd > 0 || info && info.dynamic && JavaHut.AudioManagerEx.Param.AMEXdamp) {
        PMJS.compat.hit('plugins.java-hut.audio-graph', 'custom convolution, filtering or loop region');
        throw new Error('unsupported native audio graph');
      }
      if (this._pan === undefined) this._pan = 0.5;
      this._voice.stereoBalance = true;
      return nativePlay.call(this, this._loop, offset);
    };
    prototype._updatePanner = function() {
      this._voice.pan = Number(this.pan);
      this._voice.stereoBalance = true;
      this._voice.applyParameters();
    };
  });
})();
