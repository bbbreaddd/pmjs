'use strict';

/* @pixi/filter-zoom-blur 3.1.0 shader identities.
The MIT License

Copyright (c) 2013-2018 Wei Zijun, Matt Karl

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

(function() {
  var vertex = `
attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat3 projectionMatrix;

varying vec2 vTextureCoord;

void main(void)
{
    gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
    vTextureCoord = aTextureCoord;
}
`.trim();
  var fragment = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 filterArea;

uniform vec2 uCenter;
uniform float uStrength;
uniform float uInnerRadius;
uniform float uRadius;

const float MAX_KERNEL_SIZE = 32.0;

// author: http://byteblacksmith.com/improvements-to-the-canonical-one-liner-glsl-rand-for-opengl-es-2-0/
highp float rand(vec2 co, float seed) {
    const highp float a = 12.9898, b = 78.233, c = 43758.5453;
    highp float dt = dot(co + seed, vec2(a, b)), sn = mod(dt, 3.14159);
    return fract(sin(sn) * c + seed);
}

void main() {

    float minGradient = uInnerRadius * 0.3;
    float innerRadius = (uInnerRadius + minGradient * 0.5) / filterArea.x;

    float gradient = uRadius * 0.3;
    float radius = (uRadius - gradient * 0.5) / filterArea.x;

    float countLimit = MAX_KERNEL_SIZE;

    vec2 dir = vec2(uCenter.xy / filterArea.xy - vTextureCoord);
    float dist = length(vec2(dir.x, dir.y * filterArea.y / filterArea.x));

    float strength = uStrength;

    float delta = 0.0;
    float gap;
    if (dist < innerRadius) {
        delta = innerRadius - dist;
        gap = minGradient;
    } else if (radius >= 0.0 && dist > radius) { // radius < 0 means it's infinity
        delta = dist - radius;
        gap = gradient;
    }

    if (delta > 0.0) {
        float normalCount = gap / filterArea.x;
        delta = (normalCount - delta) / normalCount;
        countLimit *= delta;
        strength *= delta;
        if (countLimit < 1.0)
        {
            gl_FragColor = texture2D(uSampler, vTextureCoord);
            return;
        }
    }

    // randomize the lookup values to hide the fixed number of samples
    float offset = rand(vTextureCoord, 0.0);

    float total = 0.0;
    vec4 color = vec4(0.0);

    dir *= strength;

    for (float t = 0.0; t < MAX_KERNEL_SIZE; t++) {
        float percent = (t + offset) / MAX_KERNEL_SIZE;
        float weight = 4.0 * (percent - percent * percent);
        vec2 p = vTextureCoord + dir * percent;
        vec4 sample = texture2D(uSampler, p);

        // switch to pre-multiplied alpha to correctly blur transparent images
        // sample.rgb *= sample.a;

        color += sample * weight;
        total += weight;

        if (t > countLimit){
            break;
        }
    }

    color /= total;
    // switch back from pre-multiplied alpha
    // color.rgb /= color.a + 0.00001;

    gl_FragColor = color;
}
`.trim();
  var stockApply = PIXI.Filter.prototype.apply;
  function shaderSource(source, precision) {
    if (typeof source !== 'string' ||
        source.indexOf('precision ' + precision + ' float;') !== 0) return null;
    // Pixi adds these declarations when creating an otherwise unchanged Program.
    return source.replace(/^precision (?:lowp|mediump|highp) float;\s*/, '')
      .replace(/^#define SHADER_NAME [^\n]*\n/, '').trim();
  }
  pmjsPixi5RegisterFilterEncoder(function(filter, node, size, resolution, renderer) {
    var program = filter.program;
    if (!program || shaderSource(program.vertexSrc, PIXI.settings.PRECISION_VERTEX) !== vertex ||
        shaderSource(program.fragmentSrc, PIXI.settings.PRECISION_FRAGMENT) !== fragment || filter.apply !== stockApply ||
        filter.padding !== 0 || filter.resolution !== 1 || !filter.autoFit ||
        resolution !== 1) return null;
    var area = node.filterArea || node.getBounds(true);
    if (!area || area.x > 0 || area.y > 0 || area.x + area.width < size.width ||
        area.y + area.height < size.height ||
        renderer.view.width !== size.width || renderer.view.height !== size.height) return null;
    // Only equal-resolution, zero-padding filter chains share this input frame.
    if (node.filters.some(function(other) {
      return other && other.enabled !== false &&
        (other.padding !== 0 || other.resolution !== 1 || !other.autoFit);
    })) return null;
    var uniforms = filter.uniforms;
    var center = uniforms.uCenter;
    if (!center) return null;
    var parameters = [center.x === undefined ? center[0] : center.x,
      center.y === undefined ? center[1] : center.y,
      uniforms.uStrength, uniforms.uInnerRadius, uniforms.uRadius, 0, 0, 0, 0, 1];
    if (!parameters.every(Number.isFinite) || parameters[3] < 0) return null;
    return { kind: 4, parameters: parameters };
  });
})();
