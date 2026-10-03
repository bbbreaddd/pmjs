include(FetchContent)
FetchContent_Declare(pmjs_effekseer
  URL https://codeload.github.com/effekseer/Effekseer/tar.gz/e0ccaf1d1837b1d178d0088f714a1f4525cae8f4
  URL_HASH SHA256=e2cb5aefdf1bf84d0d050fd44fcc64aa35baeee957686768a508784f1ed243d1)

function(pmjs_build_effekseer)
  set(BUILD_VIEWER OFF)
  set(BUILD_EDITOR OFF)
  set(BUILD_TEST OFF)
  set(BUILD_EXAMPLES OFF)
  set(BUILD_UNITYPLUGIN OFF)
  set(BUILD_UNITYPLUGIN_FOR_IOS OFF)
  set(BUILD_GL ON)
  set(BUILD_DX9 OFF)
  set(BUILD_DX11 OFF)
  set(BUILD_DX12 OFF)
  set(BUILD_METAL OFF)
  set(BUILD_VULKAN OFF)
  set(BUILD_WITH_EASY_PROFILER OFF)
  set(NETWORK_ENABLED OFF)
  set(USE_LIBPNG_LOADER OFF)
  set(USE_OPENAL OFF)
  set(USE_OPENGLES2 ON)
  set(USE_OPENGLES3 OFF)
  FetchContent_MakeAvailable(pmjs_effekseer)
  find_package(Git REQUIRED)
  set(patch "${CMAKE_CURRENT_SOURCE_DIR}/third_party/effekseer-mz.patch")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${patch}")
  execute_process(COMMAND "${GIT_EXECUTABLE}" apply --reverse --check "${patch}"
    WORKING_DIRECTORY "${pmjs_effekseer_SOURCE_DIR}" RESULT_VARIABLE patched
    OUTPUT_QUIET ERROR_QUIET)
  if(NOT patched EQUAL 0)
    execute_process(COMMAND "${GIT_EXECUTABLE}" apply --check "${patch}"
      WORKING_DIRECTORY "${pmjs_effekseer_SOURCE_DIR}" RESULT_VARIABLE matches ERROR_VARIABLE reason)
    if(NOT matches EQUAL 0)
      message(FATAL_ERROR "Pinned Effekseer patch no longer matches ${pmjs_effekseer_SOURCE_DIR}: ${reason}")
    endif()
    execute_process(COMMAND "${GIT_EXECUTABLE}" apply "${patch}"
      WORKING_DIRECTORY "${pmjs_effekseer_SOURCE_DIR}" COMMAND_ERROR_IS_FATAL ANY)
  endif()
  target_include_directories(Effekseer SYSTEM PUBLIC "$<BUILD_INTERFACE:${pmjs_effekseer_SOURCE_DIR}/Dev/Cpp/Effekseer>")
  target_include_directories(EffekseerRendererGL SYSTEM PUBLIC "$<BUILD_INTERFACE:${pmjs_effekseer_SOURCE_DIR}/Dev/Cpp/EffekseerRendererGL>")
  target_link_libraries(EffekseerRendererGL PUBLIC PkgConfig::GLES PkgConfig::EGL)
  # Upstream's Linux ES2 backend omits EGL and the shared ES3 token declarations.
  target_compile_options(EffekseerRendererGL PRIVATE "SHELL:-include EGL/egl.h" "SHELL:-include GLES3/gl3.h")
  # Upstream defines these ES backend tokens only for Windows/Android/Apple.
  target_compile_definitions(EffekseerRendererGL PRIVATE GL_BGRA=0x80E1 GL_DEPTH_COMPONENT32=0x81A7)
endfunction()

pmjs_build_effekseer()
