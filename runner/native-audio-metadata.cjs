'use strict';
// RPG Maker MV audio metadata: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.
function installAudioMetadata(runtime) {
  runtime.runScript(String.raw`(function() {
WebAudio.prototype._readLoopComments = function(array) {
    this._readOgg(array);
    this._readMp4(array);
};

WebAudio.prototype._readOgg = function(array) {
    var index = 0;
    while (index < array.length) {
        if (this._readFourCharacters(array, index) === 'OggS') {
            index += 26;
            var vorbisHeaderFound = false;
            var numSegments = array[index++];
            var segments = [];
            for (var i = 0; i < numSegments; i++) {
                segments.push(array[index++]);
            }
            for (i = 0; i < numSegments; i++) {
                if (this._readFourCharacters(array, index + 1) === 'vorb') {
                    var headerType = array[index];
                    if (headerType === 1) {
                        this._sampleRate = this._readLittleEndian(array, index + 12);
                    } else if (headerType === 3) {
                        this._readMetaData(array, index, segments[i]);
                    }
                    vorbisHeaderFound = true;
                }
                index += segments[i];
            }
            if (!vorbisHeaderFound) {
                break;
            }
        } else {
            break;
        }
    }
};

WebAudio.prototype._readMp4 = function(array) {
    if (this._readFourCharacters(array, 4) === 'ftyp') {
        var index = 0;
        while (index < array.length) {
            var size = this._readBigEndian(array, index);
            var name = this._readFourCharacters(array, index + 4);
            if (name === 'moov') {
                index += 8;
            } else {
                if (name === 'mvhd') {
                    this._sampleRate = this._readBigEndian(array, index + 20);
                }
                if (name === 'udta' || name === 'meta') {
                    this._readMetaData(array, index, size);
                }
                index += size;
                if (size <= 1) {
                    break;
                }
            }
        }
    }
};

WebAudio.prototype._readMetaData = function(array, index, size) {
    for (var i = index; i < index + size - 10; i++) {
        if (this._readFourCharacters(array, i) === 'LOOP') {
            var text = '';
            while (array[i] > 0) {
                text += String.fromCharCode(array[i++]);
            }
            if (text.match(/LOOPSTART=([0-9]+)/)) {
                this._loopStart = parseInt(RegExp.$1);
            }
            if (text.match(/LOOPLENGTH=([0-9]+)/)) {
                this._loopLength = parseInt(RegExp.$1);
            }
            if (text == 'LOOPSTART' || text == 'LOOPLENGTH') {
                var text2 = '';
                i += 16;
                while (array[i] > 0) {
                    text2 += String.fromCharCode(array[i++]);
                }
                if (text == 'LOOPSTART') {
                    this._loopStart = parseInt(text2);
                } else {
                    this._loopLength = parseInt(text2);
                }
            }
        }
    }
};

WebAudio.prototype._readLittleEndian = function(array, index) {
    return (array[index + 3] * 0x1000000 + array[index + 2] * 0x10000 +
            array[index + 1] * 0x100 + array[index + 0]);
};

WebAudio.prototype._readBigEndian = function(array, index) {
    return (array[index + 0] * 0x1000000 + array[index + 1] * 0x10000 +
            array[index + 2] * 0x100 + array[index + 3]);
};

WebAudio.prototype._readFourCharacters = function(array, index) {
    var string = '';
    for (var i = 0; i < 4; i++) {
        string += String.fromCharCode(array[index + i]);
    }
    return string;
};
})()`);
}
module.exports = { installAudioMetadata };
