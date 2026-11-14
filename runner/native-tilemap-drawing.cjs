'use strict';
// RPG Maker MV tile drawing: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.
function createTilemapClasses(runtime, bridge) {
  const factory = runtime.runScript(String.raw`(function(bridge) {
function Tilemap() {
    this.initialize.apply(this, arguments);
}
Tilemap.prototype = Object.create(Object.prototype);
Tilemap.prototype.constructor = Tilemap;
Tilemap.prototype.initialize = function() {
    bridge.initialize(this);
    this._margin = 20;
    this._width = Graphics.width + this._margin * 2;
    this._height = Graphics.height + this._margin * 2;
    this._tileWidth = 48;
    this._tileHeight = 48;
    this._mapWidth = 0;
    this._mapHeight = 0;
    this._mapData = null;
    this._layerWidth = 0;
    this._layerHeight = 0;
    this._lastTiles = [];
    this.bitmaps = [];
    this.origin = new Point();
    this.flags = [];
    this.animationCount = 0;
    this.horizontalWrap = false;
    this.verticalWrap = false;
    this._createLayers();
    this.refresh();
};
Object.defineProperty(Tilemap.prototype, 'width', {
    get: function() {
        return this._width;
    },
    set: function(value) {
        if (this._width !== value) {
            this._width = value;
            this._createLayers();
        }
    }
});
Object.defineProperty(Tilemap.prototype, 'height', {
    get: function() {
        return this._height;
    },
    set: function(value) {
        if (this._height !== value) {
            this._height = value;
            this._createLayers();
        }
    }
});
Object.defineProperty(Tilemap.prototype, 'tileWidth', {
    get: function() {
        return this._tileWidth;
    },
    set: function(value) {
        if (this._tileWidth !== value) {
            this._tileWidth = value;
            this._createLayers();
        }
    }
});
Object.defineProperty(Tilemap.prototype, 'tileHeight', {
    get: function() {
        return this._tileHeight;
    },
    set: function(value) {
        if (this._tileHeight !== value) {
            this._tileHeight = value;
            this._createLayers();
        }
    }
});
Tilemap.prototype.setData = function(width, height, data) {
    this._mapWidth = width;
    this._mapHeight = height;
    this._mapData = data;
};
Tilemap.prototype.isReady = function() {
    for (var i = 0; i < this.bitmaps.length; i++) {
        if (this.bitmaps[i] && !this.bitmaps[i].isReady()) {
            return false;
        }
    }
    return true;
};
Tilemap.prototype.update = function() {
    this.animationCount++;
    this.animationFrame = Math.floor(this.animationCount / 30);
    this.children.forEach(function(child) {
        if (child.update) {
            child.update();
        }
    });
    for (var i=0; i<this.bitmaps.length;i++) {
        if (this.bitmaps[i]) {
            this.bitmaps[i].touch();
        }
    }
};
Tilemap.prototype.refresh = function() {
    this._lastTiles.length = 0;
};
Tilemap.prototype.refreshTileset = function() {
};
Tilemap.prototype.updateTransform = function() {
    var ox = Math.floor(this.origin.x);
    var oy = Math.floor(this.origin.y);
    var startX = Math.floor((ox - this._margin) / this._tileWidth);
    var startY = Math.floor((oy - this._margin) / this._tileHeight);
    this._updateLayerPositions(startX, startY);
    if (this._needsRepaint || this._lastAnimationFrame !== this.animationFrame ||
        this._lastStartX !== startX || this._lastStartY !== startY) {
        this._frameUpdated = this._lastAnimationFrame !== this.animationFrame;
        this._lastAnimationFrame = this.animationFrame;
        this._lastStartX = startX;
        this._lastStartY = startY;
        this._paintAllTiles(startX, startY);
        this._needsRepaint = false;
    }
    this._sortChildren();

};
Tilemap.prototype._createLayers = function() {
    var width = this._width;
    var height = this._height;
    var margin = this._margin;
    var tileCols = Math.ceil(width / this._tileWidth) + 1;
    var tileRows = Math.ceil(height / this._tileHeight) + 1;
    var layerWidth = tileCols * this._tileWidth;
    var layerHeight = tileRows * this._tileHeight;
    this._lowerBitmap = new Bitmap(layerWidth, layerHeight);
    this._upperBitmap = new Bitmap(layerWidth, layerHeight);
    this._layerWidth = layerWidth;
    this._layerHeight = layerHeight;
    this._lowerLayer = new Sprite();
    this._lowerLayer.move(-margin, -margin, width, height);
    this._lowerLayer.z = 0;
    this._upperLayer = new Sprite();
    this._upperLayer.move(-margin, -margin, width, height);
    this._upperLayer.z = 4;
    for (var i = 0; i < 4; i++) {
        this._lowerLayer.addChild(new Sprite(this._lowerBitmap));
        this._upperLayer.addChild(new Sprite(this._upperBitmap));
    }
    this.addChild(this._lowerLayer);
    this.addChild(this._upperLayer);
};
Tilemap.prototype._updateLayerPositions = function(startX, startY) {
    var m = this._margin;
    var ox = Math.floor(this.origin.x);
    var oy = Math.floor(this.origin.y);
    var x2 = (ox - m).mod(this._layerWidth);
    var y2 = (oy - m).mod(this._layerHeight);
    var w1 = this._layerWidth - x2;
    var h1 = this._layerHeight - y2;
    var w2 = this._width - w1;
    var h2 = this._height - h1;
    for (var i = 0; i < 2; i++) {
        var children;
        if (i === 0) {
            children = this._lowerLayer.children;
        } else {
            children = this._upperLayer.children;
        }
        children[0].move(0, 0, w1, h1);
        children[0].setFrame(x2, y2, w1, h1);
        children[1].move(w1, 0, w2, h1);
        children[1].setFrame(0, y2, w2, h1);
        children[2].move(0, h1, w1, h2);
        children[2].setFrame(x2, 0, w1, h2);
        children[3].move(w1, h1, w2, h2);
        children[3].setFrame(0, 0, w2, h2);
    }
};
Tilemap.prototype._paintAllTiles = function(startX, startY) {
    var tileCols = Math.ceil(this._width / this._tileWidth) + 1;
    var tileRows = Math.ceil(this._height / this._tileHeight) + 1;
    for (var y = 0; y < tileRows; y++) {
        for (var x = 0; x < tileCols; x++) {
            this._paintTiles(startX, startY, x, y);
        }
    }
};
Tilemap.prototype._paintTiles = function(startX, startY, x, y) {
    var tableEdgeVirtualId = 10000;
    var mx = startX + x;
    var my = startY + y;
    var dx = (mx * this._tileWidth).mod(this._layerWidth);
    var dy = (my * this._tileHeight).mod(this._layerHeight);
    var lx = dx / this._tileWidth;
    var ly = dy / this._tileHeight;
    var tileId0 = this._readMapData(mx, my, 0);
    var tileId1 = this._readMapData(mx, my, 1);
    var tileId2 = this._readMapData(mx, my, 2);
    var tileId3 = this._readMapData(mx, my, 3);
    var shadowBits = this._readMapData(mx, my, 4);
    var upperTileId1 = this._readMapData(mx, my - 1, 1);
    var lowerTiles = [];
    var upperTiles = [];
    if (this._isHigherTile(tileId0)) {
        upperTiles.push(tileId0);
    } else {
        lowerTiles.push(tileId0);
    }
    if (this._isHigherTile(tileId1)) {
        upperTiles.push(tileId1);
    } else {
        lowerTiles.push(tileId1);
    }
    lowerTiles.push(-shadowBits);
    if (this._isTableTile(upperTileId1) && !this._isTableTile(tileId1)) {
        if (!Tilemap.isShadowingTile(tileId0)) {
            lowerTiles.push(tableEdgeVirtualId + upperTileId1);
        }
    }
    if (this._isOverpassPosition(mx, my)) {
        upperTiles.push(tileId2);
        upperTiles.push(tileId3);
    } else {
        if (this._isHigherTile(tileId2)) {
            upperTiles.push(tileId2);
        } else {
            lowerTiles.push(tileId2);
        }
        if (this._isHigherTile(tileId3)) {
            upperTiles.push(tileId3);
        } else {
            lowerTiles.push(tileId3);
        }
    }
    var lastLowerTiles = this._readLastTiles(0, lx, ly);
    if (!lowerTiles.equals(lastLowerTiles) ||
            (Tilemap.isTileA1(tileId0) && this._frameUpdated)) {
        this._lowerBitmap.clearRect(dx, dy, this._tileWidth, this._tileHeight);
        for (var i = 0; i < lowerTiles.length; i++) {
            var lowerTileId = lowerTiles[i];
            if (lowerTileId < 0) {
                this._drawShadow(this._lowerBitmap, shadowBits, dx, dy);
            } else if (lowerTileId >= tableEdgeVirtualId) {
                this._drawTableEdge(this._lowerBitmap, upperTileId1, dx, dy);
            } else {
                this._drawTile(this._lowerBitmap, lowerTileId, dx, dy);
            }
        }
        this._writeLastTiles(0, lx, ly, lowerTiles);
    }
    var lastUpperTiles = this._readLastTiles(1, lx, ly);
    if (!upperTiles.equals(lastUpperTiles)) {
        this._upperBitmap.clearRect(dx, dy, this._tileWidth, this._tileHeight);
        for (var j = 0; j < upperTiles.length; j++) {
            this._drawTile(this._upperBitmap, upperTiles[j], dx, dy);
        }
        this._writeLastTiles(1, lx, ly, upperTiles);
    }
};
Tilemap.prototype._readLastTiles = function(i, x, y) {
    var array1 = this._lastTiles[i];
    if (array1) {
        var array2 = array1[y];
        if (array2) {
            var tiles = array2[x];
            if (tiles) {
                return tiles;
            }
        }
    }
    return [];
};
Tilemap.prototype._writeLastTiles = function(i, x, y, tiles) {
    var array1 = this._lastTiles[i];
    if (!array1) {
        array1 = this._lastTiles[i] = [];
    }
    var array2 = array1[y];
    if (!array2) {
        array2 = array1[y] = [];
    }
    array2[x] = tiles;
};
Tilemap.prototype._drawTile = function(bitmap, tileId, dx, dy) {
    if (Tilemap.isVisibleTile(tileId)) {
        if (Tilemap.isAutotile(tileId)) {
            this._drawAutotile(bitmap, tileId, dx, dy);
        } else {
            this._drawNormalTile(bitmap, tileId, dx, dy);
        }
    }
};
Tilemap.prototype._drawNormalTile = function(bitmap, tileId, dx, dy) {
    var setNumber = 0;
    if (Tilemap.isTileA5(tileId)) {
        setNumber = 4;
    } else {
        setNumber = 5 + Math.floor(tileId / 256);
    }
    var w = this._tileWidth;
    var h = this._tileHeight;
    var sx = (Math.floor(tileId / 128) % 2 * 8 + tileId % 8) * w;
    var sy = (Math.floor(tileId % 256 / 8) % 16) * h;
    var source = this.bitmaps[setNumber];
    if (source) {
        bitmap.bltImage(source, sx, sy, w, h, dx, dy, w, h);
    }
};
Tilemap.prototype._drawAutotile = function(bitmap, tileId, dx, dy) {
    var autotileTable = Tilemap.FLOOR_AUTOTILE_TABLE;
    var kind = Tilemap.getAutotileKind(tileId);
    var shape = Tilemap.getAutotileShape(tileId);
    var tx = kind % 8;
    var ty = Math.floor(kind / 8);
    var bx = 0;
    var by = 0;
    var setNumber = 0;
    var isTable = false;
    if (Tilemap.isTileA1(tileId)) {
        var waterSurfaceIndex = [0, 1, 2, 1][this.animationFrame % 4];
        setNumber = 0;
        if (kind === 0) {
            bx = waterSurfaceIndex * 2;
            by = 0;
        } else if (kind === 1) {
            bx = waterSurfaceIndex * 2;
            by = 3;
        } else if (kind === 2) {
            bx = 6;
            by = 0;
        } else if (kind === 3) {
            bx = 6;
            by = 3;
        } else {
            bx = Math.floor(tx / 4) * 8;
            by = ty * 6 + Math.floor(tx / 2) % 2 * 3;
            if (kind % 2 === 0) {
                bx += waterSurfaceIndex * 2;
            }
            else {
                bx += 6;
                autotileTable = Tilemap.WATERFALL_AUTOTILE_TABLE;
                by += this.animationFrame % 3;
            }
        }
    } else if (Tilemap.isTileA2(tileId)) {
        setNumber = 1;
        bx = tx * 2;
        by = (ty - 2) * 3;
        isTable = this._isTableTile(tileId);
    } else if (Tilemap.isTileA3(tileId)) {
        setNumber = 2;
        bx = tx * 2;
        by = (ty - 6) * 2;
        autotileTable = Tilemap.WALL_AUTOTILE_TABLE;
    } else if (Tilemap.isTileA4(tileId)) {
        setNumber = 3;
        bx = tx * 2;
        by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
        if (ty % 2 === 1) {
            autotileTable = Tilemap.WALL_AUTOTILE_TABLE;
        }
    }
    var table = autotileTable[shape];
    var source = this.bitmaps[setNumber];
    if (table && source) {
        var w1 = this._tileWidth / 2;
        var h1 = this._tileHeight / 2;
        for (var i = 0; i < 4; i++) {
            var qsx = table[i][0];
            var qsy = table[i][1];
            var sx1 = (bx * 2 + qsx) * w1;
            var sy1 = (by * 2 + qsy) * h1;
            var dx1 = dx + (i % 2) * w1;
            var dy1 = dy + Math.floor(i / 2) * h1;
            if (isTable && (qsy === 1 || qsy === 5)) {
                var qsx2 = qsx;
                var qsy2 = 3;
                if (qsy === 1) {
                    qsx2 = [0,3,2,1][qsx];
                }
                var sx2 = (bx * 2 + qsx2) * w1;
                var sy2 = (by * 2 + qsy2) * h1;
                bitmap.bltImage(source, sx2, sy2, w1, h1, dx1, dy1, w1, h1);
                dy1 += h1/2;
                bitmap.bltImage(source, sx1, sy1, w1, h1/2, dx1, dy1, w1, h1/2);
            } else {
                bitmap.bltImage(source, sx1, sy1, w1, h1, dx1, dy1, w1, h1);
            }
        }
    }
};
Tilemap.prototype._drawTableEdge = function(bitmap, tileId, dx, dy) {
    if (Tilemap.isTileA2(tileId)) {
        var autotileTable = Tilemap.FLOOR_AUTOTILE_TABLE;
        var kind = Tilemap.getAutotileKind(tileId);
        var shape = Tilemap.getAutotileShape(tileId);
        var tx = kind % 8;
        var ty = Math.floor(kind / 8);
        var setNumber = 1;
        var bx = tx * 2;
        var by = (ty - 2) * 3;
        var table = autotileTable[shape];
        if (table) {
            var source = this.bitmaps[setNumber];
            var w1 = this._tileWidth / 2;
            var h1 = this._tileHeight / 2;
            for (var i = 0; i < 2; i++) {
                var qsx = table[2 + i][0];
                var qsy = table[2 + i][1];
                var sx1 = (bx * 2 + qsx) * w1;
                var sy1 = (by * 2 + qsy) * h1 + h1/2;
                var dx1 = dx + (i % 2) * w1;
                var dy1 = dy + Math.floor(i / 2) * h1;
                bitmap.bltImage(source, sx1, sy1, w1, h1/2, dx1, dy1, w1, h1/2);
            }
        }
    }
};
Tilemap.prototype._drawShadow = function(bitmap, shadowBits, dx, dy) {
    if (shadowBits & 0x0f) {
        var w1 = this._tileWidth / 2;
        var h1 = this._tileHeight / 2;
        var color = 'rgba(0,0,0,0.5)';
        for (var i = 0; i < 4; i++) {
            if (shadowBits & (1 << i)) {
                var dx1 = dx + (i % 2) * w1;
                var dy1 = dy + Math.floor(i / 2) * h1;
                bitmap.fillRect(dx1, dy1, w1, h1, color);
            }
        }
    }
};
Tilemap.prototype._readMapData = function(x, y, z) {
    if (this._mapData) {
        var width = this._mapWidth;
        var height = this._mapHeight;
        if (this.horizontalWrap) {
            x = x.mod(width);
        }
        if (this.verticalWrap) {
            y = y.mod(height);
        }
        if (x >= 0 && x < width && y >= 0 && y < height) {
            return this._mapData[(z * height + y) * width + x] || 0;
        } else {
            return 0;
        }
    } else {
        return 0;
    }
};
Tilemap.prototype._isHigherTile = function(tileId) {
    return this.flags[tileId] & 0x10;
};
Tilemap.prototype._isTableTile = function(tileId) {
    return Tilemap.isTileA2(tileId) && (this.flags[tileId] & 0x80);
};
Tilemap.prototype._isOverpassPosition = function(mx, my) {
    return false;
};
Tilemap.prototype._sortChildren = function() {
    this.children.sort(this._compareChildOrder.bind(this));
};
Tilemap.prototype._compareChildOrder = function(a, b) {
    if (a.z !== b.z) {
        return a.z - b.z;
    } else if (a.y !== b.y) {
        return a.y - b.y;
    } else {
        return a.spriteId - b.spriteId;
    }
};

function ShaderTilemap() { Tilemap.apply(this, arguments); this.roundPixels = true; }
ShaderTilemap.prototype = Object.create(Tilemap.prototype);
ShaderTilemap.prototype.constructor = ShaderTilemap;
ShaderTilemap.prototype.refreshTileset = function() { this._needsRepaint = true; };
ShaderTilemap.prototype.refresh = function() {
  if(this._lastBitmapLength!==this.bitmaps.length) {this._lastBitmapLength=this.bitmaps.length;this.refreshTileset();}
  this._needsRepaint=true;
};
ShaderTilemap.prototype._paintAllTiles = function(startX,startY) {
  this._lowerBitmap.clear(); this._upperBitmap.clear();
  const columns = Math.ceil(this._width / this._tileWidth) + 1;
  const rows = Math.ceil(this._height / this._tileHeight) + 1;
  for (let y=0;y<rows;++y) for(let x=0;x<columns;++x) this._paintTiles(startX,startY,x,y);
};

ShaderTilemap.prototype._paintTiles = function(startX, startY, x, y) {
    var mx = startX + x;
    var my = startY + y;
    var position = bridge.tilePosition(this,mx,my), dx=position[0],dy=position[1];
    var tileId0 = this._readMapData(mx, my, 0);
    var tileId1 = this._readMapData(mx, my, 1);
    var tileId2 = this._readMapData(mx, my, 2);
    var tileId3 = this._readMapData(mx, my, 3);
    var shadowBits = this._readMapData(mx, my, 4);
    var upperTileId1 = this._readMapData(mx, my - 1, 1);
    var lowerLayer = bridge.layer(this, this._lowerBitmap);
    var upperLayer = bridge.layer(this, this._upperBitmap);
    if (this._isHigherTile(tileId0)) {
        this._drawTile(upperLayer, tileId0, dx, dy);
    } else {
        this._drawTile(lowerLayer, tileId0, dx, dy);
    }
    if (this._isHigherTile(tileId1)) {
        this._drawTile(upperLayer, tileId1, dx, dy);
    } else {
        this._drawTile(lowerLayer, tileId1, dx, dy);
    }
    this._drawShadow(lowerLayer, shadowBits, dx, dy);
    if (this._isTableTile(upperTileId1) && !this._isTableTile(tileId1)) {
        if (!Tilemap.isShadowingTile(tileId0)) {
            this._drawTableEdge(lowerLayer, upperTileId1, dx, dy);
        }
    }
    if (this._isOverpassPosition(mx, my)) {
        this._drawTile(upperLayer, tileId2, dx, dy);
        this._drawTile(upperLayer, tileId3, dx, dy);
    } else {
        if (this._isHigherTile(tileId2)) {
            this._drawTile(upperLayer, tileId2, dx, dy);
        } else {
            this._drawTile(lowerLayer, tileId2, dx, dy);
        }
        if (this._isHigherTile(tileId3)) {
            this._drawTile(upperLayer, tileId3, dx, dy);
        } else {
            this._drawTile(lowerLayer, tileId3, dx, dy);
        }
    }
};
ShaderTilemap.prototype._drawTile = function(layer, tileId, dx, dy) {
    if (Tilemap.isVisibleTile(tileId)) {
        if (Tilemap.isAutotile(tileId)) {
            this._drawAutotile(layer, tileId, dx, dy);
        } else {
            this._drawNormalTile(layer, tileId, dx, dy);
        }
    }
};
ShaderTilemap.prototype._drawNormalTile = function(layer, tileId, dx, dy) {
    var setNumber = 0;
    if (Tilemap.isTileA5(tileId)) {
        setNumber = 4;
    } else {
        setNumber = 5 + Math.floor(tileId / 256);
    }
    var w = this._tileWidth;
    var h = this._tileHeight;
    var sx = (Math.floor(tileId / 128) % 2 * 8 + tileId % 8) * w;
    var sy = (Math.floor(tileId % 256 / 8) % 16) * h;
    layer.addRect(setNumber, sx, sy, dx, dy, w, h);
};
ShaderTilemap.prototype._drawAutotile = function(layer, tileId, dx, dy) {
    var autotileTable = Tilemap.FLOOR_AUTOTILE_TABLE;
    var kind = Tilemap.getAutotileKind(tileId);
    var shape = Tilemap.getAutotileShape(tileId);
    var tx = kind % 8;
    var ty = Math.floor(kind / 8);
    var bx = 0;
    var by = 0;
    var setNumber = 0;
    var isTable = false;
    var animX = 0, animY = 0;
    if (Tilemap.isTileA1(tileId)) {
        setNumber = 0;
        if (kind === 0) {
            animX = 2;
            by = 0;
        } else if (kind === 1) {
            animX = 2;
            by = 3;
        } else if (kind === 2) {
            bx = 6;
            by = 0;
        } else if (kind === 3) {
            bx = 6;
            by = 3;
        } else {
            bx = Math.floor(tx / 4) * 8;
            by = ty * 6 + Math.floor(tx / 2) % 2 * 3;
            if (kind % 2 === 0) {
                animX = 2;
            }
            else {
                bx += 6;
                autotileTable = Tilemap.WATERFALL_AUTOTILE_TABLE;
                animY = 1;
            }
        }
    } else if (Tilemap.isTileA2(tileId)) {
        setNumber = 1;
        bx = tx * 2;
        by = (ty - 2) * 3;
        isTable = this._isTableTile(tileId);
    } else if (Tilemap.isTileA3(tileId)) {
        setNumber = 2;
        bx = tx * 2;
        by = (ty - 6) * 2;
        autotileTable = Tilemap.WALL_AUTOTILE_TABLE;
    } else if (Tilemap.isTileA4(tileId)) {
        setNumber = 3;
        bx = tx * 2;
        by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
        if (ty % 2 === 1) {
            autotileTable = Tilemap.WALL_AUTOTILE_TABLE;
        }
    }
    var table = autotileTable[shape];
    var w1 = this._tileWidth / 2;
    var h1 = this._tileHeight / 2;
    for (var i = 0; i < 4; i++) {
        var qsx = table[i][0];
        var qsy = table[i][1];
        var sx1 = (bx * 2 + qsx) * w1;
        var sy1 = (by * 2 + qsy) * h1;
        var dx1 = dx + (i % 2) * w1;
        var dy1 = dy + Math.floor(i / 2) * h1;
        if (isTable && (qsy === 1 || qsy === 5)) {
            var qsx2 = qsx;
            var qsy2 = 3;
            if (qsy === 1) {
                qsx2 = (4-qsx)%4;
            }
            var sx2 = (bx * 2 + qsx2) * w1;
            var sy2 = (by * 2 + qsy2) * h1;
            layer.addRect(setNumber, sx2, sy2, dx1, dy1, w1, h1, animX, animY);
            layer.addRect(setNumber, sx1, sy1, dx1, dy1+h1/2, w1, h1/2, animX, animY);
        } else {
            layer.addRect(setNumber, sx1, sy1, dx1, dy1, w1, h1, animX, animY);
        }
    }
};
ShaderTilemap.prototype._drawTableEdge = function(layer, tileId, dx, dy) {
    if (Tilemap.isTileA2(tileId)) {
        var autotileTable = Tilemap.FLOOR_AUTOTILE_TABLE;
        var kind = Tilemap.getAutotileKind(tileId);
        var shape = Tilemap.getAutotileShape(tileId);
        var tx = kind % 8;
        var ty = Math.floor(kind / 8);
        var setNumber = 1;
        var bx = tx * 2;
        var by = (ty - 2) * 3;
        var table = autotileTable[shape];
        var w1 = this._tileWidth / 2;
        var h1 = this._tileHeight / 2;
        for (var i = 0; i < 2; i++) {
            var qsx = table[2 + i][0];
            var qsy = table[2 + i][1];
            var sx1 = (bx * 2 + qsx) * w1;
            var sy1 = (by * 2 + qsy) * h1 + h1 / 2;
            var dx1 = dx + (i % 2) * w1;
            var dy1 = dy + Math.floor(i / 2) * h1;
            layer.addRect(setNumber, sx1, sy1, dx1, dy1, w1, h1/2);
        }
    }
};
ShaderTilemap.prototype._drawShadow = function(layer, shadowBits, dx, dy) {
    if (shadowBits & 0x0f) {
        var w1 = this._tileWidth / 2;
        var h1 = this._tileHeight / 2;
        for (var i = 0; i < 4; i++) {
            if (shadowBits & (1 << i)) {
                var dx1 = dx + (i % 2) * w1;
                var dy1 = dy + Math.floor(i / 2) * h1;
                layer.addRect(-1, 0, 0, dx1, dy1, w1, h1);
            }
        }
    }
};
  return { Tilemap, ShaderTilemap };
})`);
  return factory(bridge);
}
module.exports = { createTilemapClasses };
