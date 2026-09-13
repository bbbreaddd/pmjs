globalThis.__pmjsShouldRetainImagePixels = function(path) {
  return /^img\/atlases\//i.test(String(path));
};
