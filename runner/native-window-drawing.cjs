'use strict';

function installWindowDrawing(Window_Base, ImageManager, options) {
  const base = Window_Base.prototype, escape = String.fromCharCode(27);
  Object.assign(Window_Base, { _iconWidth: 32, _iconHeight: 32, _faceWidth: 144, _faceHeight: 144 });
  base.drawIcon = function(index, x, y) {
    const width = Window_Base._iconWidth, height = Window_Base._iconHeight;
    this.contents.blt(ImageManager.loadSystem('IconSet'), index % 16 * width, Math.floor(index / 16) * height, width, height, x, y);
  };
  base.drawFace = function(name, index, x, y, width, height) {
    const fw = Window_Base._faceWidth, fh = Window_Base._faceHeight;
    width = width || fw; height = height || fh;
    const sw = Math.min(width, fw), sh = Math.min(height, fh);
    this.contents.blt(ImageManager.loadFace(name), index % 4 * fw + (fw - sw) / 2, Math.floor(index / 4) * fh + (fh - sh) / 2,
      sw, sh, Math.floor(x + Math.max(width - fw, 0) / 2), Math.floor(y + Math.max(height - fh, 0) / 2));
  };
  base.drawCharacter = function(name, index, x, y) {
    if (!name) return;
    const bitmap = ImageManager.loadCharacter(name), big = ImageManager.isBigCharacter(name);
    const width = bitmap.width / (big ? 3 : 12), height = bitmap.height / (big ? 4 : 8), position = big ? 0 : index;
    this.contents.blt(bitmap, (position % 4 * 3 + 1) * width, Math.floor(position / 4) * 4 * height, width, height, x - width / 2, y - height);
  };
  base.drawActorFace = function(actor, x, y, width, height) { this.drawFace(actor.faceName(), actor.faceIndex(), x, y, width, height); };
  base.drawActorIcons = function(actor, x, y, width = 144) { width = width || 144; actor.allIcons().slice(0, Math.floor(width / Window_Base._iconWidth)).forEach((icon, i) => this.drawIcon(icon, x + i * Window_Base._iconWidth, y + 2)); };
  base.drawItemName = function(item, x, y, width = 312) {
    if (!item) return;
    width = width || 312;
    const margin = Window_Base._iconWidth + 4; this.resetTextColor();
    this.drawIcon(item.iconIndex, x + 2, y + (this.lineHeight() - Window_Base._iconHeight) / 2);
    this.drawText(item.name, x + margin, y, width - margin);
  };
  base.hpColor = function(actor) { return !actor ? this.normalColor() : actor.isDead() ? this.deathColor() : actor.isDying() ? this.crisisColor() : this.normalColor(); };
  base.tpColor = function() { return this.normalColor(); };
  base.mpColor = function() { return this.normalColor(); };
  base.drawGauge = function(x, y, width, rate, color1, color2) {
    const gaugeY = y + this.lineHeight() - 8;
    this.contents.fillRect(x, gaugeY, width, 6, this.gaugeBackColor());
    this.contents.gradientFillRect(x, gaugeY, Math.floor(width * rate), 6, color1, color2);
  };
  base.drawCurrentAndMax = function(current, maximum, x, y, width, color1, color2) {
    const labelWidth = this.textWidth('HP'), valueWidth = this.textWidth('0000'), slashWidth = this.textWidth('/');
    const right = x + width - valueWidth, slash = right - slashWidth, left = slash - valueWidth;
    this.changeTextColor(color1);
    this.drawText(current, left >= x + labelWidth ? left : right, y, valueWidth, 'right');
    if (left >= x + labelWidth) {
      this.changeTextColor(color2);
      this.drawText('/', slash, y, slashWidth, 'right');
      this.drawText(maximum, right, y, valueWidth, 'right');
    }
  };
  for (const kind of ['Hp', 'Mp']) {
    const field = kind.toLowerCase();
    base['drawActor' + kind] = function(actor, x, y, width) {
      width = width || 186;
      this.drawGauge(x, y, width, actor[field + 'Rate'](), this[field + 'GaugeColor1'](), this[field + 'GaugeColor2']());
      this.changeTextColor(this.systemColor());
      this.drawText(options.textManager()[field + 'A'], x, y, 44);
      this.drawCurrentAndMax(actor[field], actor['m' + field], x, y, width, this[field + 'Color'](actor), this.normalColor());
    };
  }
  base.drawActorTp = function(actor, x, y, width) {
    width = width || 96;
    this.drawGauge(x, y, width, actor.tpRate(), this.tpGaugeColor1(), this.tpGaugeColor2());
    this.changeTextColor(this.systemColor()); this.drawText(options.textManager().tpA, x, y, 44);
    this.changeTextColor(this.tpColor(actor)); this.drawText(actor.tp, x + width - 64, y, 64, 'right');
  };
  base.drawActorCharacter = function(actor, x, y) { this.drawCharacter(actor.characterName(), actor.characterIndex(), x, y); };
  base.drawActorClass = function(actor, x, y, width) { this.resetTextColor(); this.drawText(actor.currentClass().name, x, y, width || 168); };
  base.drawActorNickname = function(actor, x, y, width) { this.resetTextColor(); this.drawText(actor.nickname(), x, y, width || 270); };
  base.drawActorLevel = function(actor, x, y) {
    this.changeTextColor(this.systemColor()); this.drawText(options.textManager().levelA, x, y, 48);
    this.resetTextColor(); this.drawText(actor.level, x + 84, y, 36, 'right');
  };
  base.drawActorSimpleStatus = function(actor, x, y, width) {
    const line = this.lineHeight(), right = x + 180, gaugeWidth = Math.min(200, width - 180 - this.textPadding());
    this.drawActorName(actor, x, y); this.drawActorLevel(actor, x, y + line); this.drawActorIcons(actor, x, y + line * 2);
    this.drawActorClass(actor, right, y); this.drawActorHp(actor, right, y + line, gaugeWidth); this.drawActorMp(actor, right, y + line * 2, gaugeWidth);
  };
  base.drawCurrencyValue = function(value, unit, x, y, width) {
    const unitWidth = Math.min(80, this.textWidth(unit));
    this.resetTextColor(); this.drawText(value, x, y, width - unitWidth - 6, 'right');
    this.changeTextColor(this.systemColor()); this.drawText(unit, x + width - unitWidth, y, unitWidth, 'right');
  };
  base.drawActorName = function(actor, x, y, width = 168) { this.changeTextColor(this.hpColor(actor)); this.drawText(actor.name(), x, y, width || 168); };
  for (const [name, index] of Object.entries({ systemColor: 16, crisisColor: 17, deathColor: 18, gaugeBackColor: 19, hpGaugeColor1: 20, hpGaugeColor2: 21, mpGaugeColor1: 22, mpGaugeColor2: 23, powerUpColor: 24, powerDownColor: 25, tpGaugeColor1: 28, tpGaugeColor2: 29 }))
    base[name] = function() { return this.textColor(index); };
  base.paramchangeTextColor = function(change) { return change > 0 ? this.powerUpColor() : change < 0 ? this.powerDownColor() : this.normalColor(); };
  base.pendingColor = function() { return this.windowskin.getPixel(120, 120); };
  base.actorName = function(id) { return id >= 1 ? options.actorName(id) : ''; };
  base.partyMemberName = function(index) { return index >= 1 ? options.gameParty().members()[index - 1]?.name() || '' : ''; };
  base.convertEscapeCharacters = function(text) {
    text = text.replace(/\\/g, escape).replace(new RegExp(escape + escape, 'g'), '\\');
    for (let i = 0; i < 2; ++i) text = text.replace(/\x1bV\[(\d+)\]/gi, (match, id) => options.gameVariables().value(Number(id)));
    return text.replace(/\x1bN\[(\d+)\]/gi, (match, id) => this.actorName(Number(id)))
      .replace(/\x1bP\[(\d+)\]/gi, (match, id) => this.partyMemberName(Number(id))).replace(/\x1bG/gi, options.textManager().currencyUnit);
  };
  base.makeFontBigger = function() { if (this.contents.fontSize <= 96) this.contents.fontSize += 12; };
  base.makeFontSmaller = function() { if (this.contents.fontSize >= 24) this.contents.fontSize -= 12; };
  base.calcTextHeight = function(state, all) {
    const original = this.contents.fontSize, lines = state.text.slice(state.index).split('\n');
    let height = 0;
    try {
      for (const line of lines.slice(0, all ? lines.length : 1)) {
        let maximum = this.contents.fontSize;
        for (const code of line.matchAll(/\x1b[{}]/g)) { if (code[0].endsWith('{')) this.makeFontBigger(); else this.makeFontSmaller(); maximum = Math.max(maximum, this.contents.fontSize); }
        height += maximum + 8;
      }
    } finally { this.contents.fontSize = original; }
    return height;
  };
  base.obtainEscapeCode = function(state) {
    ++state.index;
    const match = /^[$.|^!><{}\\]|^[A-Z]+/i.exec(state.text.slice(state.index));
    if (!match) return '';
    state.index += match[0].length; return match[0].toUpperCase();
  };
  base.obtainEscapeParam = function(state) { const match = /^\[\d+\]/.exec(state.text.slice(state.index)); if (!match) return ''; state.index += match[0].length; return Number(match[0].slice(1, -1)); };
  base.processNormalCharacter = function(state) { const text = state.text[state.index++], width = this.textWidth(text); this.contents.drawText(text, state.x, state.y, width * 2, state.height); state.x += width; };
  base.processNewLine = function(state) { state.x = state.left; state.y += state.height; state.height = this.calcTextHeight(state, false); ++state.index; };
  base.processNewPage = function(state) { ++state.index; };
  base.processDrawIcon = function(index, state) { this.drawIcon(index, state.x + 2, state.y + 2); state.x += Window_Base._iconWidth + 4; };
  base.processEscapeCharacter = function(code, state) {
    if (code === 'C') this.changeTextColor(this.textColor(this.obtainEscapeParam(state)));
    else if (code === 'I') this.processDrawIcon(this.obtainEscapeParam(state), state);
    else if (code === '{') this.makeFontBigger();
    else if (code === '}') this.makeFontSmaller();
  };
  base.processCharacter = function(state) {
    const code = state.text[state.index];
    if (code === '\n') this.processNewLine(state);
    else if (code === '\f') this.processNewPage(state);
    else if (code === escape) this.processEscapeCharacter(this.obtainEscapeCode(state), state);
    else this.processNormalCharacter(state);
  };
  base.drawTextEx = function(text, x, y) {
    if (!text) return 0;
    const state = { index: 0, text: this.convertEscapeCharacters(text), x, y, left: x };
    state.height = this.calcTextHeight(state, false); this.resetFontSettings();
    while (state.index < state.text.length) this.processCharacter(state);
    return state.x - x;
  };
}

module.exports = { installWindowDrawing };
