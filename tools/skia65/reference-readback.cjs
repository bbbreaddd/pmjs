'use strict';

// Direct premultiplied RGBA8 readback, frozen independently of parent diagnostics.
function install() {
  let canvasGl;
  globalThis.__titleReadCanvas = function(canvas) {
    if (!canvasGl) canvasGl = document.createElement('canvas').getContext('webgl');
    const gl = canvasGl;
    if (!gl) throw new Error('Canvas diagnostic requires WebGL');
    const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('Incomplete Canvas diagnostic framebuffer');
      const bytes = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Canvas diagnostic readback failed');
      return bytes;
    } finally {
      gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture);
    }
  };
  return () => { delete globalThis.__titleReadCanvas; };
}
module.exports = { install };
