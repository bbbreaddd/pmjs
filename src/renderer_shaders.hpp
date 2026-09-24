#pragma once

namespace pmjs::renderer_shaders {
constexpr const char* primitiveSurfaceFragmentSource = R"(
  #version 300 es
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
constexpr const char* vertexSource = R"(
  #version 300 es
  layout(location = 0) in vec2 position;
  layout(location = 1) in vec2 uv;
  layout(location = 2) in vec4 color;
  layout(location = 3) in vec4 uvClamp;
  out vec2 vertexUv;
  out vec4 vertexColor;
  out vec4 vertexUvClamp;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
    vertexUv = uv;
    vertexColor = color;
    vertexUvClamp = uvClamp;
  }
)";
constexpr const char* fragmentSource = R"(
  #version 300 es
  precision mediump float;
  uniform sampler2D image;
  uniform vec2 textureSize;
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
  in vec4 vertexColor;
  in vec4 vertexUvClamp;
  out vec4 outputColor;
  highp float pmjsRandom(highp vec2 coordinate) {
    coordinate = mod(coordinate, vec2(4096.0));
    return fract(sin(dot(coordinate, vec2(12.9898, 78.233))) * 43758.5453);
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
  void main() {
    vec2 sampleUv = vertexUv;
    if (pixiFilterKind == 1) {
      vec2 center = vec2(pixiFilterParameters[0], pixiFilterParameters[1]) / textureSize;
      vec2 direction = center - sampleUv;
      float distanceToCenter = length(vec2(direction.x, direction.y * textureSize.y / textureSize.x));
      float innerGradient = pixiFilterParameters[3] * 0.3;
      float innerRadius = (pixiFilterParameters[3] + innerGradient * 0.5) / textureSize.x;
      float outerGradient = pixiFilterParameters[4] * 0.3;
      float outerRadius = pixiFilterParameters[4] < 0.0 ? -1.0 :
        (pixiFilterParameters[4] - outerGradient * 0.5) / textureSize.x;
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
        float normalizedGradient = gradientPixels / textureSize.x;
        float edge = normalizedGradient > 0.0 ?
          (normalizedGradient - delta) / normalizedGradient : 0.0;
        sampleLimit *= edge;
        strength *= edge;
        if (sampleLimit < 1.0) {
          outputColor = texture(image, sampleUv) * vertexColor;
          return;
        }
      }
      direction *= strength;
      vec4 accumulated = vec4(0.0);
      float totalWeight = 0.0;
      float randomOffset = pmjsRandom(sampleUv * textureSize);
      for (int sampleIndex = 0; sampleIndex < 32; ++sampleIndex) {
        if (float(sampleIndex) > sampleLimit) break;
        float percent = (float(sampleIndex) + randomOffset) / 32.0;
        float weight = 4.0 * (percent - percent * percent);
        accumulated += texture(image, clamp(sampleUv + direction * percent, vertexUvClamp.xy, vertexUvClamp.zw)) * weight;
        totalWeight += weight;
      }
      outputColor = accumulated / max(totalWeight, 0.00001) * vertexColor;
      return;
    }
    if (pixiFilterKind == 2) {
      vec2 center = vec2(pixiFilterParameters[0], pixiFilterParameters[1]) / textureSize;
      float halfWavelength = pixiFilterParameters[3] * 0.5 / textureSize.x;
      float currentRadius = pixiFilterParameters[5] * pixiFilterParameters[6] / textureSize.x;
      vec2 direction = sampleUv - center;
      direction.y *= textureSize.y / textureSize.x;
      float distanceToCenter = length(direction);
      float fade = pixiFilterParameters[7] > 0.0 ? max(0.0, 1.0 - pow(currentRadius / (pixiFilterParameters[7] / textureSize.x), 2.0)) : 1.0;
      if (halfWavelength > 0.0 && distanceToCenter > 0.0 && fade > 0.0 && abs(distanceToCenter - currentRadius) <= halfWavelength) {
        float difference = (distanceToCenter - currentRadius) / halfWavelength;
        float power = 1.0 - difference * difference;
        float offset = 1.25 * sin(difference * 3.14159) * power * pixiFilterParameters[2] * fade;
        sampleUv = clamp(sampleUv + normalize(direction) * offset / textureSize, vertexUvClamp.xy, vertexUvClamp.zw);
      }
    }
    if (pixiFilterKind == 3) {
      vec4 extracted = texture(image, sampleUv);
      float maximum = max(max(extracted.r, extracted.g), extracted.b);
      float minimum = min(min(extracted.r, extracted.g), extracted.b);
      outputColor = (maximum + minimum) * 0.5 > pixiFilterParameters[0] ?
        extracted * vertexColor : vec4(0.0);
      return;
    }
    if (pixiFilterKind == 22) {
      vec4 base = texture(image, sampleUv) * pixiFilterParameters[0];
      vec4 bloom = texture(bloomImage, sampleUv) * pixiFilterParameters[1];
      outputColor = (base + bloom) * vertexColor;
      return;
    }
    if (pixiFilterKind == 23 || pixiFilterKind == 24) {
      vec4 source = texture(image, sampleUv) * vertexColor;
      vec4 target = texture(bloomImage, sampleUv);
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
    if (pixiFilterKind == 25) {
      vec2 inverseSize = 1.0 / textureSize;
      vec3 rgbNW = texture(image, clamp(sampleUv + vec2(-1.0, -1.0) * inverseSize,
        vertexUvClamp.xy, vertexUvClamp.zw)).rgb;
      vec3 rgbNE = texture(image, clamp(sampleUv + vec2(1.0, -1.0) * inverseSize,
        vertexUvClamp.xy, vertexUvClamp.zw)).rgb;
      vec3 rgbSW = texture(image, clamp(sampleUv + vec2(-1.0, 1.0) * inverseSize,
        vertexUvClamp.xy, vertexUvClamp.zw)).rgb;
      vec3 rgbSE = texture(image, clamp(sampleUv + vec2(1.0, 1.0) * inverseSize,
        vertexUvClamp.xy, vertexUvClamp.zw)).rgb;
      vec4 centerColor = texture(image, sampleUv);
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
        texture(image, clamp(sampleUv + direction * (1.0 / 3.0 - 0.5),
          vertexUvClamp.xy, vertexUvClamp.zw)).rgb +
        texture(image, clamp(sampleUv + direction * (2.0 / 3.0 - 0.5),
          vertexUvClamp.xy, vertexUvClamp.zw)).rgb);
      vec3 rgbB = rgbA * 0.5 + 0.25 * (
        texture(image, clamp(sampleUv - direction * 0.5,
          vertexUvClamp.xy, vertexUvClamp.zw)).rgb +
        texture(image, clamp(sampleUv + direction * 0.5,
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
      vec4 crtColor = texture(image, sampleUv);
      vec3 crtRgb = crtColor.rgb;
      if (pixiFilterParameters[4] > 0.0 && pixiFilterParameters[5] > 0.0) {
        vec2 noisePixel = floor(coordinate * textureSize / pixiFilterParameters[5]);
        float grain = pmjsRandom(noisePixel * pixiFilterParameters[5] +
          vec2(pixiFilterParameters[9])) - 0.5;
        crtRgb += grain * pixiFilterParameters[4] * crtColor.a;
      }
      if (pixiFilterParameters[1] > 0.0) {
        float axis = pixiFilterParameters[3] > 0.5 ? curved.x * textureSize.x : curved.y * textureSize.y;
        float line = 1.0 + cos(axis * 1.2 - pixiFilterParameters[9]) * 0.5 * pixiFilterParameters[2];
        crtRgb *= line;
        float segment = pixiFilterParameters[3] > 0.5 ?
          mod((direction.x + 0.5) * textureSize.x, 4.0) :
          mod((direction.y + 0.5) * textureSize.y, 4.0);
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
      vec4 adjusted = texture(image, sampleUv);
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
      sampleUv = floor(sampleUv * textureSize / pixelSize) *
        pixelSize / textureSize;
    }
    if (pixiFilterKind == 7) {
      vec4 centerSample = texture(image, sampleUv);
      vec4 redSample = texture(image, clamp(sampleUv +
        vec2(pixiFilterParameters[0], pixiFilterParameters[1]) / textureSize,
        vertexUvClamp.xy, vertexUvClamp.zw));
      vec4 greenSample = texture(image, clamp(sampleUv +
        vec2(pixiFilterParameters[2], pixiFilterParameters[3]) / textureSize,
        vertexUvClamp.xy, vertexUvClamp.zw));
      vec4 blueSample = texture(image, clamp(sampleUv +
        vec2(pixiFilterParameters[4], pixiFilterParameters[5]) / textureSize,
        vertexUvClamp.xy, vertexUvClamp.zw));
      outputColor = vec4(redSample.r, greenSample.g, blueSample.b,
        centerSample.a) * vertexColor;
      return;
    }
    if (pixiFilterKind == 8 && pixiFilterParameters[2] > 0.0) {
      vec2 pixelCoordinate = sampleUv * textureSize;
      vec2 center = vec2(pixiFilterParameters[0], pixiFilterParameters[1]) *
        textureSize;
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
      sampleUv = clamp((pixelCoordinate + center) / textureSize,
        vertexUvClamp.xy, vertexUvClamp.zw);
    }
    if (pixiFilterKind == 9 && pixiFilterParameters[2] > 0.0) {
      vec2 coordinate = sampleUv * textureSize -
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
        vec2(pixiFilterParameters[0], pixiFilterParameters[1])) / textureSize,
        vertexUvClamp.xy, vertexUvClamp.zw);
    }
    if (pixiFilterKind == 10) {
      float characterSize = max(1.0, pixiFilterParameters[0]);
      vec2 pixelCoordinate = floor(sampleUv * textureSize / characterSize) *
        characterSize;
      vec4 asciiColor = texture(image, pixelCoordinate / textureSize);
      float gray = (asciiColor.r + asciiColor.g + asciiColor.b) / 3.0;
      float glyph = gray > 0.8 ? 11512810.0 : gray > 0.7 ? 13199452.0 :
        gray > 0.6 ? 15252014.0 : gray > 0.5 ? 23385164.0 :
        gray > 0.4 ? 15255086.0 : gray > 0.3 ? 332772.0 :
        gray > 0.2 ? 65600.0 : 65536.0;
      vec2 glyphPixel = floor((mod(sampleUv * textureSize, characterSize) /
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
      vec2 pixelCoordinate = sampleUv * textureSize;
      vec2 point = vec2(cosine * pixelCoordinate.x - sine * pixelCoordinate.y,
        sine * pixelCoordinate.x + cosine * pixelCoordinate.y) *
        pixiFilterParameters[1];
      vec4 dotColor = texture(image, sampleUv);
      float average = (dotColor.r + dotColor.g + dotColor.b) / 3.0;
      float pattern = sin(point.x) * sin(point.y) * 4.0;
      outputColor = vec4(vec3(average * 10.0 - 5.0 + pattern), dotColor.a) *
        vertexColor;
      return;
    }
    if (pixiFilterKind == 12) {
      vec2 onePixel = 1.0 / textureSize;
      vec4 embossed = vec4(vec3(0.5), 1.0) -
        texture(image, clamp(sampleUv - onePixel,
          vertexUvClamp.xy, vertexUvClamp.zw)) * pixiFilterParameters[0] +
        texture(image, clamp(sampleUv + onePixel,
          vertexUvClamp.xy, vertexUvClamp.zw)) * pixiFilterParameters[0];
      float average = (embossed.r + embossed.g + embossed.b) / 3.0;
      float alpha = texture(image, sampleUv).a;
      outputColor = vec4(vec3(average) * alpha, alpha) * vertexColor;
      return;
    }
    if (pixiFilterKind == 13) {
      float luminance = length(texture(image, sampleUv).rgb);
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
        outputColor = texture(image, sampleUv) * vertexColor;
        return;
      }
      float aspect = textureSize.y / textureSize.x;
      vec2 center = vec2(pixiFilterParameters[1], pixiFilterParameters[2]) /
        textureSize;
      float gradient = pixiFilterParameters[4] / textureSize.x * 0.3;
      float radius = pixiFilterParameters[4] < 0.0 ? -1.0 :
        pixiFilterParameters[4] / textureSize.x - gradient * 0.5;
      vec2 direction = center - sampleUv;
      float distanceToCenter = length(vec2(direction.x, direction.y * aspect));
      float radianStep = pixiFilterParameters[0] * 3.14159265 / 180.0;
      if (radius >= 0.0 && distanceToCenter > radius) {
        float scale = gradient > 0.0 ?
          1.0 - abs((distanceToCenter - radius) / gradient) : 0.0;
        if (scale <= 0.0) {
          outputColor = texture(image, sampleUv) * vertexColor;
          return;
        }
        radianStep *= scale;
      }
      radianStep /= float(kernelSize - 1);
      float sine = sin(radianStep);
      float cosine = cos(radianStep);
      mat2 rotation = mat2(vec2(cosine, -sine), vec2(sine, cosine));
      vec2 radialUv = sampleUv;
      vec4 radialColor = texture(image, radialUv);
      for (int radialIndex = 0; radialIndex < 63; ++radialIndex) {
        if (radialIndex == kernelSize - 1) break;
        radialUv -= center;
        radialUv.y *= aspect;
        radialUv = rotation * radialUv;
        radialUv.y /= aspect;
        radialUv += center;
        radialColor += texture(image, clamp(radialUv,
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
          pixiFilterParameters[3], depth) / textureSize.x;
        float wavelength = mix(pixiFilterParameters[4],
          pixiFilterParameters[5], depth) / textureSize.y;
        float reflectedX = sampleUv.x;
        if (abs(wavelength) > 0.000001) {
          reflectedX += cos(reflectedY * 6.2831853 / wavelength -
            pixiFilterParameters[8]) * amplitude;
        }
        vec4 reflected = texture(image, clamp(vec2(reflectedX, reflectedY),
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
        outputColor = texture(image, sampleUv) * vertexColor;
        return;
      }
      vec2 velocity = pixelVelocity / textureSize;
      float offset = -pixiFilterParameters[3] / velocityLength - 0.5;
      vec4 motionColor = texture(image, sampleUv);
      for (int motionIndex = 0; motionIndex < 63; ++motionIndex) {
        if (motionIndex == kernelSize - 1) break;
        float amount = float(motionIndex) / float(kernelSize - 1) + offset;
        motionColor += texture(image, clamp(sampleUv + velocity * amount,
          vertexUvClamp.xy, vertexUvClamp.zw));
      }
      outputColor = motionColor / float(kernelSize) * vertexColor;
      return;
    }
    if (pixiFilterKind == 17) {
      outputColor = texture(image, sampleUv) * pixiFilterParameters[0] *
        vertexColor;
      return;
    }
    if (pixiFilterKind == 18) {
      vec4 filmSample = texture(image, sampleUv);
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
        direction.y *= textureSize.y / textureSize.x;
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
          float scratchHeight = pixiFilterParameters[5] / textureSize.x *
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
        vec2 noisePixel = floor(sampleUv * textureSize /
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
      vec4 ownGlowColor = texture(image, sampleUv);
      float totalAlpha = 0.0;
      float maximumAlpha = 0.0;
      for (int angleIndex = 0; angleIndex < 64; ++angleIndex) {
        float angle = float(angleIndex) * angularStep;
        if (angle > 6.28318531) break;
        vec2 direction = vec2(cos(angle), sin(angle));
        for (int distanceIndex = 1; distanceIndex <= 32; ++distanceIndex) {
          float currentDistance = float(distanceIndex);
          if (currentDistance > glowDistance) break;
          vec4 neighbor = texture(image, clamp(sampleUv + direction *
            currentDistance / textureSize,
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
      float aspect = textureSize.y / textureSize.x;
      float directionValue;
      if (pixiFilterParameters[0] > 0.5) {
        directionValue = pixiFilterParameters[1] * sampleUv.x +
          pixiFilterParameters[2] * sampleUv.y * aspect;
      } else {
        float deltaX = sampleUv.x - pixiFilterParameters[1] / textureSize.x;
        float deltaY = (sampleUv.y - pixiFilterParameters[2] /
          textureSize.y) * aspect;
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
      outputColor = (texture(image, sampleUv) + mist *
        pixiFilterParameters[6]) * vertexColor;
      return;
    }
    if (pixiFilterKind == 21) {
      vec2 offset = (pixiFilterParameters[0] + 0.5) *
        vec2(pixiFilterParameters[1], pixiFilterParameters[2]) / textureSize;
      vec4 kawaseColor = texture(image, clamp(sampleUv +
        vec2(-offset.x, offset.y), vertexUvClamp.xy, vertexUvClamp.zw));
      kawaseColor += texture(image, clamp(sampleUv + offset,
        vertexUvClamp.xy, vertexUvClamp.zw));
      kawaseColor += texture(image, clamp(sampleUv +
        vec2(offset.x, -offset.y), vertexUvClamp.xy, vertexUvClamp.zw));
      kawaseColor += texture(image, clamp(sampleUv - offset,
        vertexUvClamp.xy, vertexUvClamp.zw));
      outputColor = kawaseColor * 0.25 * vertexColor;
      return;
    }
    if (displacementEnabled) {
      vec2 maskUv = (vertexUv * textureSize - displacementBounds.xy) /
        displacementBounds.zw;
      vec2 displacement = texture(displacementImage, maskUv).rg - vec2(0.5);
      sampleUv = clamp(vertexUv + displacement * displacementScale /
        textureSize, vertexUvClamp.xy, vertexUvClamp.zw);
    }
    if (noiseGlitchEnabled && noiseGlitchParameters.z > 0.0) {
      float slice = floor(sampleUv.y * noiseGlitchParameters.z);
      float sliceNoise = pmjsRandom(vec2(slice, noiseGlitchParameters.y));
      if (sliceNoise < 0.3) {
        sampleUv.x += (sliceNoise - 0.15) * noiseGlitchParameters.w /
          textureSize.x;
      }
      sampleUv = clamp(sampleUv, vertexUvClamp.xy, vertexUvClamp.zw);
    }
    vec4 sampleColor;
    if (blurRadius <= 0.0) {
      sampleColor = texture(image, sampleUv);
    } else if (any(notEqual(blurDirection, vec2(0.0)))) {
      vec2 stepUv = blurRadius * blurDirection / textureSize;
      sampleColor = texture(image, sampleUv) * 0.227027;
      sampleColor += texture(image, clamp(sampleUv + stepUv * 1.384615,
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.316216;
      sampleColor += texture(image, clamp(sampleUv - stepUv * 1.384615,
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.316216;
      sampleColor += texture(image, clamp(sampleUv + stepUv * 3.230769,
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.070270;
      sampleColor += texture(image, clamp(sampleUv - stepUv * 3.230769,
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.070270;
    } else {
      vec2 stepUv = blurRadius / textureSize;
      sampleColor = texture(image, vertexUv) * 0.227027;
      sampleColor += texture(image, clamp(vertexUv + vec2(stepUv.x, 0.0), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(vertexUv - vec2(stepUv.x, 0.0), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(vertexUv + vec2(0.0, stepUv.y), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(vertexUv - vec2(0.0, stepUv.y), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(vertexUv + stepUv, vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += texture(image, clamp(vertexUv - stepUv, vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += texture(image, clamp(vertexUv + vec2(stepUv.x, -stepUv.y), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += texture(image, clamp(vertexUv + vec2(-stepUv.x, stepUv.y), vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
    }
    if (noiseGlitchEnabled) {
      if (sampleColor.a > 0.0) sampleColor.rgb /= sampleColor.a;
      float channelOffset = noiseGlitchParameters.w * 0.5 / textureSize.x;
      vec4 redSample = texture(image, clamp(sampleUv + vec2(channelOffset, 0.0),
        vertexUvClamp.xy, vertexUvClamp.zw));
      vec4 blueSample = texture(image, clamp(sampleUv - vec2(channelOffset, 0.0),
        vertexUvClamp.xy, vertexUvClamp.zw));
      sampleColor.r = redSample.a > 0.0 ? redSample.r / redSample.a : 0.0;
      sampleColor.b = blueSample.a > 0.0 ? blueSample.b / blueSample.a : 0.0;
      float noise = (pmjsRandom(sampleUv * textureSize +
        vec2(noiseGlitchParameters.y)) - 0.5) * noiseGlitchParameters.x;
      sampleColor.rgb = clamp(sampleColor.rgb + noise, 0.0, 1.0);
      sampleColor.rgb *= sampleColor.a;
    }
    if (pixiFilterKind == 2) {
      vec2 center = vec2(pixiFilterParameters[0], pixiFilterParameters[1]) / textureSize;
      float halfWavelength = pixiFilterParameters[3] * 0.5 / textureSize.x;
      float currentRadius = pixiFilterParameters[5] * pixiFilterParameters[6] / textureSize.x;
      vec2 direction = vertexUv - center;
      direction.y *= textureSize.y / textureSize.x;
      float difference = halfWavelength > 0.0 ? (length(direction) - currentRadius) / halfWavelength : 2.0;
      float power = max(0.0, 1.0 - difference * difference);
      float fade = pixiFilterParameters[7] > 0.0 ?
        max(0.0, 1.0 - pow(currentRadius /
          (pixiFilterParameters[7] / textureSize.x), 2.0)) : 1.0;
      sampleColor.rgb *= 1.0 + (pixiFilterParameters[4] - 1.0) * power * fade;
    }
    if (spriteColorEnabled && sampleColor.a > 0.0) {
      vec3 straightColor = sampleColor.rgb / sampleColor.a;
      float gray = dot(straightColor, vec3(0.299, 0.587, 0.114));
      straightColor = mix(straightColor, vec3(gray), spriteColorTone.a);
      straightColor = clamp(straightColor + spriteColorTone.rgb, 0.0, 1.0);
      straightColor = mix(straightColor, spriteBlendColor.rgb,
                          spriteBlendColor.a);
      sampleColor.rgb = straightColor * sampleColor.a;
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
      vec2 screenPixel = vec2(gl_FragCoord.x, screenHeight - gl_FragCoord.y);
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
constexpr const char* tileVertexSource = R"(
  #version 300 es
  layout(location = 0) in vec2 localPosition;
  layout(location = 1) in vec2 sourcePixel;
  layout(location = 2) in vec2 animationFactor;
  uniform mat3 world;
  uniform vec2 screenSize;
  uniform vec2 animationOffset;
  uniform vec2 textureSize;
  out vec2 vertexUv;
  void main() {
    vec2 pixel = (world * vec3(localPosition, 1.0)).xy;
    gl_Position = vec4(pixel.x / screenSize.x * 2.0 - 1.0,
                       1.0 - pixel.y / screenSize.y * 2.0, 0.0, 1.0);
    vertexUv = (sourcePixel + animationFactor * animationOffset) / textureSize;
  }
)";
constexpr const char* simpleFragmentSource = R"(
  #version 300 es
  precision mediump float;
  uniform sampler2D image;
  in vec2 vertexUv;
  in vec4 vertexColor;
  in vec4 vertexUvClamp;
  out vec4 outputColor;
  void main() {
    outputColor = texture(image, vertexUv) * vertexColor;
    outputColor.rgb *= outputColor.a;
  }
)";
constexpr const char* generatedTextureFragmentSource = R"(
  #version 300 es
  precision mediump float;
  uniform sampler2D image;
  in vec2 vertexUv;
  out vec4 outputColor;
  void main() {
    vec4 color = texture(image, vec2(vertexUv.x, 1.0 - vertexUv.y));
    if (color.a > 0.0) color.rgb /= color.a;
    outputColor = color;
  }
)";
constexpr const char* presentationVertexSource = R"(
  #version 300 es
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
constexpr const char* presentationFragmentSource = R"(
  #version 300 es
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
    video.rgb *= video.a;
    composed = video + composed * (1.0 - video.a);
    vec4 upperCanvas = texture(upperCanvasImage, vertexUv);
    upperCanvas.a *= upperCanvasOpacity;
    upperCanvas.rgb *= upperCanvas.a;
    composed = upperCanvas + composed * (1.0 - upperCanvas.a);
    outputColor = vec4(composed.rgb,
      opaqueBackground ? 1.0 : composed.a);
  }
)";
constexpr const char* spriteEffectFragmentSource = R"(
  #version 300 es
  precision mediump float;
  uniform sampler2D image;
  uniform vec2 textureSize;
  uniform float blurRadius;
  uniform sampler2D maskImage;
  uniform bool maskEnabled;
  uniform float maskTransform[6];
  uniform vec2 maskTextureSize;
  uniform float screenHeight;
  uniform bool spriteColorEnabled;
  uniform vec4 spriteColorTone;
  uniform vec4 spriteBlendColor;
  uniform bool colorMatrixEnabled;
  uniform float colorMatrix[20];
  uniform float colorMatrixAlpha;
  in vec2 vertexUv;
  in vec4 vertexColor;
  in vec4 vertexUvClamp;
  out vec4 outputColor;
  void main() {
    vec4 sampleColor;
    if (blurRadius <= 0.0) {
      sampleColor = texture(image, vertexUv);
    } else {
      vec2 stepUv = blurRadius / textureSize;
      sampleColor = texture(image, vertexUv) * 0.227027;
      sampleColor += texture(image, clamp(vertexUv + vec2(stepUv.x, 0.0),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(vertexUv - vec2(stepUv.x, 0.0),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(vertexUv + vec2(0.0, stepUv.y),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(vertexUv - vec2(0.0, stepUv.y),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.158108;
      sampleColor += texture(image, clamp(vertexUv + stepUv,
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += texture(image, clamp(vertexUv - stepUv,
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += texture(image, clamp(vertexUv + vec2(stepUv.x, -stepUv.y),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
      sampleColor += texture(image, clamp(vertexUv + vec2(-stepUv.x, stepUv.y),
        vertexUvClamp.xy, vertexUvClamp.zw)) * 0.049405;
    }
    if (spriteColorEnabled && sampleColor.a > 0.0) {
      vec3 straightColor = sampleColor.rgb / sampleColor.a;
      float gray = dot(straightColor, vec3(0.299, 0.587, 0.114));
      straightColor = mix(straightColor, vec3(gray), spriteColorTone.a);
      straightColor = clamp(straightColor + spriteColorTone.rgb, 0.0, 1.0);
      straightColor = mix(straightColor, spriteBlendColor.rgb,
                          spriteBlendColor.a);
      sampleColor.rgb = straightColor * sampleColor.a;
    }
    outputColor = sampleColor * vertexColor;
    if (maskEnabled) {
      vec2 screenPixel = vec2(gl_FragCoord.x, screenHeight - gl_FragCoord.y);
      vec2 maskLocal = vec2(
        maskTransform[0] * screenPixel.x + maskTransform[2] * screenPixel.y +
          maskTransform[4],
        maskTransform[1] * screenPixel.x + maskTransform[3] * screenPixel.y +
          maskTransform[5]);
      if (any(lessThan(maskLocal, vec2(0.0))) ||
          any(greaterThanEqual(maskLocal, maskTextureSize))) discard;
      outputColor.a *= texture(maskImage, maskLocal / maskTextureSize).a;
    }
    outputColor.rgb *= outputColor.a;
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
constexpr const char* tileFragmentSource = R"(
  #version 300 es
  precision mediump float;
  uniform sampler2D image;
  uniform vec4 color;
  uniform sampler2D maskImage;
  uniform bool maskEnabled;
  uniform float maskTransform[6];
  uniform vec4 maskFrame;
  uniform vec2 maskTextureSize;
  uniform float screenHeight;
  in vec2 vertexUv;
  out vec4 outputColor;
  void main() {
    outputColor = texture(image, vertexUv) * color;
    if (maskEnabled) {
      vec2 screenPixel = vec2(gl_FragCoord.x, screenHeight - gl_FragCoord.y);
      vec2 maskPixel = vec2(
        maskTransform[0] * screenPixel.x + maskTransform[2] * screenPixel.y + maskTransform[4],
        maskTransform[1] * screenPixel.x + maskTransform[3] * screenPixel.y + maskTransform[5]);
      if (any(lessThan(maskPixel, maskFrame.xy)) ||
          any(greaterThanEqual(maskPixel, maskFrame.xy + maskFrame.zw))) discard;
      vec2 maskUv = maskPixel / maskTextureSize;
      outputColor.a *= texture(maskImage, maskUv).a;
    }
    outputColor.rgb *= outputColor.a;
  }
)";


}  // namespace pmjs::renderer_shaders
