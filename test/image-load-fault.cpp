#include <EGL/egl.h>
#include <SDL_video.h>
#include <GLES3/gl3.h>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <new>
#include <stdexcept>


extern "C" {
SDL_GLContext SDL_GL_GetCurrentContext() {
  const char* mode = std::getenv("PMJS_IMAGE_FAULT");
  if (mode && std::strcmp(mode, "no-context") == 0) return nullptr;
  using Current = SDL_GLContext (*)();
  static const auto current = reinterpret_cast<Current>(dlsym(RTLD_NEXT, "SDL_GL_GetCurrentContext"));
  return current();
}
EGLContext eglGetCurrentContext() {
  const char* mode = std::getenv("PMJS_IMAGE_FAULT");
  if (mode && std::strcmp(mode, "hidden-egl") == 0) return EGL_NO_CONTEXT;
  using Current = EGLContext (*)();
  static const auto current = reinterpret_cast<Current>(dlsym(dlopen("libEGL.so.1", RTLD_LAZY), "eglGetCurrentContext"));
  return current();
}
GLenum glGetError() {
  const char* mode = std::getenv("PMJS_IMAGE_FAULT");
  if (mode && std::strcmp(mode, "persistent-error") == 0) return GL_INVALID_OPERATION;
  using Error = GLenum (*)();
  static const auto error = reinterpret_cast<Error>(dlsym(dlopen("libGLESv2.so.2", RTLD_LAZY), "glGetError"));
  return error();
}
void glTexImage2D(GLenum target, GLint level, GLint format, GLsizei width,
    GLsizei height, GLint border, GLenum inputFormat, GLenum type, const void* pixels) {
  const char* mode = std::getenv("PMJS_IMAGE_FAULT");
  if (mode && std::strcmp(mode, "allocation") == 0) {
    unsetenv("PMJS_IMAGE_FAULT");
    throw std::bad_alloc();
  }
  if (mode && std::strcmp(mode, "unknown") == 0) {
    unsetenv("PMJS_IMAGE_FAULT");
    throw 42;
  }
  using Upload = void (*)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void*);
  static const auto upload = reinterpret_cast<Upload>(dlsym(dlopen("libGLESv2.so.2", RTLD_LAZY), "glTexImage2D"));
  upload(target, level, format, width, height, border, inputFormat, type, pixels);
  if (mode && std::strcmp(mode, "wrapper") == 0) setenv("PMJS_IMAGE_FAULT", "wrapper-allocation", 1);
}
}

void* operator new(std::size_t size) {
  const char* mode = std::getenv("PMJS_IMAGE_FAULT");
  if (mode && std::strcmp(mode, "wrapper-allocation") == 0 && size == 2 * sizeof(void*)) {
    unsetenv("PMJS_IMAGE_FAULT");
    throw std::bad_alloc();
  }
  if (void* value = std::malloc(size ? size : 1)) return value;
  throw std::bad_alloc();
}
void operator delete(void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
