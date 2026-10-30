set(CMAKE_INSTALL_DEFAULT_COMPONENT_NAME runtime)
set(PMJS_NODE_ROOT "" CACHE PATH "Node distribution to bundle, including its LICENSE")
option(PMJS_BUNDLE_DEPENDENCIES "Install reviewed nongraphics target libraries and license notices" OFF)

if(PMJS_LINUX_ARM64_BUILD)
  if(NOT PMJS_ENABLE_SKIA65 OR NOT PMJS_BUNDLE_DEPENDENCIES OR NOT PMJS_NODE_ROOT)
    message(FATAL_ERROR "Linux ARM64 installations require Skia65, bundled Node and reviewed dependencies")
  endif()
endif()

install(TARGETS pmjs_native LIBRARY DESTINATION lib COMPONENT native-addon)
if(PMJS_ENABLE_SKIA65)
  install(FILES "${pmjs_skia65_library}" DESTINATION lib)
endif()
install(PROGRAMS bin/pmjs DESTINATION bin)
install(DIRECTORY js runner profiles DESTINATION share/pmjs
  FILES_MATCHING PATTERN "*.js" PATTERN "*.cjs" PATTERN "*.json" PATTERN "*.ttf" PATTERN "*.LICENSE")
install(FILES tools/build-js-runtime.mjs tools/build-js-composition.mjs tools/game-inspect.mjs tools/achievement-discovery.mjs tools/game-bundle.mjs tools/pmjs.mjs
  tools/package-self-test.cjs DESTINATION share/pmjs/tools)
install(FILES tools/portmaster.py tools/portmaster_metadata.py tools/runtime_artifact.py
  tools/verify-asset-index.cjs
  DESTINATION share/pmjs/tools COMPONENT host-tools)
install(FILES tools/linux-arm64/audit-abi.py DESTINATION share/pmjs/tools/linux-arm64 COMPONENT host-tools)
install(FILES LICENSE THIRD_PARTY_NOTICES.md DESTINATION .)
install(DIRECTORY third_party/ DESTINATION share/pmjs/notices
  FILES_MATCHING PATTERN "*.LICENSE" PATTERN "*.GPLv2")
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
  foreach(library IN ITEMS libz.so.1 libpng16.so.16 libwebp.so.7 libsharpyuv.so.0 libjpeg.so.8 libfreetype.so.6
      libavformat.so.60 libavcodec.so.60 libavutil.so.58 libswresample.so.4 libswscale.so.7)
    file(REAL_PATH "${PMJS_DEPENDENCY_PREFIX}/lib/${library}" library_file)
    install(FILES "${library_file}" DESTINATION lib RENAME "${library}")
  endforeach()
  file(REAL_PATH "${PMJS_SDK_ROOT}/sysroot/usr/lib/aarch64-linux-gnu/libatomic.so.1" atomic_library)
  install(FILES "${atomic_library}" DESTINATION lib RENAME libatomic.so.1)
  install(FILES "${PMJS_SDK_ROOT}/sysroot/usr/share/doc/gcc-8-base/copyright"
    DESTINATION share/pmjs/notices/dependencies/libatomic RENAME copyright)
  install(DIRECTORY "${PMJS_DEPENDENCY_PREFIX}/notices/" DESTINATION share/pmjs/notices/dependencies)
  foreach(runtime IN ITEMS libcxx libcxxabi libunwind)
    install(FILES "${PMJS_SDK_ROOT}/zig/lib/${runtime}/LICENSE.TXT"
      DESTINATION share/pmjs/notices/compiler RENAME "${runtime}.LICENSE")
  endforeach()
  install(FILES "${PMJS_SDK_ROOT}/zig/LICENSE" DESTINATION share/pmjs/notices/compiler RENAME Zig.LICENSE)
endif()

configure_file(cmake/build-config.json.in build-config.json @ONLY)
configure_file(cmake/InstallMetadata.cmake.in InstallMetadata.cmake @ONLY)
install(SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/InstallMetadata.cmake")
