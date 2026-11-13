// Devices: the list of dongles the published UI has been told about.
//
// The list itself is not here. common.js owns it, because the boot gate renders
// the same thing from the same template - and the gate is only seen when
// something is wrong, so two implementations would be two chances to disagree
// at the worst moment.

import { mountDevices, switchDevice } from './common.js';

export const DevicesView = (() => {
  let host = null;

  function init() {
    host = document.getElementById('devicesHost');
    const back = document.getElementById('devicesBack');
    if (back) back.addEventListener('click', () => { location.hash = '#/'; });

    if (!host) return;
    mountDevices(host, {
      // Switching reloads rather than rebinding: one socket, one token, one
      // settings blob, and no chance of half a session on the old device.
      onPick: (dev, base) => switchDevice(base, dev.token),
    });
  }

  function destroy() {
    // The probes outlive the view, but they only draw into nodes that are about
    // to be discarded. Nothing else needs releasing.
    host = null;
  }

  return { init, destroy };
})();
