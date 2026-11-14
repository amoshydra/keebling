// Devices: the list of dongles the published UI has been told about.
//
// The list itself is not here. common.js owns it, because the boot gate renders
// the same thing from the same template - and the gate is only seen when
// something is wrong, so two implementations would be two chances to disagree
// at the worst moment.

import { hostedAppUrl, isDeviceOrigin, mountDevices, switchDevice, token } from './common.js';

export const DevicesView = (() => {
  let host = null;

  async function init() {
    const back = document.getElementById('devicesBack');
    if (back) back.addEventListener('click', () => { location.hash = '#/'; });

    const note = document.getElementById('devicesDeviceNote');
    host = document.getElementById('devicesHost');

    // The dongle's own page drives exactly one device: itself. The list is a
    // published-UI idea, and offering it here would be a form that can never
    // succeed - one device's origin is not in another's allowlist. So this
    // becomes the pointer to the app that does have a list.
    if (await isDeviceOrigin()) {
      if (host) host.hidden = true;
      if (!note) return;
      note.hidden = false;
      const open = document.getElementById('devicesHosted');
      if (open) {
        open.addEventListener('click', () => {
          window.open(hostedAppUrl(location.origin, token), '_blank', 'noopener');
        });
      }
      return;
    }

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
