#pragma once

#include <stdexcept>
#include <string>

namespace pmjs::renderer_shaders {
constexpr const char* triangleClipCoverageSource = R"(
  highp float triangleClipCoverage(highp vec2 pixel, highp vec2 points[3], highp vec2 inward[3]) {
    highp float coverage = 1.0;
    for (int edge = 0; edge < 3; ++edge) {
      coverage *= clamp(0.5 + dot(pixel - points[edge], inward[edge]), 0.0, 1.0);
    }
    return floor(coverage * 255.0 + 0.5) / 255.0;
  }
)";
inline std::string withTriangleClipCoverage(std::string source) {
  source.insert(source.find("  uniform"), triangleClipCoverageSource);
  return source;
}

constexpr const char* clearTriangleFragmentSource = R"(#version 300 es
  precision highp float;
  uniform vec2 points[3];
  uniform vec2 inward[3];
  uniform vec4 clearRectangle;
  out vec4 outputColor;
  void main() {
    vec2 rectangle = clamp(gl_FragCoord.xy - clearRectangle.xy + vec2(0.5), 0.0, 1.0)
      * clamp(clearRectangle.zw - gl_FragCoord.xy + vec2(0.5), 0.0, 1.0);
    float coverage = triangleClipCoverage(gl_FragCoord.xy, points, inward);
    outputColor = vec4(0.0, 0.0, 0.0, coverage * rectangle.x * rectangle.y);
  }
)";

