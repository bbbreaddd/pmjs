'use strict';

function installAudioElement(scope) {
  class Audio extends scope.EventTarget {
    constructor(source) {
      super(); this._src = ''; this._volume = 1; this._offset = 0;
      this.paused = true; this.loop = false; this.preload = 'auto'; this._buffer = null;
      if (source) this.src = source;
    }
    get src() { return this._src; }
    set src(value) {
      this.pause(); this._src = String(value); this._buffer = null; this._offset = 0;
      if (this._src) this.load();
    }
    get currentSrc() { return this.src; }
    get volume() { return this._volume; }
    set volume(value) {
      value = Number(value);
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Audio volume must be between zero and one');
      this._volume = value; if (this._buffer) this._buffer.volume = value;
    }
    get currentTime() { return this.paused || !this._buffer ? this._offset : this._buffer.seek(); }
    set currentTime(value) {
      this._offset = Number(value);
      if (!this.paused && this._buffer) this._buffer.play(this.loop, this._offset);
    }
    get duration() { return this._buffer?._totalTime || NaN; }
    get readyState() { return this._buffer?.isReady() ? 4 : 0; }
    get error() { return this._buffer?.isError() ? { code: 4 } : null; }
    canPlayType(type) {
      if (/ogg/i.test(type)) return scope.WebAudio.canPlayOgg() ? 'probably' : '';
      if (/mp4|m4a/i.test(type)) return scope.WebAudio.canPlayM4a() ? 'probably' : '';
      return '';
    }
    load() {
      if (!this.src || this._buffer) return;
      const buffer = this._buffer = new scope.WebAudio(this.src);
      buffer.volume = this.volume;
      const update = buffer.update;
      let reportedError = false;
      buffer.update = () => {
        update.call(buffer);
        if (this._buffer === buffer && buffer.isError() && !reportedError) {
          reportedError = true; this.dispatchEvent({ type: 'error' });
        }
      };
      buffer.addLoadListener(() => {
        if (this._buffer === buffer) {
          this.dispatchEvent({ type: 'loadeddata' }); this.dispatchEvent({ type: 'canplaythrough' });
        }
      });
    }
    play() {
      this.load();
      const buffer = this._buffer;
      if (!buffer) return Promise.resolve();
      this.paused = false;
      buffer.addStopListener(() => {
        if (this._buffer === buffer && !this.paused && !this.loop) {
          this.paused = true; this.dispatchEvent({ type: 'ended' });
        }
      });
      buffer.play(this.loop, this._offset);
      return Promise.resolve();
    }
    pause() {
      if (!this._buffer || this.paused) return;
      this._offset = this._buffer.seek(); this.paused = true; this._buffer.stop();
    }
  }
  scope.Audio = Audio;
}

module.exports = { installAudioElement };
