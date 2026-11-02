// Entry point. One module graph, one request.
//
// Importing router.js is what boots the app: it runs the access gate and mounts
// the view the hash names. Nothing below needs calling.

import * as common from './common.js';
import * as deck from './deck.js';
import * as macro from './macro.js';
import { PadView } from './pad.js';
import { MacrosView } from './macros.js';
import { SettingsView } from './settings.js';
import { UiView } from './ui.js';
import { Router } from './router.js';

// The test harness drives the page by name - PadView.report(), parseMacro(),
// appSettings - the way it did when each file was a plain script and every
// top-level name was a global. A module graph would otherwise make them
// unaddressable, so they are put back on window.
//
// Getters, not values: appSettings and token are reassigned by loadSettings()
// and by the gate, and a copied binding would go stale the moment they change.
function expose(namespace, names) {
  for (const name of names) {
    Object.defineProperty(window, name, {
      get: () => namespace[name],
      configurable: true,
    });
  }
}

expose(common, Object.keys(common));
expose(deck, Object.keys(deck));
expose(macro, Object.keys(macro));

for (const [name, view] of Object.entries({ PadView, MacrosView, SettingsView, UiView, Router })) {
  Object.defineProperty(window, name, { value: view, configurable: true });
}
