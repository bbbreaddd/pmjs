'use strict';
// RPG Maker MV weather particles: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.
function installWeatherParticles(runtime) {
  runtime.runScript(`(function() {
Weather.prototype._createBitmaps = function() {
    this._rainBitmap = new Bitmap(1, 60);
    this._rainBitmap.fillAll('white');
    this._stormBitmap = new Bitmap(2, 100);
    this._stormBitmap.fillAll('white');
    this._snowBitmap = new Bitmap(9, 9);
    this._snowBitmap.drawCircle(4, 4, 4, 'white');
};

Weather.prototype._updateAllSprites = function() {
    var maxSprites = Math.floor(this.power * 10);
    while (this._sprites.length < maxSprites) {
        this._addSprite();
    }
    while (this._sprites.length > maxSprites) {
        this._removeSprite();
    }
    this._sprites.forEach(function(sprite) {
        this._updateSprite(sprite);
        sprite.x = sprite.ax - this.origin.x;
        sprite.y = sprite.ay - this.origin.y;
    }, this);
};

Weather.prototype._updateSprite = function(sprite) {
    switch (this.type) {
    case 'rain':
        this._updateRainSprite(sprite);
        break;
    case 'storm':
        this._updateStormSprite(sprite);
        break;
    case 'snow':
        this._updateSnowSprite(sprite);
        break;
    }
    if (sprite.opacity < 40) {
        this._rebornSprite(sprite);
    }
};

Weather.prototype._updateRainSprite = function(sprite) {
    sprite.bitmap = this._rainBitmap;
    sprite.rotation = Math.PI / 16;
    sprite.ax -= 6 * Math.sin(sprite.rotation);
    sprite.ay += 6 * Math.cos(sprite.rotation);
    sprite.opacity -= 6;
};

Weather.prototype._updateStormSprite = function(sprite) {
    sprite.bitmap = this._stormBitmap;
    sprite.rotation = Math.PI / 8;
    sprite.ax -= 8 * Math.sin(sprite.rotation);
    sprite.ay += 8 * Math.cos(sprite.rotation);
    sprite.opacity -= 8;
};

Weather.prototype._updateSnowSprite = function(sprite) {
    sprite.bitmap = this._snowBitmap;
    sprite.rotation = Math.PI / 16;
    sprite.ax -= 3 * Math.sin(sprite.rotation);
    sprite.ay += 3 * Math.cos(sprite.rotation);
    sprite.opacity -= 3;
};

Weather.prototype._rebornSprite = function(sprite) {
    sprite.ax = Math.randomInt(Graphics.width + 100) - 100 + this.origin.x;
    sprite.ay = Math.randomInt(Graphics.height + 200) - 200 + this.origin.y;
    sprite.opacity = 160 + Math.randomInt(60);
};
})()`);
}
module.exports = { installWeatherParticles };
