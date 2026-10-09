set(PMJS_NODE_ROOT "" CACHE PATH "Node distribution to bundle, including its LICENSE")
option(PMJS_BUNDLE_DEPENDENCIES "Install reviewed nongraphics target libraries and sources" OFF)
option(PMJS_RELEASE_PROVENANCE "Bind installed releases to Git source and compiled outputs" OFF)
find_package(Python3 REQUIRED COMPONENTS Interpreter)

if(PMJS_LINUX_ARM64_BUILD)
  foreach(component IN ITEMS sdk node)
    if(component STREQUAL "sdk")
      set(verify_args --sdk "${PMJS_SDK_ROOT}")
    else()
      set(verify_args --output "${PMJS_NODE_ROOT}")
    endif()
    execute_process(COMMAND "${Python3_EXECUTABLE}"
      "${CMAKE_CURRENT_SOURCE_DIR}/tools/linux-arm64/prepare-${component}.py" ${verify_args} --verify
      RESULT_VARIABLE verify_status ERROR_VARIABLE verify_error)
    if(NOT verify_status EQUAL 0)
      message(FATAL_ERROR "Target ${component} verification failed: ${verify_error}")
    endif()
  endforeach()
  if(NOT PMJS_ENABLE_SKIA65 OR NOT PMJS_BUNDLE_DEPENDENCIES OR NOT PMJS_NODE_ROOT)
    message(FATAL_ERROR "Linux ARM64 releases require Skia65, bundled target Node and reviewed dependencies")
  endif()
endif()

install(TARGETS pmjs_native LIBRARY DESTINATION lib)
if(PMJS_ENABLE_SKIA65)
  install(FILES "${pmjs_skia65_library}" DESTINATION lib)
  install(FILES "${PMJS_SKIA65_COMPONENT_DIR}/manifest.json" DESTINATION share/pmjs RENAME skia65-manifest.json)
endif()
install(PROGRAMS bin/pmjs DESTINATION bin)
install(DIRECTORY js runner profiles DESTINATION share/pmjs
  FILES_MATCHING PATTERN "*.js" PATTERN "*.cjs" PATTERN "*.json" PATTERN "*.ttf" PATTERN "*.LICENSE")
install(FILES tools/build-js-runtime.mjs tools/game-inspect.mjs tools/pmjs.mjs
  tools/package-self-test.cjs DESTINATION share/pmjs/tools)
install(FILES LICENSE THIRD_PARTY_NOTICES.md DESTINATION .)
install(DIRECTORY third_party/ DESTINATION share/pmjs/notices
  FILES_MATCHING PATTERN "*.LICENSE" PATTERN "*.GPLv2")
install(DIRECTORY docs/ DESTINATION share/pmjs/docs FILES_MATCHING PATTERN "*.md")
if(PMJS_NODE_ROOT)
  if(NOT EXISTS "${PMJS_NODE_ROOT}/bin/node" OR NOT EXISTS "${PMJS_NODE_ROOT}/LICENSE")
    message(FATAL_ERROR "PMJS_NODE_ROOT must contain bin/node and the complete Node LICENSE")
  endif()
  install(PROGRAMS "${PMJS_NODE_ROOT}/bin/node" DESTINATION bin)
  install(FILES "${PMJS_NODE_ROOT}/LICENSE" DESTINATION share/pmjs/notices RENAME Node.LICENSE)
