'use strict';

if (typeof $plugins === 'undefined') pmjsMvLoadPluginManifest();
pmjsMvInitializePlugins();
pmjsMvLoadEntrypoint();
pmjsMvStart();
