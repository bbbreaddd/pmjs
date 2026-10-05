# Canvas drawing

Canvas compositing supports the standard Porter–Duff and blend operations. CPU
path, rectangle, and image samples are composed against native-owned pixels;
operations such as `copy` also process transparent source pixels outside the
shape, within the active clip. Invalid `globalCompositeOperation` assignments
leave the previous value unchanged.

`NativeHost.canvas.paintCircle(handle, request)` owns circle rasterization and
composition. Its request contains `geometry: [x, y, radius]`, a six-component
`transform`, a `paint`, `globalAlpha`, `composite`, and `clips`. Paints support
solid RGBA colors, linear and radial gradients, and premultiplied RGBA pattern
snapshots. Clips contain a `nonzero` or `evenodd` rule and transformed path
points. Painting detaches shared Canvas content before mutation and preserves
retained snapshots. Invalid requests raise an error before changing pixels.

Paint descriptors use `kind: 'solid'` with an integer `color` in `0xRRGGBBAA`
order; `kind: 'linear'` or `'radial'` with
`geometry: [x0, y0, r0, x1, y1, r1]`, sorted `offsets`, and matching `colors`;
or `kind: 'pattern'` with `width`, `height`, `pixels`, `repeat`, and a six-component
pattern `transform`. Linear gradients ignore the radius fields. Pattern pixels
are a premultiplied RGBA byte array. Each clip contains `rule` and `paths`,
where a path is an array of `[x, y]` points in canvas coordinates.