endif()
if(PMJS_BUNDLE_DEPENDENCIES)
  if(NOT PMJS_LINUX_ARM64_BUILD)
    message(FATAL_ERROR "Automatic dependency bundling is supported only by the reviewed Linux ARM64 environment")
  endif()
  foreach(library IN ITEMS libz.so.1 libpng16.so.16 libwebp.so.7 libjpeg.so.8 libfreetype.so.6
      libavformat.so.60 libavcodec.so.60 libavutil.so.58 libswresample.so.4 libswscale.so.7)
    file(REAL_PATH "${PMJS_DEPENDENCY_PREFIX}/lib/${library}" library_file)
    install(FILES "${library_file}" DESTINATION lib RENAME "${library}")
  endforeach()
  install(DIRECTORY "${PMJS_DEPENDENCY_PREFIX}/notices/" DESTINATION share/pmjs/notices/dependencies)
  foreach(runtime IN ITEMS libcxx libcxxabi libunwind)
    install(FILES "${PMJS_SDK_ROOT}/zig/lib/${runtime}/LICENSE.TXT"
      DESTINATION share/pmjs/notices/compiler RENAME "${runtime}.LICENSE")
  endforeach()
  install(FILES "${PMJS_SDK_ROOT}/zig/LICENSE" DESTINATION share/pmjs/notices/compiler RENAME Zig.LICENSE)
  # Ship the verified source archives, patches and executable recipes together.
  install(CODE "execute_process(COMMAND \"${Python3_EXECUTABLE}\" \"${CMAKE_CURRENT_SOURCE_DIR}/tools/release.py\"
    sources --sdk \"${PMJS_SDK_ROOT}\" --output \"\$ENV{DESTDIR}\${CMAKE_INSTALL_PREFIX}/share/pmjs/sources\"
    COMMAND_ERROR_IS_FATAL ANY)")
endif()

configure_file(cmake/build-config.json.in build-config.json @ONLY)
if(PMJS_RELEASE_PROVENANCE)
  set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
  set_property(TARGET pmjs_native pmjs_runtime Effekseer EffekseerRendererGL PROPERTY EXPORT_COMPILE_COMMANDS ON)
  if(NOT CMAKE_GENERATOR STREQUAL "Ninja")
    message(FATAL_ERROR "Release provenance requires Ninja; use a release preset")
  endif()
  set(pmjs_link_inputs)
  foreach(dependency IN ITEMS SDL2 EGL GLES PNG ZLIB JPEG FREETYPE HARFBUZZ AVFORMAT AVCODEC AVUTIL SWRESAMPLE SWSCALE)
    list(APPEND pmjs_link_inputs ${${dependency}_LINK_LIBRARIES})
  endforeach()
  if(PMJS_ENABLE_SKIA65)
    list(APPEND pmjs_link_inputs "${pmjs_skia65_library}")
  endif()
  if(PMJS_LINUX_ARM64_BUILD)
    list(APPEND pmjs_link_inputs "${PMJS_SDK_ROOT}/zig/zig")
  endif()
  list(FILTER pmjs_link_inputs INCLUDE REGEX "^/")
  list(REMOVE_DUPLICATES pmjs_link_inputs)
  list(JOIN pmjs_link_inputs "\n" pmjs_input_paths)
  file(CONFIGURE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/build-inputs.txt" CONTENT "${pmjs_input_paths}\n" @ONLY)
  add_custom_target(pmjs_build_provenance
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/release.py"
      provenance --source "${CMAKE_CURRENT_SOURCE_DIR}" --build "${CMAKE_CURRENT_BINARY_DIR}"
    BYPRODUCTS "${CMAKE_CURRENT_BINARY_DIR}/build-source.json" VERBATIM)
  add_dependencies(pmjs_native pmjs_build_provenance)
  if(PMJS_ENABLE_SKIA65)
    add_dependencies(pmjs_build_provenance pmjs_skia65_component)
  endif()
  set_property(TARGET pmjs_native APPEND PROPERTY LINK_DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/build-source.json")
  add_custom_command(TARGET pmjs_native POST_BUILD
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/release.py" built
      --source "${CMAKE_CURRENT_SOURCE_DIR}" --build "${CMAKE_CURRENT_BINARY_DIR}"
      --addon "$<TARGET_FILE:pmjs_native>" VERBATIM)
endif()
install(CODE "execute_process(COMMAND \"${Python3_EXECUTABLE}\" \"${CMAKE_CURRENT_SOURCE_DIR}/tools/release.py\"
  manifest --stage \"\$ENV{DESTDIR}\${CMAKE_INSTALL_PREFIX}\" --build \"${CMAKE_CURRENT_BINARY_DIR}\"
  --source \"${CMAKE_CURRENT_SOURCE_DIR}\" COMMAND_ERROR_IS_FATAL ANY)")