constexpr const char* primitiveSurfaceFragmentSource = R"(#version 300 es
  precision mediump float;
  uniform vec2 surfaceSize;
  uniform int primitiveKind;
  uniform vec2 center;
  uniform vec2 radii;
  uniform int stopCount;
  uniform float stopOffsets[3];
  uniform vec4 stopColors[3];
  out vec4 outputColor;
  void main() {
    float amount = 0.0;
    if (primitiveKind == 1) {
      vec2 point = vec2(gl_FragCoord.x, surfaceSize.y - gl_FragCoord.y);
      amount = clamp((distance(point, center) - radii.x) /
        max(0.0001, radii.y - radii.x), 0.0, 1.0);
    }
    vec4 color = stopColors[0];
    for (int index = 1; index < 3; ++index) {
      if (index >= stopCount) break;
      float span = stopOffsets[index] - stopOffsets[index - 1];
      float mixAmount = clamp((amount - stopOffsets[index - 1]) /
        max(0.0001, span), 0.0, 1.0);
      color = mix(color, stopColors[index], mixAmount);
      if (amount <= stopOffsets[index]) break;
    }
    outputColor = vec4(color.rgb * color.a, color.a);
  }
)";
constexpr const char* vertexSource = R"(#version 300 es
  layout(location = 0) in vec2 position;
  layout(location = 1) in vec2 uv;
  layout(location = 2) in vec4 color;
  layout(location = 3) in vec4 uvClamp;
  uniform bool targetYDown;
  uniform highp mat3 targetProjection;
  uniform bool spriteWorldVertices;
  uniform mat3 spriteProjection;
  out vec2 vertexUv;
  out vec2 filterCoord;
  out vec4 vertexColor;
  out vec4 vertexUvClamp;
  void main() {
    gl_Position = vec4(spriteWorldVertices ? (spriteProjection * vec3(position, 1.0)).xy : position, 0.0, 1.0);
    if (targetYDown && !spriteWorldVertices) gl_Position.y = -gl_Position.y;
    if (!spriteWorldVertices) gl_Position.xy = (targetProjection * vec3(gl_Position.xy, 1.0)).xy;
    vertexUv = uv;
    filterCoord = vec2(uv.x, 1.0 - uv.y);
    vertexColor = color;
    vertexUvClamp = uvClamp;
  }
)";
constexpr const char* fragmentSource = R"(#version 300 es
  precision mediump float;
  uniform sampler2D image;
  uniform bool imageYDown;
  uniform vec2 imageDimensions;
  uniform float blurRadius;
  uniform vec2 blurDirection;
  uniform sampler2D displacementImage;
  uniform bool displacementEnabled;
  uniform vec4 displacementBounds;
  uniform vec2 displacementScale;
  uniform bool noiseGlitchEnabled;
  uniform vec4 noiseGlitchParameters;
  uniform int pixiFilterKind;
  uniform float pixiFilterParameters[10];
  uniform sampler2D bloomImage;
  uniform bool premultipliedInput;
  uniform sampler2D maskImage;
  uniform bool maskEnabled;
  uniform float maskTransform[6];
  uniform vec4 maskFrame;
  uniform vec2 maskTextureSize;
  uniform bool targetYDown;
  uniform float screenHeight;
  uniform float maskAlpha;
  uniform bool maskUsesRed;
  uniform int maskRotation;
  uniform vec2 maskLocalSize;
  uniform bool colorMatrixEnabled;
  uniform float colorMatrix[20];
  uniform float colorMatrixAlpha;
  uniform bool spriteColorEnabled;
  uniform vec4 spriteColorTone;
  uniform vec4 spriteBlendColor;
  in vec2 vertexUv;
  in vec2 filterCoord;
  in vec4 vertexColor;
  in vec4 vertexUvClamp;
  out vec4 outputColor;
  vec3 mzRgbToHsl(vec3 rgb) {
    float lo = min(rgb.r, min(rgb.g, rgb.b));
    float hi = max(rgb.r, max(rgb.g, rgb.b));
    float delta = hi - lo;
    float lightness = (lo + hi) / 2.0;
    float hue = 0.0;
    float saturation = 0.0;
    if (delta > 0.0) {
      if (rgb.r == hi) hue = mod((rgb.g - rgb.b) / delta + 6.0, 6.0) / 6.0;
      else if (rgb.g == hi) hue = ((rgb.b - rgb.r) / delta + 2.0) / 6.0;
      else hue = ((rgb.r - rgb.g) / delta + 4.0) / 6.0;
      if (lightness < 1.0) saturation = delta / (1.0 - abs(2.0 * lightness - 1.0));
    }
    return vec3(hue, saturation, lightness);
  }
  vec3 mzHslToRgb(vec3 hsl) {
    float chroma = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
    float x = chroma * (1.0 - abs(mod(hsl.x * 6.0, 2.0) - 1.0));
    float m = hsl.z - chroma / 2.0;
    vec3 rgb;
    if (hsl.x < 1.0 / 6.0) rgb = vec3(chroma, x, 0.0);
    else if (hsl.x < 2.0 / 6.0) rgb = vec3(x, chroma, 0.0);
    else if (hsl.x < 3.0 / 6.0) rgb = vec3(0.0, chroma, x);
    else if (hsl.x < 4.0 / 6.0) rgb = vec3(0.0, x, chroma);
    else if (hsl.x < 5.0 / 6.0) rgb = vec3(x, 0.0, chroma);
    else rgb = vec3(chroma, 0.0, x);
    return rgb + vec3(m);
  }
  highp float pmjsRandom(highp vec2 coordinate) {
    coordinate = mod(coordinate, vec2(4096.0));
    return fract(sin(dot(coordinate, vec2(12.9898, 78.233))) * 43758.5453);
  }
  highp float pmjsZoomRandom(highp vec2 co) {
    const highp float a = 12.9898, b = 78.233, c = 43758.5453;
    highp float dt = dot(co, vec2(a, b)), sn = mod(dt, 3.14159);
    return fract(sin(sn) * c);
  }
  vec3 pmjsMod289(vec3 value) {
    return value - floor(value * (1.0 / 289.0)) * 289.0;
  }
  vec4 pmjsMod289(vec4 value) {
    return value - floor(value * (1.0 / 289.0)) * 289.0;
  }
  vec4 pmjsPermute(vec4 value) {
    return pmjsMod289(((value * 34.0) + 1.0) * value);
  }
  vec4 pmjsTaylorInvSqrt(vec4 value) {
    return 1.79284291400159 - 0.85373472095314 * value;
  }
  vec3 pmjsFade(vec3 value) {
    return value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
  }
  float pmjsPeriodicNoise(vec3 point, vec3 repetition) {
    vec3 integer0 = mod(floor(point), repetition);
    vec3 integer1 = mod(integer0 + vec3(1.0), repetition);
    integer0 = pmjsMod289(integer0);
    integer1 = pmjsMod289(integer1);
    vec3 fraction0 = fract(point);
    vec3 fraction1 = fraction0 - vec3(1.0);
    vec4 ix = vec4(integer0.x, integer1.x, integer0.x, integer1.x);
    vec4 iy = vec4(integer0.yy, integer1.yy);
    vec4 ixy = pmjsPermute(pmjsPermute(ix) + iy);
    vec4 ixy0 = pmjsPermute(ixy + integer0.zzzz);
    vec4 ixy1 = pmjsPermute(ixy + integer1.zzzz);
    vec4 gx0 = ixy0 * (1.0 / 7.0);
    vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
    gx0 = fract(gx0);
    vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
    vec4 sign0 = step(gz0, vec4(0.0));
    gx0 -= sign0 * (step(0.0, gx0) - 0.5);
    gy0 -= sign0 * (step(0.0, gy0) - 0.5);
    vec4 gx1 = ixy1 * (1.0 / 7.0);
    vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
    gx1 = fract(gx1);
    vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
    vec4 sign1 = step(gz1, vec4(0.0));
    gx1 -= sign1 * (step(0.0, gx1) - 0.5);
    gy1 -= sign1 * (step(0.0, gy1) - 0.5);
    vec3 gradient000 = vec3(gx0.x, gy0.x, gz0.x);
    vec3 gradient100 = vec3(gx0.y, gy0.y, gz0.y);
    vec3 gradient010 = vec3(gx0.z, gy0.z, gz0.z);
    vec3 gradient110 = vec3(gx0.w, gy0.w, gz0.w);
    vec3 gradient001 = vec3(gx1.x, gy1.x, gz1.x);
    vec3 gradient101 = vec3(gx1.y, gy1.y, gz1.y);
    vec3 gradient011 = vec3(gx1.z, gy1.z, gz1.z);
    vec3 gradient111 = vec3(gx1.w, gy1.w, gz1.w);
    vec4 norm0 = pmjsTaylorInvSqrt(vec4(dot(gradient000, gradient000),
      dot(gradient010, gradient010), dot(gradient100, gradient100),
      dot(gradient110, gradient110)));
    gradient000 *= norm0.x; gradient010 *= norm0.y;
    gradient100 *= norm0.z; gradient110 *= norm0.w;
    vec4 norm1 = pmjsTaylorInvSqrt(vec4(dot(gradient001, gradient001),
      dot(gradient011, gradient011), dot(gradient101, gradient101),
      dot(gradient111, gradient111)));
    gradient001 *= norm1.x; gradient011 *= norm1.y;
    gradient101 *= norm1.z; gradient111 *= norm1.w;
    float noise000 = dot(gradient000, fraction0);
    float noise100 = dot(gradient100, vec3(fraction1.x, fraction0.yz));
    float noise010 = dot(gradient010, vec3(fraction0.x, fraction1.y, fraction0.z));
    float noise110 = dot(gradient110, vec3(fraction1.xy, fraction0.z));
    float noise001 = dot(gradient001, vec3(fraction0.xy, fraction1.z));
    float noise101 = dot(gradient101, vec3(fraction1.x, fraction0.y, fraction1.z));
    float noise011 = dot(gradient011, vec3(fraction0.x, fraction1.yz));
    float noise111 = dot(gradient111, fraction1);
    vec3 fadeValue = pmjsFade(fraction0);
    vec4 noiseZ = mix(vec4(noise000, noise100, noise010, noise110),
      vec4(noise001, noise101, noise011, noise111), fadeValue.z);
    vec2 noiseY = mix(noiseZ.xy, noiseZ.zw, fadeValue.y);
    return 2.2 * mix(noiseY.x, noiseY.y, fadeValue.x);
  }
  float pmjsTurbulence(vec3 point, vec3 repetition,
      float lacunarity, float gain) {
    float sum = 0.0;
    float scale = 1.0;
    float totalGain = 1.0;
    for (int octave = 0; octave < 6; ++octave) {
      sum += totalGain * pmjsPeriodicNoise(point * scale, repetition);
      scale *= lacunarity;
      totalGain *= gain;
    }
    return abs(sum);
  }
  vec4 sampleImage(vec2 uv) {
    return texture(image, vec2(uv.x, imageYDown ? 1.0 - uv.y : uv.y));
  }
  void main() {
    vec2 sampleUv = vertexUv;
    if (pixiFilterKind == 1) {
      bool pixi5 = pixiFilterParameters[9] == 1.0;
      // Native filter textures have inverted Y; retain stock interpolation before rounding.
      vec2 coord = pixi5 ? filterCoord : sampleUv;
      vec2 center = vec2(pixiFilterParameters[0], pixiFilterParameters[1]) / imageDimensions;
      vec2 direction = center - coord;
      float distanceToCenter = length(vec2(direction.x, direction.y * imageDimensions.y / imageDimensions.x));
      float innerGradient = pixiFilterParameters[3] * 0.3;
      float innerRadius = (pixiFilterParameters[3] + innerGradient * 0.5) / imageDimensions.x;
      float outerGradient = pixiFilterParameters[4] * 0.3;
      float outerRadius = pixiFilterParameters[4] < 0.0 ? -1.0 :
        (pixiFilterParameters[4] - outerGradient * 0.5) / imageDimensions.x;
      float sampleLimit = 32.0;
      float strength = pixiFilterParameters[2];
      float delta = 0.0;
      float gradientPixels = 1.0;
      if (distanceToCenter < innerRadius) {
        delta = innerRadius - distanceToCenter;
        gradientPixels = innerGradient;
      } else if (outerRadius >= 0.0 && distanceToCenter > outerRadius) {
        delta = distanceToCenter - outerRadius;
        gradientPixels = outerGradient;
      }
      if (delta > 0.0) {
        float normalizedGradient = gradientPixels / imageDimensions.x;
        float edge = normalizedGradient > 0.0 ?
          (normalizedGradient - delta) / normalizedGradient : 0.0;
        sampleLimit *= edge;
        strength *= edge;
        if (sampleLimit < 1.0) {
          outputColor = sampleImage(sampleUv) * vertexColor;
          return;
        }
      }
      direction *= strength;
      vec4 accumulated = vec4(0.0);
      float totalWeight = 0.0;
      float randomOffset = pixi5 ? pmjsZoomRandom(coord) : pmjsRandom(sampleUv * imageDimensions);
      for (int sampleIndex = 0; sampleIndex < 32; ++sampleIndex) {
        if (!pixi5 && float(sampleIndex) > sampleLimit) break;
        float percent = (float(sampleIndex) + randomOffset) / 32.0;
        float weight = 4.0 * (percent - percent * percent);
        vec2 point = coord + direction * percent;
        highp vec2 highPoint = point;
        highp vec2 lookup = pixi5 ? vec2(highPoint.x, 1.0 - highPoint.y) :
          clamp(point, vertexUvClamp.xy, vertexUvClamp.zw);
        accumulated += sampleImage(lookup) * weight;
        totalWeight += weight;
        // The reviewed Pixi 5 shader includes the first sample beyond its radius limit.
        if (pixi5 && float(sampleIndex) > sampleLimit) break;
      }
      outputColor = accumulated / max(totalWeight, 0.00001) * vertexColor;
      return;
    }
    if (pixiFilterKind == 2) {
      vec2 center = vec2(pixiFilterParameters[0], pixiFilterParameters[1]) / imageDimensions;
      float halfWavelength = pixiFilterParameters[3] * 0.5 / imageDimensions.x;
      float currentRadius = pixiFilterParameters[5] * pixiFilterParameters[6] / imageDimensions.x;
      vec2 direction = sampleUv - center;
      direction.y *= imageDimensions.y / imageDimensions.x;
      float distanceToCenter = length(direction);
      float fade = pixiFilterParameters[7] > 0.0 ? max(0.0, 1.0 - pow(currentRadius / (pixiFilterParameters[7] / imageDimensions.x), 2.0)) : 1.0;
      if (halfWavelength > 0.0 && distanceToCenter > 0.0 && fade > 0.0 && abs(distanceToCenter - currentRadius) <= halfWavelength) {
        float difference = (distanceToCenter - currentRadius) / halfWavelength;
        float power = 1.0 - difference * difference;
        float offset = 1.25 * sin(difference * 3.14159) * power * pixiFilterParameters[2] * fade;
        sampleUv = clamp(sampleUv + normalize(direction) * offset / imageDimensions, vertexUvClamp.xy, vertexUvClamp.zw);
      }
    }
    if (pixiFilterKind == 3) {
      vec4 extracted = sampleImage(sampleUv);
      float maximum = max(max(extracted.r, extracted.g), extracted.b);
      float minimum = min(min(extracted.r, extracted.g), extracted.b);
      outputColor = (maximum + minimum) * 0.5 > pixiFilterParameters[0] ?
        extracted * vertexColor : vec4(0.0);
      return;
    }
    if (pixiFilterKind == 22) {
      vec4 base = sampleImage(sampleUv) * pixiFilterParameters[0];
      vec4 bloom = texture(bloomImage, sampleUv) * pixiFilterParameters[1];
      outputColor = (base + bloom) * vertexColor;
      return;
    }
    if (pixiFilterKind == 23 || pixiFilterKind == 24) {
      vec4 source = sampleImage(sampleUv) * vertexColor;
      vec4 target = texture(bloomImage, vec2(sampleUv.x, targetYDown ? 1.0 - sampleUv.y : sampleUv.y));
      if (source.a <= 0.0) {
        outputColor = target;
        return;
      }
      vec3 sourceRgb = source.rgb / source.a;
      vec3 targetRgb = target.a > 0.0 ? target.rgb / target.a : vec3(0.0);
      vec3 multiplied = sourceRgb * targetRgb * 2.0;
      vec3 screenBase = pixiFilterKind == 23 ? sourceRgb : targetRgb;
      vec3 screenOther = pixiFilterKind == 23 ? targetRgb : sourceRgb;
      vec3 doubled = screenBase * 2.0 - 1.0;
      vec3 screened = doubled + screenOther - doubled * screenOther;
      vec3 selector = pixiFilterKind == 23 ? sourceRgb : targetRgb;
      vec3 blended = mix(multiplied, screened,
        step(vec3(0.5), selector));
      float resultAlpha = source.a + target.a * (1.0 - source.a);
      vec3 resultRgb = (1.0 - source.a) * targetRgb + source.a * blended;
      outputColor = vec4(resultRgb * resultAlpha, resultAlpha);
      return;
    }
    if (pixiFilterKind == 26) {
      vec4 color = sampleImage(sampleUv);
      if (color.a <= 0.0) { outputColor = vec4(0.0); return; }
      vec3 hsl = mzRgbToHsl(color.rgb);
      hsl.x = mod(hsl.x + pixiFilterParameters[0] / 360.0, 1.0);
      hsl.y *= 1.0 - pixiFilterParameters[4] / 255.0;
      vec3 rgb = mzHslToRgb(hsl);
      vec3 tone = vec3(pixiFilterParameters[1], pixiFilterParameters[2],
        pixiFilterParameters[3]) / 255.0;
      vec3 blend = vec3(pixiFilterParameters[5], pixiFilterParameters[6],
        pixiFilterParameters[7]) / 255.0;
      float intensity = pixiFilterParameters[8] / 255.0;
      rgb = clamp((rgb / color.a + tone) * color.a, 0.0, 1.0);
      rgb = clamp(rgb * (1.0 - intensity) + blend * intensity * color.a, 0.0, 1.0);
      outputColor = vec4(rgb * pixiFilterParameters[9] / 255.0, color.a) * vertexColor;
      return;
    }
    if (pixiFilterKind == 25) {
      vec2 inverseSize = 1.0 / imageDimensions;
      vec3 rgbNW = sampleImage(clamp(sampleUv + vec2(-1.0, -1.0) * inverseSize,
        vertexUvClamp.xy, vertexUvClamp.zw)).rgb;
      vec3 rgbNE = sampleImage(clamp(sampleUv + vec2(1.0, -1.0) * inverseSize,
        vertexUvClamp.xy, vertexUvClamp.zw)).rgb;
      vec3 rgbSW = sampleImage(clamp(sampleUv + vec2(-1.0, 1.0) * inverseSize,
        vertexUvClamp.xy, vertexUvClamp.zw)).rgb;
      vec3 rgbSE = sampleImage(clamp(sampleUv + vec2(1.0, 1.0) * inverseSize,
        vertexUvClamp.xy, vertexUvClamp.zw)).rgb;
      vec4 centerColor = sampleImage(sampleUv);
      vec3 luma = vec3(0.299, 0.587, 0.114);
      float lumaNW = dot(rgbNW, luma);
      float lumaNE = dot(rgbNE, luma);
      float lumaSW = dot(rgbSW, luma);
      float lumaSE = dot(rgbSE, luma);
      float lumaM = dot(centerColor.rgb, luma);
      float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
      float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
      vec2 direction;
      direction.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
      direction.y = (lumaNW + lumaSW) - (lumaNE + lumaSE);
      float directionReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) *
        (0.25 / 8.0), 1.0 / 128.0);
      float reciprocalMinimum = 1.0 /
        (min(abs(direction.x), abs(direction.y)) + directionReduce);
      direction = clamp(direction * reciprocalMinimum, vec2(-8.0), vec2(8.0)) *
        inverseSize;
      vec3 rgbA = 0.5 * (
        sampleImage(clamp(sampleUv + direction * (1.0 / 3.0 - 0.5),
          vertexUvClamp.xy, vertexUvClamp.zw)).rgb +
        sampleImage(clamp(sampleUv + direction * (2.0 / 3.0 - 0.5),
          vertexUvClamp.xy, vertexUvClamp.zw)).rgb);
      vec3 rgbB = rgbA * 0.5 + 0.25 * (
        sampleImage(clamp(sampleUv - direction * 0.5,
          vertexUvClamp.xy, vertexUvClamp.zw)).rgb +
        sampleImage(clamp(sampleUv + direction * 0.5,
          vertexUvClamp.xy, vertexUvClamp.zw)).rgb);
      float lumaB = dot(rgbB, luma);
      outputColor = vec4(lumaB < lumaMin || lumaB > lumaMax ? rgbA : rgbB,
        centerColor.a) * vertexColor;
      return;
    }
    if (pixiFilterKind == 4) {
      vec2 coordinate = vertexUv;
      vec2 direction = coordinate - vec2(0.5);
      float curvature = pixiFilterParameters[0] > 0.0 ? pixiFilterParameters[0] : 1.0;
      float curveScale = pixiFilterParameters[0] > 0.0 ?
        length(direction * direction) * 0.25 * curvature * curvature + 0.935 * curvature : 1.0;
      vec2 curved = direction * curveScale;
      sampleUv = clamp(coordinate, vertexUvClamp.xy, vertexUvClamp.zw);
      vec4 crtColor = sampleImage(sampleUv);
      vec3 crtRgb = crtColor.rgb;
      if (pixiFilterParameters[4] > 0.0 && pixiFilterParameters[5] > 0.0) {
        vec2 noisePixel = floor(coordinate * imageDimensions / pixiFilterParameters[5]);
        float grain = pmjsRandom(noisePixel * pixiFilterParameters[5] +
          vec2(pixiFilterParameters[9])) - 0.5;
        crtRgb += grain * pixiFilterParameters[4] * crtColor.a;
      }
      if (pixiFilterParameters[1] > 0.0) {
        float axis = pixiFilterParameters[3] > 0.5 ? curved.x * imageDimensions.x : curved.y * imageDimensions.y;
        float line = 1.0 + cos(axis * 1.2 - pixiFilterParameters[9]) * 0.5 * pixiFilterParameters[2];
        crtRgb *= line;
        float segment = pixiFilterParameters[3] > 0.5 ?
          mod((direction.x + 0.5) * imageDimensions.x, 4.0) :
          mod((direction.y + 0.5) * imageDimensions.y, 4.0);
        crtRgb *= 0.99 + ceil(segment) * 0.015;
      }
      if (pixiFilterParameters[6] > 0.0) {
        float outer = 1.414213 - pixiFilterParameters[6] * 1.414213;
        float darker = clamp((outer - length(direction) * 1.414213) /
          (0.00001 + pixiFilterParameters[8] * 1.414213), 0.0, 1.0);
        crtRgb *= darker + (1.0 - darker) * (1.0 - pixiFilterParameters[7]);
      }
      outputColor = vec4(crtRgb, crtColor.a) * vertexColor;
      return;
    }
    if (pixiFilterKind == 5) {
      vec4 adjusted = sampleImage(sampleUv);
      if (adjusted.a > 0.0) {
        vec3 rgb = pow(adjusted.rgb / adjusted.a,
          vec3(1.0 / max(pixiFilterParameters[0], 0.0001)));
        float luminance = dot(vec3(0.2125, 0.7154, 0.0721), rgb);
        rgb = mix(vec3(0.5), mix(vec3(luminance), rgb,
          pixiFilterParameters[2]), pixiFilterParameters[1]);
        rgb *= vec3(pixiFilterParameters[4], pixiFilterParameters[5],
          pixiFilterParameters[6]) * pixiFilterParameters[3];
        adjusted.rgb = rgb * adjusted.a;
      }
      outputColor = adjusted * pixiFilterParameters[7] * vertexColor;
      return;
    }
    if (pixiFilterKind == 6) {
      vec2 pixelSize = max(vec2(1.0),
        vec2(pixiFilterParameters[0], pixiFilterParameters[1]));
      sampleUv = floor(sampleUv * imageDimensions / pixelSize) *
        pixelSize / imageDimensions;
    }
    if (pixiFilterKind == 7) {
      vec4 centerSample = sampleImage(sampleUv);
      vec4 redSample = sampleImage(clamp(sampleUv +
        vec2(pixiFilterParameters[0], pixiFilterParameters[1]) / imageDimensions,
        vertexUvClamp.xy, vertexUvClamp.zw));
      vec4 greenSample = sampleImage(clamp(sampleUv +
        vec2(pixiFilterParameters[2], pixiFilterParameters[3]) / imageDimensions,
        vertexUvClamp.xy, vertexUvClamp.zw));
      vec4 blueSample = sampleImage(clamp(sampleUv +
        vec2(pixiFilterParameters[4], pixiFilterParameters[5]) / imageDimensions,
        vertexUvClamp.xy, vertexUvClamp.zw));
      outputColor = vec4(redSample.r, greenSample.g, blueSample.b,
        centerSample.a) * vertexColor;
      return;
    }
    if (pixiFilterKind == 8 && pixiFilterParameters[2] > 0.0) {
      vec2 pixelCoordinate = sampleUv * imageDimensions;
      vec2 center = vec2(pixiFilterParameters[0], pixiFilterParameters[1]) *
        imageDimensions;
      pixelCoordinate -= center;
      float distanceToCenter = length(pixelCoordinate);
      float radius = pixiFilterParameters[2];
      if (distanceToCenter > 0.0 && distanceToCenter < radius) {
        float percent = distanceToCenter / radius;
        float strength = pixiFilterParameters[3];
        if (strength > 0.0) {
          pixelCoordinate *= mix(1.0,
            smoothstep(0.0, radius / distanceToCenter, percent),
            strength * 0.75);
        } else {
          pixelCoordinate *= mix(1.0,
            pow(percent, 1.0 + strength * 0.75) *
              radius / distanceToCenter,
            1.0 - percent);
        }
      }
      sampleUv = clamp((pixelCoordinate + center) / imageDimensions,
        vertexUvClamp.xy, vertexUvClamp.zw);
    }
    if (pixiFilterKind == 9 && pixiFilterParameters[2] > 0.0) {
      vec2 coordinate = sampleUv * imageDimensions -
        vec2(pixiFilterParameters[0], pixiFilterParameters[1]);
      float distanceToCenter = length(coordinate);
      if (distanceToCenter < pixiFilterParameters[2]) {
        float ratio = (pixiFilterParameters[2] - distanceToCenter) /
          pixiFilterParameters[2];
        float twistAngle = ratio * ratio * pixiFilterParameters[3];
        float sine = sin(twistAngle);
        float cosine = cos(twistAngle);
        coordinate = vec2(coordinate.x * cosine - coordinate.y * sine,
          coordinate.x * sine + coordinate.y * cosine);
      }
      sampleUv = clamp((coordinate +
        vec2(pixiFilterParameters[0], pixiFilterParameters[1])) / imageDimensions,
        vertexUvClamp.xy, vertexUvClamp.zw);
    }
    if (pixiFilterKind == 10) {
      float characterSize = max(1.0, pixiFilterParameters[0]);
      vec2 pixelCoordinate = floor(sampleUv * imageDimensions / characterSize) *
        characterSize;
      vec4 asciiColor = sampleImage(pixelCoordinate / imageDimensions);
      float gray = (asciiColor.r + asciiColor.g + asciiColor.b) / 3.0;
      float glyph = gray > 0.8 ? 11512810.0 : gray > 0.7 ? 13199452.0 :
        gray > 0.6 ? 15252014.0 : gray > 0.5 ? 23385164.0 :
        gray > 0.4 ? 15255086.0 : gray > 0.3 ? 332772.0 :
        gray > 0.2 ? 65600.0 : 65536.0;
      vec2 glyphPixel = floor((mod(sampleUv * imageDimensions, characterSize) /
        characterSize * 2.0 - 1.0) * vec2(4.0, -4.0) + 2.5);
      float bitIndex = glyphPixel.x + 5.0 * glyphPixel.y;
      float glyphAlpha = glyphPixel.x >= 0.0 && glyphPixel.x <= 4.0 &&
        glyphPixel.y >= 0.0 && glyphPixel.y <= 4.0 ?
        mod(floor(glyph / exp2(bitIndex)), 2.0) : 0.0;
      outputColor = asciiColor * glyphAlpha * vertexColor;
      return;
    }
    if (pixiFilterKind == 11) {
      float sine = sin(pixiFilterParameters[0]);
      float cosine = cos(pixiFilterParameters[0]);
      vec2 pixelCoordinate = sampleUv * imageDimensions;
      vec2 point = vec2(cosine * pixelCoordinate.x - sine * pixelCoordinate.y,
        sine * pixelCoordinate.x + cosine * pixelCoordinate.y) *
        pixiFilterParameters[1];
      vec4 dotColor = sampleImage(sampleUv);
      float average = (dotColor.r + dotColor.g + dotColor.b) / 3.0;
      float pattern = sin(point.x) * sin(point.y) * 4.0;
      outputColor = vec4(vec3(average * 10.0 - 5.0 + pattern), dotColor.a) *
        vertexColor;
      return;
    }
    if (pixiFilterKind == 12) {
      vec2 onePixel = 1.0 / imageDimensions;
      vec4 embossed = vec4(vec3(0.5), 1.0) -
        sampleImage(clamp(sampleUv - onePixel,
          vertexUvClamp.xy, vertexUvClamp.zw)) * pixiFilterParameters[0] +
        sampleImage(clamp(sampleUv + onePixel,
          vertexUvClamp.xy, vertexUvClamp.zw)) * pixiFilterParameters[0];
      float average = (embossed.r + embossed.g + embossed.b) / 3.0;
      float alpha = sampleImage(sampleUv).a;
      outputColor = vec4(vec3(average) * alpha, alpha) * vertexColor;
      return;
    }
    if (pixiFilterKind == 13) {
      float luminance = length(sampleImage(sampleUv).rgb);
      bool ink = (luminance < 1.0 && mod(gl_FragCoord.x + gl_FragCoord.y, 10.0) < 1.0) ||
        (luminance < 0.75 && mod(gl_FragCoord.x - gl_FragCoord.y, 10.0) < 1.0) ||
        (luminance < 0.5 && mod(gl_FragCoord.x + gl_FragCoord.y - 5.0, 10.0) < 1.0) ||
        (luminance < 0.3 && mod(gl_FragCoord.x - gl_FragCoord.y - 5.0, 10.0) < 1.0);
      outputColor = (ink ? vec4(0.0, 0.0, 0.0, 1.0) :
        vec4(1.0)) * vertexColor;
      return;
    }
    if (pixiFilterKind == 14) {
      int kernelSize = int(pixiFilterParameters[3]);
      if (kernelSize <= 1 || pixiFilterParameters[0] == 0.0) {
        outputColor = sampleImage(sampleUv) * vertexColor;
        return;
      }
      float aspect = imageDimensions.y / imageDimensions.x;
      vec2 center = vec2(pixiFilterParameters[1], pixiFilterParameters[2]) /
        imageDimensions;
      float gradient = pixiFilterParameters[4] / imageDimensions.x * 0.3;
      float radius = pixiFilterParameters[4] < 0.0 ? -1.0 :
        pixiFilterParameters[4] / imageDimensions.x - gradient * 0.5;
      vec2 direction = center - sampleUv;
      float distanceToCenter = length(vec2(direction.x, direction.y * aspect));
      float radianStep = pixiFilterParameters[0] * 3.14159265 / 180.0;
      if (radius >= 0.0 && distanceToCenter > radius) {
        float scale = gradient > 0.0 ?
          1.0 - abs((distanceToCenter - radius) / gradient) : 0.0;
        if (scale <= 0.0) {
          outputColor = sampleImage(sampleUv) * vertexColor;
          return;
        }
        radianStep *= scale;
      }
      radianStep /= float(kernelSize - 1);
      float sine = sin(radianStep);
      float cosine = cos(radianStep);
      mat2 rotation = mat2(vec2(cosine, -sine), vec2(sine, cosine));
      vec2 radialUv = sampleUv;
      vec4 radialColor = sampleImage(radialUv);
      for (int radialIndex = 0; radialIndex < 63; ++radialIndex) {
        if (radialIndex == kernelSize - 1) break;
        radialUv -= center;
        radialUv.y *= aspect;
        radialUv = rotation * radialUv;
        radialUv.y /= aspect;
        radialUv += center;
        radialColor += sampleImage(clamp(radialUv,
          vertexUvClamp.xy, vertexUvClamp.zw));
      }
      outputColor = radialColor / float(kernelSize) * vertexColor;
      return;
    }
    if (pixiFilterKind == 15) {
      float boundary = pixiFilterParameters[0];
      if (sampleUv.y >= boundary) {
        float depth = (sampleUv.y - boundary) / (1.0 - boundary + 0.0001);
        float reflectedY = pixiFilterParameters[1] > 0.5 ?
          boundary + boundary - sampleUv.y : sampleUv.y;
        float amplitude = mix(pixiFilterParameters[2],
          pixiFilterParameters[3], depth) / imageDimensions.x;
        float wavelength = mix(pixiFilterParameters[4],
          pixiFilterParameters[5], depth) / imageDimensions.y;
        float reflectedX = sampleUv.x;
        if (abs(wavelength) > 0.000001) {
          reflectedX += cos(reflectedY * 6.2831853 / wavelength -
            pixiFilterParameters[8]) * amplitude;
        }
        vec4 reflected = sampleImage(clamp(vec2(reflectedX, reflectedY),
          vertexUvClamp.xy, vertexUvClamp.zw));
        outputColor = reflected * mix(pixiFilterParameters[6],
          pixiFilterParameters[7], depth) * vertexColor;
        return;
      }
    }
    if (pixiFilterKind == 16) {
      int kernelSize = int(pixiFilterParameters[2]);
      vec2 pixelVelocity = vec2(pixiFilterParameters[0],
        pixiFilterParameters[1]);
      float velocityLength = length(pixelVelocity);
      if (kernelSize <= 1 || velocityLength <= 0.000001) {
        outputColor = sampleImage(sampleUv) * vertexColor;
        return;
      }
      vec2 velocity = pixelVelocity / imageDimensions;
      float offset = -pixiFilterParameters[3] / velocityLength - 0.5;
      vec4 motionColor = sampleImage(sampleUv);
      for (int motionIndex = 0; motionIndex < 63; ++motionIndex) {
        if (motionIndex == kernelSize - 1) break;
        float amount = float(motionIndex) / float(kernelSize - 1) + offset;
        motionColor += sampleImage(clamp(sampleUv + velocity * amount,
          vertexUvClamp.xy, vertexUvClamp.zw));
      }
      outputColor = motionColor / float(kernelSize) * vertexColor;
      return;
    }
    if (pixiFilterKind == 17) {
      outputColor = sampleImage(sampleUv) * pixiFilterParameters[0] *
        vertexColor;
      return;
    }
    if (pixiFilterKind == 18) {
      vec4 filmSample = sampleImage(sampleUv);
      vec3 filmColor = filmSample.rgb;
      if (pixiFilterParameters[0] > 0.0) {
        float gray = (filmColor.r + filmColor.g + filmColor.b) / 3.0;
        vec3 grayscale = vec3(gray);
        vec3 sepiaColor = vec3(
          gray <= 0.5 ? 2.0 * (112.0 / 255.0) * gray :
            1.0 - 2.0 * (1.0 - gray) * (1.0 - 112.0 / 255.0),
          gray <= 0.5 ? 2.0 * (66.0 / 255.0) * gray :
            1.0 - 2.0 * (1.0 - gray) * (1.0 - 66.0 / 255.0),
          gray <= 0.5 ? 2.0 * (20.0 / 255.0) * gray :
            1.0 - 2.0 * (1.0 - gray) * (1.0 - 20.0 / 255.0));
        filmColor = mix(grayscale, sepiaColor, pixiFilterParameters[0]);
      }
      vec2 filmCoordinate = sampleUv;
      if (pixiFilterParameters[6] > 0.0) {
        float outer = 1.414213 * (1.0 - pixiFilterParameters[6]);
        vec2 direction = vec2(0.5) - filmCoordinate;
        direction.y *= imageDimensions.y / imageDimensions.x;
        float darker = clamp((outer - length(direction) * 1.414213) /
          (0.00001 + pixiFilterParameters[8] * 1.414213), 0.0, 1.0);
        filmColor *= darker + (1.0 - darker) *
          (1.0 - pixiFilterParameters[7]);
      }
      float filmSeed = pixiFilterParameters[9];
      if (pixiFilterParameters[4] > filmSeed &&
          pixiFilterParameters[3] != 0.0) {
        float phase = filmSeed * 256.0;
        float scratchParity = mod(floor(phase), 2.0);
        float distanceScale = 1.0 / pixiFilterParameters[4];
        float scratchDistance = distance(filmCoordinate,
          vec2(filmSeed * distanceScale,
            abs(scratchParity - filmSeed * distanceScale)));
        if (scratchDistance < filmSeed * 0.6 + 0.4) {
          float period = pixiFilterParameters[4] * 10.0;
          float xx = filmCoordinate.x * period + phase;
          float aa = abs(mod(xx, 0.5) * 4.0);
          float bb = mod(floor(xx / 0.5), 2.0);
          float yy = (1.0 - bb) * aa + bb * (2.0 - aa);
          float scratchHeight = pixiFilterParameters[5] / imageDimensions.x *
            (0.75 + filmSeed) * 2.0 * period;
          float line = yy - (2.0 - scratchHeight);
          if (line > 0.0) {
            float scratchSign = sign(pixiFilterParameters[3]);
            line = scratchParity * line / period +
              pixiFilterParameters[3] + 0.1;
            line = clamp(line + 1.0, 0.5 + scratchSign * 0.5,
              1.5 + scratchSign * 0.5);
            filmColor *= line;
          }
        }
      }
      if (pixiFilterParameters[1] > 0.0 &&
          pixiFilterParameters[2] > 0.0) {
        vec2 noisePixel = floor(sampleUv * imageDimensions /
          pixiFilterParameters[2]);
        float grain = pmjsRandom(noisePixel * pixiFilterParameters[2] *
          filmSeed) - 0.5;
        filmColor += grain * pixiFilterParameters[1];
      }
      outputColor = vec4(filmColor, filmSample.a) * vertexColor;
      return;
    }
    if (pixiFilterKind == 19) {
      float glowDistance = pixiFilterParameters[0];
      float angularStep = pixiFilterParameters[6];
      vec4 ownGlowColor = sampleImage(sampleUv);
      float totalAlpha = 0.0;
      float maximumAlpha = 0.0;
      for (int angleIndex = 0; angleIndex < 64; ++angleIndex) {
        float angle = float(angleIndex) * angularStep;
        if (angle > 6.28318531) break;
        vec2 direction = vec2(cos(angle), sin(angle));
        for (int distanceIndex = 1; distanceIndex <= 32; ++distanceIndex) {
          float currentDistance = float(distanceIndex);
          if (currentDistance > glowDistance) break;
          vec4 neighbor = sampleImage(clamp(sampleUv + direction *
            currentDistance / imageDimensions,
            vertexUvClamp.xy, vertexUvClamp.zw));
          float weight = glowDistance - currentDistance;
          totalAlpha += weight * neighbor.a;
          maximumAlpha += weight;
        }
      }
      maximumAlpha = max(maximumAlpha, 0.0001);
      float ownAlpha = max(ownGlowColor.a, 0.0001);
      vec3 ownRgb = ownGlowColor.rgb / ownAlpha;
      vec3 glowRgb = vec3(pixiFilterParameters[3], pixiFilterParameters[4],
        pixiFilterParameters[5]);
      float outerAlpha = totalAlpha / maximumAlpha *
        pixiFilterParameters[1] * (1.0 - ownAlpha);
      float innerAlpha = (maximumAlpha - totalAlpha) / maximumAlpha *
        pixiFilterParameters[2] * ownAlpha;
      float resultAlpha = ownAlpha + outerAlpha;
      vec3 innerColor = mix(ownRgb, glowRgb, innerAlpha / ownAlpha);
      vec3 resultRgb = resultAlpha > 0.0 ?
        mix(innerColor, glowRgb, outerAlpha / resultAlpha) * resultAlpha :
        vec3(0.0);
      outputColor = vec4(resultRgb, resultAlpha) * vertexColor;
      return;
    }
    if (pixiFilterKind == 20) {
      float aspect = imageDimensions.y / imageDimensions.x;
      float directionValue;
      if (pixiFilterParameters[0] > 0.5) {
        directionValue = pixiFilterParameters[1] * sampleUv.x +
          pixiFilterParameters[2] * sampleUv.y * aspect;
      } else {
        float deltaX = sampleUv.x - pixiFilterParameters[1] / imageDimensions.x;
        float deltaY = (sampleUv.y - pixiFilterParameters[2] /
          imageDimensions.y) * aspect;
        directionValue = deltaY / (sqrt(deltaX * deltaX + deltaY * deltaY) +
          0.00001);
      }
      vec3 direction = vec3(directionValue);
      float rayNoise = pmjsTurbulence(direction +
        vec3(pixiFilterParameters[5], 0.0, 62.1 + pixiFilterParameters[5]) *
          0.05,
        vec3(480.0, 320.0, 480.0), pixiFilterParameters[4],
        pixiFilterParameters[3]) * 0.7;
      vec4 mist = vec4(vec3(rayNoise), 1.0) * (1.0 - sampleUv.y);
      mist.a = 1.0;
      outputColor = (sampleImage(sampleUv) + mist *
        pixiFilterParameters[6]) * vertexColor;
      return;
    }
    if (pixiFilterKind == 21) {
      vec2 offset = (pixiFilterParameters[0] + 0.5) *
        vec2(pixiFilterParameters[1], pixiFilterParameters[2]) / imageDimensions;
      vec4 kawaseColor = sampleImage(clamp(sampleUv +
        vec2(-offset.x, offset.y), vertexUvClamp.xy, vertexUvClamp.zw));
      kawaseColor += sampleImage(clamp(sampleUv + offset,
        vertexUvClamp.xy, vertexUvClamp.zw));
      kawaseColor += sampleImage(clamp(sampleUv +
        vec2(offset.x, -offset.y), vertexUvClamp.xy, vertexUvClamp.zw));
      kawaseColor += sampleImage(clamp(sampleUv - offset,
        vertexUvClamp.xy, vertexUvClamp.zw));
      outputColor = kawaseColor * 0.25 * vertexColor;
      return;
    }
    if (displacementEnabled) {
      vec2 maskUv = (vertexUv * imageDimensions - displacementBounds.xy) /
        displacementBounds.zw;
      vec2 displacement = texture(displacementImage, maskUv).rg - vec2(0.5);
      sampleUv = clamp(vertexUv + displacement * displacementScale /
        imageDimensions, vertexUvClamp.xy, vertexUvClamp.zw);
    }
    if (noiseGlitchEnabled && noiseGlitchParameters.z > 0.0) {
      float slice = floor(sampleUv.y * noiseGlitchParameters.z);
      float sliceNoise = pmjsRandom(vec2(slice, noiseGlitchParameters.y));
      if (sliceNoise < 0.3) {
        sampleUv.x += (sliceNoise - 0.15) * noiseGlitchParameters.w /
          imageDimensions.x;
      }
      sampleUv = clamp(sampleUv, vertexUvClamp.xy, vertexUvClamp.zw);
    }
    vec4 sampleColor;
    if (blurRadius <= 0.0) {
      sampleColor = sampleImage(sampleUv);
    } else if (any(notEqual(blurDirection, vec2(0.0)))) {
      vec2 stepUv = blurRadius * blurDirection / imageDimensions;
      if (pixiFilterParameters[2] == 5.0) {
        // Pixi 5's default five-tap kernel; parameter zero retains the MV kernel.
        sampleColor = sampleImage(sampleUv) * 0.250301;
        sampleColor += sampleImage(clamp(sampleUv + stepUv,
          vertexUvClamp.xy, vertexUvClamp.zw)) * 0.221461;
        sampleColor += sampleImage(clamp(sampleUv - stepUv,
          vertexUvClamp.xy, vertexUvClamp.zw)) * 0.221461;
        sampleColor += sampleImage(clamp(sampleUv + stepUv * 2.0,
          vertexUvClamp.xy, vertexUvClamp.zw)) * 0.153388;
        sampleColor += sampleImage(clamp(sampleUv - stepUv * 2.0,
          vertexUvClamp.xy, vertexUvClamp.zw)) * 0.153388;
      } else {
        sampleColor = sampleImage(sampleUv) * 0.227027;
        sampleColor += sampleImage(clamp(sampleUv + stepUv * 1.384615,
          vertexUvClamp.xy, vertexUvClamp.zw)) * 0.316216;
        sampleColor += sampleImage(clamp(sampleUv - stepUv * 1.384615,
          vertexUvClamp.xy, vertexUvClamp.zw)) * 0.316216;
        sampleColor += sampleImage(clamp(sampleUv + stepUv * 3.230769,
          vertexUvClamp.xy, vertexUvClamp.zw)) * 0.070270;
        sampleColor += sampleImage(clamp(sampleUv - stepUv * 3.230769,
          vertexUvClamp.xy, vertexUvClamp.zw)) * 0.070270;
      }
    } else {
      vec2 stepUv = blurRadius / imageDimensions;
      sampleColor = sampleImage(vertexUv) * 0.227027;
      sampleColor += sampleImage(clamp(vertexUv + vec2(stepUv.x, 0.0), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += sampleImage(clamp(vertexUv - vec2(stepUv.x, 0.0), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += sampleImage(clamp(vertexUv + vec2(0.0, stepUv.y), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += sampleImage(clamp(vertexUv - vec2(0.0, stepUv.y), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += sampleImage(clamp(vertexUv + stepUv, vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += sampleImage(clamp(vertexUv - stepUv, vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += sampleImage(clamp(vertexUv + vec2(stepUv.x, -stepUv.y), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += sampleImage(clamp(vertexUv + vec2(-stepUv.x, stepUv.y), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
    }
    if (noiseGlitchEnabled) {
      if (sampleColor.a > 0.0) sampleColor.rgb /= sampleColor.a;
      float channelOffset = noiseGlitchParameters.w * 0.5 / imageDimensions.x;
      vec4 redSample = sampleImage(clamp(sampleUv + vec2(channelOffset, 0.0),
        vertexUvClamp.xy, vertexUvClamp.zw));
      vec4 blueSample = sampleImage(clamp(sampleUv - vec2(channelOffset, 0.0),
        vertexUvClamp.xy, vertexUvClamp.zw));
      sampleColor.r = redSample.a > 0.0 ? redSample.r / redSample.a : 0.0;
      sampleColor.b = blueSample.a > 0.0 ? blueSample.b / blueSample.a : 0.0;
      float noise = (pmjsRandom(sampleUv * imageDimensions +
        vec2(noiseGlitchParameters.y)) - 0.5) * noiseGlitchParameters.x;
      sampleColor.rgb = clamp(sampleColor.rgb + noise, 0.0, 1.0);
      sampleColor.rgb *= sampleColor.a;
    }
    if (pixiFilterKind == 2) {
      vec2 center = vec2(pixiFilterParameters[0], pixiFilterParameters[1]) / imageDimensions;
      float halfWavelength = pixiFilterParameters[3] * 0.5 / imageDimensions.x;
      float currentRadius = pixiFilterParameters[5] * pixiFilterParameters[6] / imageDimensions.x;
      vec2 direction = vertexUv - center;
      direction.y *= imageDimensions.y / imageDimensions.x;
      float difference = halfWavelength > 0.0 ? (length(direction) - currentRadius) / halfWavelength : 2.0;
      float power = max(0.0, 1.0 - difference * difference);
      float fade = pixiFilterParameters[7] > 0.0 ?
        max(0.0, 1.0 - pow(currentRadius /
          (pixiFilterParameters[7] / imageDimensions.x), 2.0)) : 1.0;
      sampleColor.rgb *= 1.0 + (pixiFilterParameters[4] - 1.0) * power * fade;
    }
    if (spriteColorEnabled && sampleColor.a > 0.0) {
      vec3 straightColor = sampleColor.rgb / sampleColor.a;
      float gray = dot(straightColor, vec3(0.299, 0.587, 0.114));
      straightColor = mix(straightColor, vec3(gray), spriteColorTone.a);
      straightColor = clamp(straightColor + spriteColorTone.rgb, 0.0, 1.0);
      // MV's opaque lighter pass makes neutral-tone RGB premultiplied
      // before source-atop; destination-in restores the source alpha.
      bool neutralTone = all(equal(spriteColorTone, vec4(0.0)));
      if (neutralTone) {
        straightColor = sampleColor.rgb * sampleColor.a;
      }
      straightColor = mix(straightColor, spriteBlendColor.rgb,
                          spriteBlendColor.a);
      sampleColor.rgb = neutralTone ? straightColor : straightColor * sampleColor.a;
    }
    outputColor = sampleColor * vertexColor;
    if (colorMatrixEnabled) {
      vec4 c = outputColor;
      if (c.a > 0.0) c.rgb /= c.a;
      vec4 adjusted;
      adjusted.r = colorMatrix[0] * c.r + colorMatrix[1] * c.g + colorMatrix[2] * c.b + colorMatrix[3] * c.a + colorMatrix[4];
      adjusted.g = colorMatrix[5] * c.r + colorMatrix[6] * c.g + colorMatrix[7] * c.b + colorMatrix[8] * c.a + colorMatrix[9];
      adjusted.b = colorMatrix[10] * c.r + colorMatrix[11] * c.g + colorMatrix[12] * c.b + colorMatrix[13] * c.a + colorMatrix[14];
      adjusted.a = colorMatrix[15] * c.r + colorMatrix[16] * c.g + colorMatrix[17] * c.b + colorMatrix[18] * c.a + colorMatrix[19];
      vec3 rgb = mix(c.rgb, adjusted.rgb, colorMatrixAlpha) * adjusted.a;
      outputColor = vec4(rgb, adjusted.a);
    }
    if (maskEnabled) {
      vec2 screenPixel = vec2(gl_FragCoord.x, targetYDown ? gl_FragCoord.y : screenHeight - gl_FragCoord.y);
      vec2 maskLocal = vec2(
        maskTransform[0] * screenPixel.x + maskTransform[2] * screenPixel.y + maskTransform[4],
        maskTransform[1] * screenPixel.x + maskTransform[3] * screenPixel.y + maskTransform[5]);
      if (any(lessThan(maskLocal, vec2(0.0))) ||
          any(greaterThanEqual(maskLocal, maskLocalSize))) discard;
      vec2 maskPoint = maskLocal / maskLocalSize;
      if (maskRotation == 1) maskPoint = vec2(1.0 - maskPoint.y, maskPoint.x);
      else if (maskRotation == 2) maskPoint = vec2(1.0) - maskPoint;
      else if (maskRotation == 3) maskPoint = vec2(maskPoint.y, 1.0 - maskPoint.x);
      else if (maskRotation == 4) maskPoint = vec2(maskPoint.x, 1.0 - maskPoint.y);
      else if (maskRotation == 5) maskPoint = maskPoint.yx;
      else if (maskRotation == 6) maskPoint = vec2(1.0 - maskPoint.x, maskPoint.y);
      else if (maskRotation == 7) maskPoint = vec2(1.0) - maskPoint.yx;
      vec2 maskPixel = maskFrame.xy + maskPoint * maskFrame.zw;
      vec2 maskUv = maskPixel / maskTextureSize;
      vec4 maskSample = texture(maskImage, maskUv);
      float maskWeight = maskSample.a * maskAlpha *
        (maskUsesRed ? maskSample.r : 1.0);
      outputColor.a *= maskWeight;
      if (premultipliedInput) outputColor.rgb *= maskWeight;
    }
    if (!premultipliedInput) outputColor.rgb *= outputColor.a;
  }
)";

inline std::string pixiFragmentSourceWithPrecision(const char* base,
                                                  const std::string& precision) {
  if (precision != "highp" && precision != "mediump" && precision != "lowp") {
    throw std::runtime_error(
      "filter precision must be highp, mediump, or lowp");
  }
  static constexpr const char* marker = "precision mediump float;";
  std::string source(base);
  const std::string::size_type at = source.find(marker);
  if (at == std::string::npos) {
    throw std::runtime_error(
      "fragment source has no default precision declaration");
  }
  source.replace(at, std::char_traits<char>::length(marker),
                 std::string("precision ") + precision + " float;");
  return source;
}

inline std::string filterFragmentSourceWithPrecision(const std::string& precision) {
  return pixiFragmentSourceWithPrecision(fragmentSource, precision);
}
constexpr const char* tileVertexSource = R"(#version 300 es
  layout(location = 0) in vec2 localPosition;
  layout(location = 1) in vec2 sourcePixel;
  layout(location = 2) in vec2 animationFactor;
  uniform mat3 world;
  uniform bool targetYDown;
  uniform highp mat3 targetProjection;
  uniform vec2 screenSize;
  uniform vec2 animationOffset;
  uniform vec2 imageDimensions;
  out vec2 vertexUv;
  out highp vec2 meshLocalPosition;
  void main() {
    vec2 pixel = (world * vec3(localPosition, 1.0)).xy;
    gl_Position = vec4(pixel.x / screenSize.x * 2.0 - 1.0,
                       1.0 - pixel.y / screenSize.y * 2.0, 0.0, 1.0);
    if (targetYDown) gl_Position.y = -gl_Position.y;
    gl_Position.xy = (targetProjection * vec3(gl_Position.xy, 1.0)).xy;
    meshLocalPosition = localPosition;
    vertexUv = (sourcePixel + animationFactor * animationOffset) / imageDimensions;
  }
)";
constexpr const char* simpleFragmentSource = R"(#version 300 es
  precision mediump float;
  uniform sampler2D image;
  uniform bool pixiSpritePacking;
  uniform bool texturePremultiplied;
  uniform bool clampedTilingSampling;
  uniform highp vec2 imageDimensions;
  in vec2 vertexUv;
  in vec4 vertexColor;
  in vec4 vertexUvClamp;
  out vec4 outputColor;
  void main() {
    highp vec2 coord = vertexUv;
    if (clampedTilingSampling) {
      // Pixi 5's general tiling shader repeats the frame, then clamps to texel centers.
      highp vec2 margin = vec2(0.5) / imageDimensions;
      coord = clamp(coord + ceil(-coord), margin, vec2(1.0) - margin);
    }
    vec4 sampleColor = texture(image, coord);
    outputColor = sampleColor * vertexColor;
    outputColor.rgb *= pixiSpritePacking ? (texturePremultiplied ? 1.0 : sampleColor.a) : (texturePremultiplied ? vertexColor.a : outputColor.a);
  }
)";
constexpr const char* generatedTextureFragmentSource = R"(#version 300 es
  precision highp float;
  uniform highp sampler2D image;
  uniform bool preservePremultiplied;
  in vec2 vertexUv;
  out vec4 outputColor;
  void main() {
    vec4 color = texture(image, vertexUv);
    if (!preservePremultiplied && color.a > 0.0) color.rgb /= color.a;
    outputColor = color;
  }
)";
constexpr const char* presentationVertexSource = R"(#version 300 es
  out vec2 vertexUv;
  void main() {
    const vec2 positions[6] = vec2[6](
      vec2(-1.0,  1.0), vec2( 1.0,  1.0), vec2( 1.0, -1.0),
      vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2(-1.0, -1.0));
    const vec2 uvs[6] = vec2[6](
      vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(1.0, 0.0),
      vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(0.0, 0.0));
    gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
    vertexUv = uvs[gl_VertexID];
  }
)";
constexpr const char* presentationFragmentSource = R"(#version 300 es
  precision mediump float;
  uniform sampler2D sceneImage;
  uniform sampler2D overlayImage;
  uniform sampler2D videoImage;
  uniform sampler2D upperCanvasImage;
  uniform float colorMatrix[20];
  uniform float colorMatrixAlpha;
  uniform bool toneEnabled;
  uniform bool opaqueBackground;
  uniform float canvasOpacity;
  uniform float videoOpacity;
  uniform float upperCanvasOpacity;
  uniform bool videoPremultiplied;
  uniform bool upperCanvasPremultiplied;
  in vec2 vertexUv;
  out vec4 outputColor;
  void main() {
    vec4 scene = texture(sceneImage, vertexUv);
    if (toneEnabled) {
      vec4 straight = scene;
      if (straight.a > 0.0) straight.rgb /= straight.a;
      vec4 adjusted;
      adjusted.r = colorMatrix[0] * straight.r + colorMatrix[1] * straight.g + colorMatrix[2] * straight.b + colorMatrix[3] * straight.a + colorMatrix[4];
      adjusted.g = colorMatrix[5] * straight.r + colorMatrix[6] * straight.g + colorMatrix[7] * straight.b + colorMatrix[8] * straight.a + colorMatrix[9];
      adjusted.b = colorMatrix[10] * straight.r + colorMatrix[11] * straight.g + colorMatrix[12] * straight.b + colorMatrix[13] * straight.a + colorMatrix[14];
      adjusted.a = colorMatrix[15] * straight.r + colorMatrix[16] * straight.g + colorMatrix[17] * straight.b + colorMatrix[18] * straight.a + colorMatrix[19];
      // Pixi writes the tone pass to an RGBA target before drawing pictures.
      // Clamp that pass here so negative black-tone RGB cannot subtract from
      // a later translucent picture during the combined presentation pass.
      float tonedAlpha = clamp(adjusted.a, 0.0, 1.0);
      vec3 rgb = clamp(mix(straight.rgb, adjusted.rgb, colorMatrixAlpha) *
                       adjusted.a, 0.0, 1.0);
      vec4 toned = vec4(rgb, tonedAlpha);
      vec4 toneOverlay = texture(overlayImage, vertexUv);
      scene = toneOverlay + toned * (1.0 - toneOverlay.a);
    }
    vec4 composed = scene * canvasOpacity;
    vec4 video = texture(videoImage, vertexUv);
    video.a *= videoOpacity;
    video.rgb *= videoPremultiplied ? videoOpacity : video.a;
    composed = video + composed * (1.0 - video.a);
    vec4 upperCanvas = texture(upperCanvasImage, vertexUv);
    upperCanvas.a *= upperCanvasOpacity;
    upperCanvas.rgb *= upperCanvasPremultiplied ? upperCanvasOpacity : upperCanvas.a;
    composed = upperCanvas + composed * (1.0 - upperCanvas.a);
    outputColor = vec4(composed.rgb,
      opaqueBackground ? 1.0 : composed.a);
  }
)";
constexpr const char* spriteEffectFragmentSource = R"(#version 300 es
  precision mediump float;
  precision highp int;
  uniform sampler2D image;
  uniform bool pixiSpritePacking;
  uniform bool texturePremultiplied;
  uniform bool clampedTilingSampling;
  uniform bool nearestSampling;
  uniform bool standaloneBitmapRegion;
  uniform highp vec4 spriteFrame;
  uniform vec2 imageDimensions;
  uniform float blurRadius;
  uniform sampler2D maskImage;
  uniform bool maskEnabled;
  uniform float maskTransform[6];
  uniform vec2 maskTextureSize;
  uniform bool targetYDown;
  uniform float screenHeight;
  uniform bool spriteColorEnabled;
  uniform vec4 spriteColorTone;
  uniform vec4 spriteBlendColor;
  uniform bool colorMatrixEnabled;
  uniform float colorMatrix[20];
  uniform float colorMatrixAlpha;
  in highp vec2 vertexUv;
  in vec4 vertexColor;
  in vec4 vertexUvClamp;
  out vec4 outputColor;
  highp vec4 spriteTexel(highp vec2 pixel) {
    highp vec4 texel = texelFetch(image, ivec2(clamp(pixel, spriteFrame.xy, spriteFrame.zw)), 0);
    highp vec3 premultiplied = texturePremultiplied ? texel.rgb : texel.rgb * texel.a;
    ivec3 sourceBytes = ivec3(floor(premultiplied * 255.0 + 0.5));
    ivec3 blendBytes = ivec3(floor(spriteBlendColor.rgb * 255.0 + 0.5));
    int blendAlpha = min(255, int(floor(spriteBlendColor.a * 256.0)));
    int sourceAlpha = int(floor(texel.a * 255.0 + 0.5));
    ivec3 atop = (sourceBytes * (255 - blendAlpha) + blendBytes * blendAlpha + 127) / 255;
    return vec4(vec3((atop * (sourceAlpha + 1)) / 256) / 255.0, texel.a);
  }
  highp vec4 spriteBitmap() {
    highp vec2 position = standaloneBitmapRegion ?
      vertexUv * (spriteFrame.zw - spriteFrame.xy + vec2(1.0)) - vec2(0.5) :
      vertexUv * imageDimensions - vec2(0.5);
    highp vec2 pixel = floor(position), weight = fract(position);
    highp vec2 offset = standaloneBitmapRegion ? spriteFrame.xy : vec2(0.0);
    pixel += offset;
    highp vec4 sampled = nearestSampling ? spriteTexel(floor(position + vec2(0.5)) + offset) :
      mix(mix(spriteTexel(pixel), spriteTexel(pixel + vec2(1, 0)), weight.x),
          mix(spriteTexel(pixel + vec2(0, 1)), spriteTexel(pixel + vec2(1, 1)), weight.x), weight.y);
    return vec4(sampled.a > 0.0 ? sampled.rgb / sampled.a : vec3(0.0), sampled.a);
  }
  void main() {
    bool bitmapBlend = spriteColorEnabled && all(equal(spriteColorTone, vec4(0.0))) &&
      spriteBlendColor.a > 0.0 && blurRadius <= 0.0;
    vec4 sampleColor;
    if (bitmapBlend) {
      sampleColor = spriteBitmap();
    } else if (blurRadius <= 0.0) {
      highp vec2 coord = vertexUv;
      if (standaloneBitmapRegion) {
        highp vec2 position = vertexUv * (spriteFrame.zw - spriteFrame.xy + vec2(1.0));
        if (nearestSampling) {
          sampleColor = texelFetch(image, ivec2(clamp(floor(position) + spriteFrame.xy, spriteFrame.xy, spriteFrame.zw)), 0);
        } else {
          coord = (clamp(position, vec2(0.5), spriteFrame.zw - spriteFrame.xy + vec2(0.5)) + spriteFrame.xy) / imageDimensions;
          sampleColor = texture(image, coord);
        }
      } else {
      if (clampedTilingSampling) {
        highp vec2 margin = vec2(0.5) / imageDimensions;
        coord = clamp(coord + ceil(-coord), margin, vec2(1.0) - margin);
      }
      sampleColor = texture(image, coord);
      }
    } else {
      highp vec2 coord = standaloneBitmapRegion ?
        (vertexUv * (spriteFrame.zw - spriteFrame.xy + vec2(1.0)) + spriteFrame.xy) / imageDimensions : vertexUv;
      vec2 stepUv = blurRadius / imageDimensions;
      sampleColor = texture(image, coord) * 0.227027;
      sampleColor += texture(image, clamp(coord + vec2(stepUv.x, 0.0),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(coord - vec2(stepUv.x, 0.0),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(coord + vec2(0.0, stepUv.y),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(coord - vec2(0.0, stepUv.y),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(coord + stepUv,
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += texture(image, clamp(coord - stepUv,
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += texture(image, clamp(coord + vec2(stepUv.x, -stepUv.y),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += texture(image, clamp(coord + vec2(-stepUv.x, stepUv.y),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
    }
    if (!bitmapBlend && texturePremultiplied && sampleColor.a > 0.0) sampleColor.rgb /= sampleColor.a;
    if (!bitmapBlend && spriteColorEnabled && sampleColor.a > 0.0) {
      vec3 straightColor = sampleColor.rgb;
      float gray = dot(straightColor, vec3(0.299, 0.587, 0.114));
      straightColor = mix(straightColor, vec3(gray), spriteColorTone.a);
      straightColor = clamp(straightColor + spriteColorTone.rgb, 0.0, 1.0);
      // MV's opaque lighter pass makes neutral-tone RGB premultiplied
      // before source-atop; destination-in restores the source alpha.
      bool neutralTone = all(equal(spriteColorTone, vec4(0.0)));
      if (neutralTone) {
        straightColor = sampleColor.rgb * sampleColor.a;
      }
      straightColor = mix(straightColor, spriteBlendColor.rgb,
                          spriteBlendColor.a);
      sampleColor.rgb = straightColor;
    }
    outputColor = sampleColor * vertexColor;
    if (maskEnabled) {
      vec2 screenPixel = vec2(gl_FragCoord.x, targetYDown ? gl_FragCoord.y : screenHeight - gl_FragCoord.y);
      vec2 maskLocal = vec2(
        maskTransform[0] * screenPixel.x + maskTransform[2] * screenPixel.y +
          maskTransform[4],
        maskTransform[1] * screenPixel.x + maskTransform[3] * screenPixel.y +
          maskTransform[5]);
      if (any(lessThan(maskLocal, vec2(0.0))) ||
          any(greaterThanEqual(maskLocal, maskTextureSize))) discard;
      float maskWeight = texture(maskImage, maskLocal / maskTextureSize).a;
      outputColor.a *= maskWeight;
      if (pixiSpritePacking) outputColor.rgb *= maskWeight;
    }
    outputColor.rgb *= pixiSpritePacking ? sampleColor.a : outputColor.a;
    if (colorMatrixEnabled) {
      vec4 c = outputColor;
      if (c.a > 0.0) c.rgb /= c.a;
      vec4 adjusted;
      adjusted.r = colorMatrix[0] * c.r + colorMatrix[1] * c.g + colorMatrix[2] * c.b + colorMatrix[3] * c.a + colorMatrix[4];
      adjusted.g = colorMatrix[5] * c.r + colorMatrix[6] * c.g + colorMatrix[7] * c.b + colorMatrix[8] * c.a + colorMatrix[9];
      adjusted.b = colorMatrix[10] * c.r + colorMatrix[11] * c.g + colorMatrix[12] * c.b + colorMatrix[13] * c.a + colorMatrix[14];
      adjusted.a = colorMatrix[15] * c.r + colorMatrix[16] * c.g + colorMatrix[17] * c.b + colorMatrix[18] * c.a + colorMatrix[19];
      vec3 rgb = mix(c.rgb, adjusted.rgb, colorMatrixAlpha) * adjusted.a;
      outputColor = vec4(rgb, adjusted.a);
    }
  }
)";
constexpr const char* tileFragmentSource = R"(#version 300 es
  precision mediump float;
  precision highp int;
  uniform highp sampler2D image;
  uniform vec4 color;
  uniform bool texturePremultiplied;
#ifdef PMJS_MESH_POST_TINT_OVERLAY
  in highp vec2 vertexUv;
#else
  in vec2 vertexUv;
#endif
#ifdef PMJS_MESH_POST_TINT_OVERLAY
  uniform vec4 meshPostTintOverlayColor;
  uniform bool trianglePaintEnabled;
  uniform bool mvBlendEnabled;
  uniform bool mvPremultipliedInput;
  uniform bool nearestSampling;
  uniform highp vec4 mvBounds;
  // Paint parameters followed by retained normals, miters, inradius and bevels.
  uniform highp float trianglePaint[30];
  uniform bool triangleCoverageEnabled;
  uniform highp sampler2D triangleCoverage;
  uniform highp vec2 imageDimensions;
  in highp vec2 meshLocalPosition;

#ifndef PMJS_CANVAS_TRIANGLE_BITMAP
  highp float paintEdgeArea(highp vec2 a, highp vec2 b) {
    highp float dy = b.y - a.y;
    if (abs(dy) < 0.000001) return 0.0;
    highp float t0 = clamp((-0.5 - a.y) / dy, 0.0, 1.0);
    highp float t1 = clamp((0.5 - a.y) / dy, 0.0, 1.0);
    highp vec2 start = mix(a, b, min(t0, t1));
    highp vec2 end = mix(a, b, max(t0, t1));
    highp float low = min(start.x, end.x), high = max(start.x, end.x);
    highp float span = high - low;
    highp float mean;
    if (span < 0.000001) mean = clamp((low + high) * 0.5, -0.5, 0.5);
    else {
      highp float left = clamp(low, -0.5, 0.5), right = clamp(high, -0.5, 0.5);
      highp float middle = (right - left) / span;
      highp float above = clamp((high - 0.5) / span, 0.0, 1.0);
      mean = -0.5 + above + middle * (0.5 + (left + right) * 0.5);
    }
    return mean * (end.y - start.y);
  }


  highp float trianglePixelArea(highp vec2 pixel, highp vec2 points[3], highp vec2 inward[3], highp float inset, bool bevel) {
    highp vec2 first = vec2(0.0), previous = vec2(0.0);
    highp float area = 0.0;
    if (inset > 0.0 && inset >= trianglePaint[28]) return 0.0;
    for (int corner = 0; corner < 3; ++corner) {
      highp vec2 before = inward[(corner + 2) % 3], after = inward[corner];
      highp vec2 offset = vec2(trianglePaint[22 + corner * 2], trianglePaint[23 + corner * 2]) * inset;
      highp vec2 entry = points[corner] + offset - pixel, exit = entry;
      if (bevel && (int(trianglePaint[29]) & (1 << corner)) != 0) {
        entry = points[corner] + before * inset - pixel;
        exit = points[corner] + after * inset - pixel;
      }
      if (corner == 0) first = entry;
      else area += paintEdgeArea(previous, entry);
      area += paintEdgeArea(entry, exit);
      previous = exit;
    }
    area += paintEdgeArea(previous, first);
    return clamp(abs(area), 0.0, 1.0);
  }

#endif
  ivec4 canvasImageTexel(ivec2 pixel) {
    ivec2 dimensions = textureSize(image, 0);
    highp vec4 sampleColor = texelFetch(image, clamp(pixel, ivec2(0), dimensions - 1), 0);
    if (!texturePremultiplied) sampleColor.rgb *= sampleColor.a;
    return ivec4(floor(sampleColor * 255.0 + 0.5));
  }
  // Skia low-quality bitmap filtering uses four-bit weights. Normalized
  // Float32 mesh UVs need a small allowance at otherwise integral texels.
  ivec4 canvasImageSample(highp vec2 uv) {
    highp vec2 position = uv * imageDimensions - vec2(0.5);
    ivec2 pixel = ivec2(floor(position + vec2(0.0001)));
    ivec2 weight = ivec2(clamp(floor((position - vec2(pixel)) * 16.0 + vec2(0.001)), vec2(0), vec2(15)));
    return (canvasImageTexel(pixel) * (16 - weight.x) * (16 - weight.y)
      + canvasImageTexel(pixel + ivec2(1, 0)) * weight.x * (16 - weight.y)
      + canvasImageTexel(pixel + ivec2(0, 1)) * (16 - weight.x) * weight.y
      + canvasImageTexel(pixel + ivec2(1, 1)) * weight.x * weight.y) / 256;
  }
  highp vec4 paintTriangle() {
    highp vec2 points[3];
    for (int i = 0; i < 3; ++i) points[i] = vec2(trianglePaint[i * 2], trianglePaint[i * 2 + 1]);
    highp vec2 inward[3];
    for (int i = 0; i < 3; ++i) inward[i] = vec2(trianglePaint[16 + i * 2], trianglePaint[17 + i * 2]);
    highp vec2 origin = vec2(trianglePaint[6], trianglePaint[7]);
    highp vec2 pixel = floor(meshLocalPosition - origin) + origin + vec2(0.5);
    highp vec2 localDx = dFdx(meshLocalPosition), localDy = dFdy(meshLocalPosition);
    highp vec2 delta = pixel - meshLocalPosition;
    highp float determinant = localDx.x * localDy.y - localDy.x * localDx.y;
    highp vec2 screenDelta = vec2(delta.x * localDy.y - delta.y * localDy.x,
      localDx.x * delta.y - localDx.y * delta.x) / determinant;
    highp vec2 uv = vertexUv + dFdx(vertexUv) * screenDelta.x + dFdy(vertexUv) * screenDelta.y;
    if (triangleCoverageEnabled) {
      ivec2 coveragePixel = ivec2(floor(pixel - origin));
      ivec2 dimensions = textureSize(triangleCoverage, 0);
      if (any(lessThan(coveragePixel, ivec2(0))) || any(greaterThanEqual(coveragePixel, dimensions)))
        return vec4(0.0);
      ivec4 coverageBytes = ivec4(floor(texelFetch(triangleCoverage, coveragePixel, 0) * 255.0 + 0.5));
      ivec4 sourceBytes = canvasImageSample(uv);
      ivec4 fillBytes = (sourceBytes * (coverageBytes.r + 1)) / 256;
      ivec3 strokeColor = ivec3(floor(vec3(trianglePaint[10], trianglePaint[11], trianglePaint[12]) * 255.0 + 0.5));
      int alpha = int(floor(trianglePaint[13] * 255.0));
      ivec4 color = ivec4((strokeColor * (alpha + 1)) / 256, alpha);
      int scale = coverageBytes.g + 1;
      ivec4 strokeBytes = (color * scale) / 256;
      int inverseAlpha = 255 - strokeBytes.a;
      inverseAlpha += inverseAlpha / 128;
      ivec4 result = strokeBytes.a == 0 ? fillBytes :
        strokeBytes + (fillBytes * inverseAlpha + 128) / 256;
      if (coverageBytes.b == 1) {
        if (alpha == 255) {
          scale = coverageBytes.g + coverageBytes.g / 128;
          result = (color * scale + fillBytes * (256 - scale)) / 256;
        } else {
          int product = 65535 - alpha * scale;
          int destinationScale = (product + product / 256) / 256;
          result = (color * scale + fillBytes * destinationScale) / 256;
        }
      } else if (coverageBytes.b == 2) {
        result = strokeBytes + (fillBytes * (256 - strokeBytes.a)) / 256;
      }
      return vec4(result.a > 0 ? vec3(result.rgb) / float(result.a) : vec3(0.0), float(result.a) / 255.0);
    }
    highp float halfWidth = trianglePaint[14] * 0.5;
    highp float minimumDistance = 1e20;
    for (int edge = 0; edge < 3; ++edge) {
      minimumDistance = min(minimumDistance, dot(pixel - points[edge], inward[edge]));
    }
    highp vec2 coverage = vec2(0.0);
    if (minimumDistance > halfWidth + 0.75) coverage.x = 1.0;
    else if (minimumDistance >= -halfWidth - 0.75) {
#ifndef PMJS_CANVAS_TRIANGLE_BITMAP
      if ((int(trianglePaint[29]) & 16) != 0)
#endif
      {
        coverage.x = triangleClipCoverage(pixel, points, inward);
        // Clipped image crops leave the surrounding bitmap padding transparent.
        highp vec2 low = min(points[0], min(points[1], points[2]));
        highp vec2 high = max(points[0], max(points[1], points[2]));
        highp vec2 rectangle = clamp(pixel - low + vec2(0.5), 0.0, 1.0)
          * clamp(high - pixel + vec2(0.5), 0.0, 1.0);
        coverage.x *= rectangle.x * rectangle.y;
      }
#ifndef PMJS_CANVAS_TRIANGLE_BITMAP
      else { coverage.x = trianglePixelArea(pixel, points, inward, 0.0, false); }
#endif
      if (halfWidth > 0.0) {
#ifndef PMJS_CANVAS_TRIANGLE_BITMAP
        if ((int(trianglePaint[29]) & 8) != 0)
#endif
        {
          // The pinned reference matches this grid in the tested MPP stroke cases.
          highp vec2 samples[4] = vec2[4](vec2(-0.125, -0.375), vec2(0.375, -0.125),
            vec2(-0.375, 0.125), vec2(0.125, 0.375));
          for (int sampleIndex = 0; sampleIndex < 4; ++sampleIndex) {
            highp vec2 position = pixel + samples[sampleIndex];
            bool outer = true, inner = halfWidth < trianglePaint[28];
            for (int edge = 0; edge < 3; ++edge) {
              highp float distance = dot(position - points[edge], inward[edge]);
              outer = outer && distance >= -halfWidth;
              inner = inner && distance >= halfWidth;
              if ((int(trianglePaint[29]) & (1 << edge)) != 0) {
                highp vec2 before = inward[(edge + 2) % 3], after = inward[edge];
                outer = outer && dot(position - points[edge], before + after) >=
                  -halfWidth * (1.0 + dot(before, after));
              }
            }
            if (outer && !inner) coverage.y += 0.25;
          }
        }
#ifndef PMJS_CANVAS_TRIANGLE_BITMAP
        else { coverage.y = max(0.0, trianglePixelArea(pixel, points, inward, -halfWidth, true)
            - trianglePixelArea(pixel, points, inward, halfWidth, false)); }
#endif
      }
    }
    if (coverage.x <= 0.0 && coverage.y <= 0.0) return vec4(0.0);
    highp vec4 source = texture(image, uv);
    if (texturePremultiplied) source.rgb = source.a > 0.0 ? source.rgb / source.a : vec3(0.0);
    highp float fillAlpha = source.a * coverage.x;
    highp float strokeAlpha = trianglePaint[13] * coverage.y;
    highp float alpha = strokeAlpha + fillAlpha * (1.0 - strokeAlpha);
    highp vec3 premultiplied = vec3(trianglePaint[10], trianglePaint[11], trianglePaint[12]) * strokeAlpha
      + source.rgb * fillAlpha * (1.0 - strokeAlpha);
    highp vec3 rgb = alpha > 0.0 ? premultiplied / alpha : vec3(0.0);
    return vec4(rgb, alpha);
  }

#ifndef PMJS_CANVAS_TRIANGLE_BITMAP
  highp vec4 mvTexel(highp vec2 pixel) {
    highp vec4 texel = texelFetch(image, ivec2(clamp(pixel, mvBounds.xy, mvBounds.zw)), 0);
    highp vec3 premultiplied = mvPremultipliedInput ? texel.rgb : texel.rgb * texel.a;
    if (meshPostTintOverlayColor.a > 0.0) {
      // MV stores the source-atop bitmap before its destination-in pass.
      // Preserve those RGBA8 writes instead of fusing their real-number algebra.
      ivec3 sourceBytes = ivec3(floor(premultiplied * 255.0 + 0.5));
      ivec3 blendBytes = ivec3(floor(meshPostTintOverlayColor.rgb * 255.0 + 0.5));
      int blendAlpha = min(255, int(floor(meshPostTintOverlayColor.a * 256.0)));
      int sourceAlpha = int(floor(texel.a * 255.0 + 0.5));
      ivec3 atop = (sourceBytes * (255 - blendAlpha) + blendBytes * blendAlpha + 127) / 255;
      premultiplied = vec3((atop * (sourceAlpha + 1)) / 256) / 255.0;
    }
    return vec4(premultiplied, texel.a);
  }

  highp vec4 sampleMvBitmap() {
    if (mvPremultipliedInput && meshPostTintOverlayColor.a <= 0.0) {
      highp vec4 sampled = texture(image, clamp(vertexUv,
        (mvBounds.xy + vec2(0.5)) / imageDimensions, (mvBounds.zw + vec2(0.5)) / imageDimensions));
      return vec4(sampled.a > 0.0 ? sampled.rgb / sampled.a : vec3(0.0), sampled.a);
    }
    highp vec2 position = vertexUv * imageDimensions - vec2(0.5);
    highp vec2 pixel = floor(position), weight = fract(position);
    highp vec4 sampled;
    if (nearestSampling) sampled = mvTexel(floor(position + vec2(0.5)));
    else sampled = mix(mix(mvTexel(pixel), mvTexel(pixel + vec2(1, 0)), weight.x),
      mix(mvTexel(pixel + vec2(0, 1)), mvTexel(pixel + vec2(1, 1)), weight.x), weight.y);
    return vec4(sampled.a > 0.0 ? sampled.rgb / sampled.a : vec3(0.0), sampled.a);
  }
#endif
#endif
  uniform sampler2D maskImage;
  uniform bool maskEnabled;
  uniform float maskTransform[6];
  uniform vec4 maskFrame;
  uniform vec2 maskTextureSize;
  uniform bool targetYDown;
  uniform float screenHeight;

  out vec4 outputColor;
  void main() {
    vec4 sampled;
    bool sampledPremultiplied = texturePremultiplied;
#ifdef PMJS_CANVAS_TRIANGLE_BITMAP
    sampled = paintTriangle();
    sampledPremultiplied = false;
#elif defined(PMJS_MESH_POST_TINT_OVERLAY)
    if (trianglePaintEnabled) { sampled = paintTriangle(); sampledPremultiplied = false; }
    else if (mvBlendEnabled) { sampled = sampleMvBitmap(); sampledPremultiplied = false; }
    else sampled = texture(image, vertexUv);
#else
    sampled = texture(image, vertexUv);
#endif
    sampled.rgb *= color.rgb;
#ifdef PMJS_MESH_POST_TINT_OVERLAY
    if (!mvBlendEnabled && meshPostTintOverlayColor.a > 0.0) {
      if (sampledPremultiplied) sampled.rgb = sampled.a > 0.0 ? sampled.rgb / sampled.a : vec3(0.0);
      sampledPremultiplied = false;
      sampled.rgb = mix(sampled.rgb, meshPostTintOverlayColor.rgb, meshPostTintOverlayColor.a);
    }
#endif
    float sourceAlpha = sampled.a;
    sampled.a *= color.a;
    outputColor = sampled;
    if (maskEnabled) {
      vec2 screenPixel = vec2(gl_FragCoord.x, targetYDown ? gl_FragCoord.y : screenHeight - gl_FragCoord.y);
      vec2 maskPixel = vec2(
        maskTransform[0] * screenPixel.x + maskTransform[2] * screenPixel.y + maskTransform[4],
        maskTransform[1] * screenPixel.x + maskTransform[3] * screenPixel.y + maskTransform[5]);
      if (any(lessThan(maskPixel, maskFrame.xy)) ||
          any(greaterThanEqual(maskPixel, maskFrame.xy + maskFrame.zw))) discard;
      vec2 maskUv = maskPixel / maskTextureSize;
      outputColor.a *= texture(maskImage, maskUv).a;
    }
    outputColor.rgb *= sampledPremultiplied ? (sourceAlpha > 0.0 ? outputColor.a / sourceAlpha : 0.0) : outputColor.a;
  }
)";

inline std::string meshPostTintOverlayFragmentSourceWithPrecision(const std::string& precision, bool canvasTriangleBitmap = false) {
  auto source = withTriangleClipCoverage(pixiFragmentSourceWithPrecision(tileFragmentSource, precision));
  const auto version = source.find("#version 300 es");
  source.insert(source.find('\n', version) + 1, "#define PMJS_MESH_POST_TINT_OVERLAY\n");
  if (canvasTriangleBitmap) source.insert(source.find('\n', version) + 1, "#define PMJS_CANVAS_TRIANGLE_BITMAP\n");
  return source;
}

inline std::string bitmapRegionVertexSource() {
  std::string source(vertexSource);
  source.insert(source.find("  void main()"), "  flat out highp vec4 spriteFrame;\n");
  source.insert(source.find("    vertexUvClamp = uvClamp;"), "    spriteFrame = uvClamp;\n");
  return source;
}
inline std::string bitmapRegionFragmentSource() {
  std::string source(spriteEffectFragmentSource);
  source.replace(source.find("uniform highp vec4 spriteFrame;"),
    std::string("uniform highp vec4 spriteFrame;").size(), "flat in highp vec4 spriteFrame;");
  return source;
}
}  // namespace pmjs::renderer_shaders
