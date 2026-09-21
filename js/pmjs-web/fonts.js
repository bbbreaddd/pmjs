'use strict';

(function() {
  globalThis.PMJS = globalThis.PMJS || {};

  var registeredFamilies = Object.create(null);
  var descriptorCache = Object.create(null);

  function normalizeFontUrl(url, basePath) {
    if (!url || typeof url !== 'string') return '';

    var clean = url.trim();
    var qIdx = clean.indexOf('?');
    if (qIdx >= 0) clean = clean.slice(0, qIdx);
    var hIdx = clean.indexOf('#');
    if (hIdx >= 0) clean = clean.slice(0, hIdx);

    try {
      if (clean.indexOf('%') >= 0) clean = decodeURIComponent(clean);
    } catch (_) {}

    var relativeToStylesheet = true;

    if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) {
      if (/^file:(?:\/\/localhost)?\/{1,3}game\//i.test(clean)) {
        clean = clean.replace(/^file:(?:\/\/localhost)?\/{1,3}game\//i, '');
        relativeToStylesheet = false;
      } else {
        return '';
      }
    }

    clean = clean.replace(/\\/g, '/');

    if (clean.indexOf('/game/') === 0) {
      clean = clean.slice(6);
      relativeToStylesheet = false;
    } else if (clean.indexOf('game/') === 0) {
      clean = clean.slice(5);
      relativeToStylesheet = false;
    } else if (clean.charAt(0) === '/') {
      clean = clean.slice(1);
      relativeToStylesheet = false;
    }

    if (relativeToStylesheet && basePath && typeof basePath === 'string') {
      var baseDir = '.';
      var slash = basePath.replace(/\\/g, '/').lastIndexOf('/');
      if (slash >= 0) baseDir = basePath.slice(0, slash);
      if (baseDir !== '.' && baseDir !== '') {
        clean = baseDir + '/' + clean;
      }
    }

    var parts = clean.split('/');
    var resolvedParts = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p === '.') continue;
      if (p === '..') {
        if (!resolvedParts.length) {
          return '';
        }
        resolvedParts.pop();
      } else {
        resolvedParts.push(p);
      }
    }

    return resolvedParts.join('/');
  }

  function registerFace(family, filePath, options) {
    if (!family || !filePath) return false;
    var normFamily = String(family).trim().replace(/^['"]|['"]$/g, '');
    if (!normFamily) return false;
    var normPath = normalizeFontUrl(filePath, options && options.basePath);
    if (!normPath) return false;

    var key = normFamily.toLowerCase();
    var existing = registeredFamilies[key];
    if (existing && existing.isOverride && (options && (options.fromCss || options.fromGame))) {
      return false;
    }

    var style = (options && options.style) || 'normal';
    var weight = (options && options.weight) || 400;
    if (existing && existing.path === normPath && existing.style === style &&
        existing.weight === weight) {
      return true;
    }

    registeredFamilies[key] = {
      family: normFamily,
      path: normPath,
      style: style,
      weight: weight,
      state: 'unknown',
      isOverride: !!(options && options.isOverride)
    };

    descriptorCache = Object.create(null);
    return true;
  }

  function registerFontFaceRule(cssRule, basePath) {
    if (!cssRule || typeof cssRule !== 'string') return false;
    if (!/@font-face/i.test(cssRule)) return false;

    var familyMatch = /font-family\s*:\s*['"]?([^'";}]+)['"]?/i.exec(cssRule);
    if (!familyMatch) return false;
    var family = familyMatch[1].trim();

    var srcMatch = /src\s*:\s*([^;]+);?/i.exec(cssRule);
    if (!srcMatch) return false;
    var srcValue = srcMatch[1];

    var styleMatch = /font-style\s*:\s*['"]?([^'";}]+)['"]?/i.exec(cssRule);
    var weightMatch = /font-weight\s*:\s*['"]?([^'";}]+)['"]?/i.exec(cssRule);
    var options = {
      basePath: basePath,
      style: styleMatch ? styleMatch[1].trim().toLowerCase() : 'normal',
      weight: weightMatch ? weightMatch[1].trim().toLowerCase() : 400,
      fromCss: true
    };

    var urlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
    var match;
    while ((match = urlRegex.exec(srcValue)) !== null) {
      var candidateUrl = match[1].trim();
      if (registerFace(family, candidateUrl, options)) {
        return true;
      }
    }

    return false;
  }

  function registerStylesheet(cssText, stylesheetPath) {
    if (!cssText || typeof cssText !== 'string') return;
    var ruleRegex = /@font-face\s*\{[^}]+\}/gi;
    var match;
    while ((match = ruleRegex.exec(cssText)) !== null) {
      registerFontFaceRule(match[0], stylesheetPath);
    }
  }

  function initConfigFonts() {
    var config = globalThis.pmjsGameConfig || {};
    var fonts = config.fonts || {};
    Object.keys(fonts).forEach(function(family) {
      if (fonts[family]) {
        registerFace(family, fonts[family], { isOverride: true });
      }
    });
  }

  initConfigFonts();

  function probeFontFile(path) {
    if (!path) return false;
    if (typeof NativeHost !== 'undefined' && NativeHost.canvas &&
        typeof NativeHost.canvas.canLoadFont === 'function') {
      try {
        return Boolean(NativeHost.canvas.canLoadFont(path));
      } catch (_) {
        return false;
      }
    }
    if (typeof NativeHost !== 'undefined' && NativeHost.fs &&
        typeof NativeHost.fs.exists === 'function') {
      try {
        return Boolean(NativeHost.fs.exists(path));
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function ensureFaceReady(entry) {
    if (!entry) return false;
    if (entry.state === 'ready') return true;
    if (entry.state === 'failed') return false;

    if (probeFontFile(entry.path)) {
      entry.state = 'ready';
      return true;
    }
    entry.state = 'failed';
    return false;
  }

  function isFamilyLoaded(family) {
    if (!family || typeof family !== 'string') return false;
    var norm = family.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    if (!norm) return false;

    var entry = registeredFamilies[norm];
    if (!entry) return false;
    return ensureFaceReady(entry);
  }

  function hasFamily(family) {
    if (!family) return false;
    var key = String(family).trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(registeredFamilies, key);
  }

  function parseDescriptor(fontString) {
    var raw = String(fontString || '').trim();
    if (!raw) {
      return { size: 10, style: 'normal', weight: 400, families: ['GameFont'] };
    }

    var sizeMatch = /(\d+(?:\.\d+)?)px/i.exec(raw);
    var size = sizeMatch ? Math.max(1, Math.round(Number(sizeMatch[1]))) : 10;
    var sizeEndIndex = sizeMatch ? sizeMatch.index + sizeMatch[0].length : 0;

    var prefix = raw.slice(0, sizeMatch ? sizeMatch.index : 0).toLowerCase();
    var style = prefix.indexOf('italic') >= 0 ? 'italic' : (prefix.indexOf('oblique') >= 0 ? 'oblique' : 'normal');
    var weight = 400;
    if (prefix.indexOf('bold') >= 0) weight = 700;
    var weightMatch = /\b([1-9]00)\b/.exec(prefix);
    if (weightMatch) weight = Number(weightMatch[1]);

    var familyPart = raw.slice(sizeEndIndex).trim();
    var families = [];
    var current = '';
    var inQuote = null;
    for (var i = 0; i < familyPart.length; i++) {
      var ch = familyPart.charAt(i);
      if (inQuote) {
        if (ch === inQuote) {
          inQuote = null;
        } else {
          current += ch;
        }
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === ',') {
        var trimmed = current.trim();
        if (trimmed) families.push(trimmed);
        current = '';
      } else {
        current += ch;
      }
    }
    var lastTrimmed = current.trim();
    if (lastTrimmed) families.push(lastTrimmed);

    if (!families.length) families.push('GameFont');

    return {
      size: size,
      style: style,
      weight: weight,
      families: families
    };
  }

  function resolveDescriptor(canvasFontString) {
    var cacheKey = String(canvasFontString || '').trim();
    if (cacheKey && descriptorCache[cacheKey]) {
      return descriptorCache[cacheKey];
    }

    var descriptor = parseDescriptor(canvasFontString);
    var matchedFaces = [];

    for (var i = 0; i < descriptor.families.length; i++) {
      var fam = descriptor.families[i];
      var key = fam.toLowerCase();
      var entry = registeredFamilies[key];
      if (entry && ensureFaceReady(entry)) {
        matchedFaces.push({ family: entry.family, path: entry.path });
        break;
      }
    }

    if (!matchedFaces.length) {
      var gameFontEntry = registeredFamilies.gamefont;
      var defaultPath = (gameFontEntry && gameFontEntry.path) ? gameFontEntry.path : 'fonts/gamefont.ttf';
      matchedFaces.push({ family: 'GameFont', path: defaultPath });
    }

    var resolved = {
      size: descriptor.size,
      style: descriptor.style,
      weight: descriptor.weight,
      families: descriptor.families,
      faces: matchedFaces
    };

    if (cacheKey) {
      descriptorCache[cacheKey] = resolved;
    }

    return resolved;
  }

  function getRegisteredFaces() {
    var snapshot = Object.create(null);
    var keys = Object.keys(registeredFamilies);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var e = registeredFamilies[k];
      snapshot[k] = {
        family: e.family,
        path: e.path,
        style: e.style,
        weight: e.weight,
        state: e.state
      };
    }
    return snapshot;
  }

  PMJS.fonts = {
    normalizeFontUrl: normalizeFontUrl,
    registerFace: registerFace,
    registerFontFaceRule: registerFontFaceRule,
    registerStylesheet: registerStylesheet,
    hasFamily: hasFamily,
    isFamilyLoaded: isFamilyLoaded,
    parseDescriptor: parseDescriptor,
    resolveDescriptor: resolveDescriptor,
    getRegisteredFaces: getRegisteredFaces
  };
})();
