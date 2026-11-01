# Absolute pointer over USB HID — research notes

Scope: what an absolute pointing device actually does on Windows / Linux / macOS, what
descriptor shape to use, what breaks, and how to switch modes without losing the keyboard.

Confidence markers used throughout:

- **[verified]** — read it in source code, a vendor doc, or a spec I fetched.
- **[reported]** — a specific person reports this behaviour with enough detail to trust, but I did
  not reproduce it.
- **[unverified]** — plausible, commonly repeated, or inferred. Treat as a hypothesis to test on
  hardware.

Everything here is about *external, non-integrated* pointers. Integrated pens/touchscreens on
laptops go through a different (per-panel, calibrated) path and are not a good model for a dongle.

---

## 1. Descriptor practice

### 1.1 The three shapes people actually ship

There is no "absolute mouse" in the HID spec. There are three real-world conventions, and the
top-level application collection usage is the whole classification contract:

| Shape | Usage page | Application collection usage | Who ships it |
|---|---|---|---|
| Absolute mouse | Generic Desktop `0x01` | `Mouse 0x02` (+ `Pointer 0x01` physical) | TinyUSB, QEMU `usb-tablet`, PiKVM, Teensyduino, Kaleidoscope, Microsoft VHF samples |
| Pen / tablet | Digitizers `0x0D` | `Digitizer 0x01` or `Pen 0x02` | Wacom, QMK `DIGITIZER_ENABLE`, Windows VHF pen samples |
| Touchscreen | Digitizers `0x0D` | `Touch Screen 0x04` | real panels, phone-as-trackpad projects |

The HID Usage Tables say this explicitly **[verified]** — `hut1_12.pdf` §3:

> Usages can also identify functional devices as a whole … found attached to application
> collections that are wrapped around all the items that describe a particular functional device.
> Generally an application will query the HID driver for all application collection usages that it
> knows pertain to it. For example, a gaming device driver might look for Joystick and Game Pad
> usages, while a **system mouse driver might look for Mouse, Digitizer Tablet and Touch Screen**
> usages.

So: same report bytes, three different product categories, decided by `0x09 0x02` vs `0x09 0x01`
vs `0x09 0x04` right after the usage page. That one byte is the whole risk.

The HUT also defines what each digitizer usage *means*, and the wording matters for Windows
mapping (§16.1) **[verified]**:

> **Digitizer** CA – A device that measures absolute spatial position, typically in two or more
> dimensions. This is a generic usage; several specialized types of digitizers are distinguished by
> their attributes.
>
> **Pen** CA – A digitizer with an **integrated display** that allows use of a stylus. The system
> must ensure that the sensed stylus position and the display representations of that position are
> the same. …
>
> **Touch Screen** CA – A digitizer with an integrated display …

That is exactly why Windows confines `Pen` to one display and lets generic `Digitizer` span the
virtual desktop (see §2.1). The spec is telling you the coordinate space.

Note what the HUT does **not** say: it never defines an absolute mouse. `Mouse` (§4.1) is described
as "a hand-held, button-activated input device that when **rolled along a flat surface**, directs an
indicator to move correspondingly about a computer screen" — i.e. a relative device. Absolute
positioning is a de-facto extension that every OS happens to support for `Mouse` + absolute axes.
**[verified — absence of text]**.

### 1.2 Concrete descriptors

**TinyUSB (your vendored copy, v0.21.0, and current master).** `TUD_HID_REPORT_DESC_ABSMOUSE()`
exists. It is *not* called `..._ABSOLUTE_MOUSE`; that is why grep for the obvious name fails.
`src/class/hid/hid_device.h` **[verified]**:

```c
// Absolute Mouse Report Descriptor Template
#define TUD_HID_REPORT_DESC_ABSMOUSE(...) \
  HID_USAGE_PAGE ( HID_USAGE_PAGE_DESKTOP      )                   ,\
  HID_USAGE      ( HID_USAGE_DESKTOP_MOUSE     )                   ,\
  HID_COLLECTION ( HID_COLLECTION_APPLICATION  )                   ,\
    __VA_ARGS__ \
    HID_USAGE      ( HID_USAGE_DESKTOP_POINTER )                   ,\
    HID_COLLECTION ( HID_COLLECTION_PHYSICAL   )                   ,\
      /* 5 buttons, 3 bit padding */                               \
      HID_USAGE_PAGE  ( HID_USAGE_PAGE_DESKTOP )                   ,\
        /* X, Y absolute position [0, 32767] */                    \
        HID_USAGE       ( HID_USAGE_DESKTOP_X                    ) ,\
        HID_USAGE       ( HID_USAGE_DESKTOP_Y                    ) ,\
        HID_LOGICAL_MIN  ( 0x00                                ) ,\
        HID_LOGICAL_MAX_N( 0x7FFF, 2                           ) ,\
        HID_REPORT_SIZE  ( 16                                  ) ,\
        HID_REPORT_COUNT ( 2                                   ) ,\
        HID_INPUT       ( HID_DATA | HID_VARIABLE | HID_ABSOLUTE ) ,\
        /* Vertical wheel scroll [-127, 127], relative */          \
        ...  HID_USAGE ( HID_USAGE_DESKTOP_WHEEL ) ...
      HID_USAGE_PAGE  ( HID_USAGE_PAGE_CONSUMER ), \
        /* Horizontal wheel scroll (AC Pan), relative */ ...
```

Report layout: `buttons:8, x:int16, y:int16, wheel:int8, pan:int8` = 7 bytes, matching
`hid_abs_mouse_report_t` and `tud_hid_abs_mouse_report()`. Upstream master is byte-identical
(fetched 2026-11) **[verified]**.

Caveat: also in that header is `TUD_HID_REPORT_DESC_STYLUS_PEN()`, and it contains a broken unit
item:

```c
HID_UNIT_EXPONENT( 0x0f ),
HID_UNIT        ( HID_VARIABLE | HID_NONLINEAR ),   // <-- nonsense: 0x02|0x04
HID_PHYSICAL_MIN( 0 ),
HID_PHYSICAL_MAX( 0 ),
```

`HID_UNIT` takes a *unit*, not main-item flags. QMK hit the same mistake and fixed it in
[PR #24482](https://github.com/qmk/qmk_firmware/pull/24482) — the value should be `0x13` (English
Linear, inches), and the exponent nibble is not an exponent. Do not copy TinyUSB's pen template.
**[verified]**

**QEMU `usb-tablet`** — the most widely deployed absolute pointer in existence
(`hw/usb/dev-hid.c`) **[verified]**:

```c
0x05,0x01, 0x09,0x02, 0xa1,0x01,   // GD / Mouse / Application
  0x09,0x01, 0xa1,0x00,            //   Pointer / Physical
    0x05,0x09, 0x19,0x01,0x29,0x05, 0x15,0x00,0x25,0x01,
    0x95,0x05,0x75,0x01, 0x81,0x02,  // 5 buttons
    0x95,0x01,0x75,0x03, 0x81,0x01,  // 3 bit pad
    0x05,0x01, 0x09,0x30, 0x09,0x31,
    0x15,0x00, 0x26,0xff,0x7f,       // Logical   0..0x7fff
    0x35,0x00, 0x46,0xff,0x7f,       // Physical  0..0x7fff
    0x75,0x10,0x95,0x02, 0x81,0x02,  // X,Y 16 bit absolute
    0x05,0x01, 0x09,0x38, 0x15,0x81,0x25,0x7f,
    0x75,0x08,0x95,0x01, 0x81,0x06,  // wheel, relative
```

Note QEMU declares `Physical Min/Max` equal to logical. TinyUSB and PiKVM do not declare physical
at all, and both work, so it is not required — but see §4 for why it can matter on Linux.

**PiKVM** (KVM-over-IP; absolute is their *default* mouse mode) —
`kvmd/apps/otg/hid/mouse.py` **[verified]**:

```python
0x05, 0x01,  0x09, 0x02,  0xA1, 0x01,       # GD / Mouse / Application
# Pointer and Physical are required by Apple Recovery
0x09, 0x01,  0xA1, 0x00,                     #   Pointer / Physical
# 8 Buttons ...
0x05, 0x01,  0x09, 0x30, 0x09, 0x31,
0x16, 0x00, 0x00,   # Logical Minimum (0)
0x26, 0xFF, 0x7F,   # Logical Maximum (32767)
0x75, 0x10, 0x95, 0x02, 0x81, 0x02,
# Wheel ...
```

Two things worth stealing from their source comments:

> `# Pointer and Physical are required by Apple Recovery`

and, on the range (translated):

> The author [NicoHood] suggests -32768…32767, but "seven" [Windows 7] for some reason does not want
> to work with negative coordinate values, nor does it want to accept 65536 or 32768. So we feed it
> 0…32767 and send our regards to the Microsoft folks, because Linux works fine with any two-byte
> range.

**[reported]** — a concrete, dated range bug on Windows 7.

**QMK** `DIGITIZER_ENABLE` (Digitizers page) **[verified]** — see
`docs/qmk/qmk_firmware/docs/features/digitizer.md` and PR #12851. Note their guidance:

> The X and Y coordinates are normalized … `0` is the leftmost position, … `1` the rightmost. …
> **Since there is no display attached, the OS will likely map these coordinates to the virtual
> desktop. This may be important to know if you have multiple monitors.**
> The "in range" indicator is required to be on for the change in coordinates to be taken.

Descriptor: `05 0D / 09 01 / A1 01`, `09 20` (Stylus) physical collection, Tip Switch `0x42`,
In Range `0x32`, pad, then GD `X`/`Y` `0x7FFF` 16-bit absolute, `Unit 0x33` + exponent `0x0E` (the PR
that fixed the unit says it should be `0x13`).

### 1.3 Physical vs Application collection

- The application collection is the thing hosts key on (§1.1). **[verified]**
- HUT §16.2: "The **Stylus collection is a physical collection** containing all the controls
  physically located on the stylus. In the Stylus collection a **Pointer physical collection will
  contain the axes** reported by the stylus." Same pattern for Puck and Finger. So for a pen, the
  axes belong inside `Usage(Stylus) > Collection(Physical) > Usage(Pointer) > axes`. **[verified]**
- For `Mouse`, HUT does not mandate the nesting, but every shipping implementation puts
  `Usage(Pointer) > Collection(Physical)` around the axes and buttons — TinyUSB, QEMU, PiKVM,
  NicoHood, QMK all do. PiKVM's comment claims it is required by Apple's recovery environment.
  **[reported]**
- No host I found *requires* `Physical` for a `Mouse` collection, but there is no upside to omitting
  it and at least one report of a host that cares.

### 1.4 Ranges in the wild

| Implementation | X/Y logical range | Physical | Notes |
|---|---|---|---|
| TinyUSB `ABSMOUSE` | 0…32767 | none | 16-bit |
| QEMU `usb-tablet` | 0…32767 | 0…32767 | 16-bit |
| PiKVM | 0…32767 | none | 16-bit, negative rejected on Win7 |
| QMK digitizer | 0…32767 | via unit | normalised float × 0x7FFF |
| Teensyduino | 0…32767 ("15 bit") | — | pixel-accurate on Win/Mac; author says Linux was buggy |
| QEMU *tablet* VHF sample / Windows pen examples | 0…65535 | — | pen route |
| Some cheap touch panels | 0…4095 | — | SiS controller (see Touchward README) |

4095 shows up on real hardware because the *controller* is 12-bit; that is a sensor limit, not a
host requirement. Nothing in any host I looked at requires a specific maximum, but see §4.

---

## 2. Host behaviour

### 2.1 Summary table

| | Windows 10/11 | Linux (udev + libinput; X11 or Wayland) | macOS |
|---|---|---|---|
| **Classification of `GD/Mouse` + abs X/Y** | "HID-compliant mouse". One child device per top-level collection. Plain cursor, no pen UI. **[verified — see below]** | `ID_INPUT_MOUSE` only (systemd `input_id` has an explicit `is_abs_mouse` branch for exactly this). libinput gives it `pointer` capability and emits absolute pointer motion. **[verified]** | Treated as an absolute pointing device / mouse. No UI change. **[reported: Teensyduino `Mouse.moveTo()` works on macOS]** |
| **Classification of `Digitizer 0x01` + Stylus/Tip/InRange** | "HID-compliant digitizer" (UPDD's device-name table lists `HID-compliant digitizer`, `-pen`, `-touch screen`, `-light pen`, `-whiteboard`). Windows Ink / pen stack. **[verified for the names, reported for the mapping]** | udev sees `BTN_TOOL_PEN` ⇒ `ID_INPUT_TABLET`. libinput then **requires** `ABS_X/Y`, `BTN_TOOL_PEN` **and a resolution**, else it logs `missing tablet capabilities: xy pen btn-stylus resolution. Ignoring this device.` **[verified — libinput tablet-debugging doc]** | Apple's tablet path. Touchward's author states macOS "has no driver that translates HID digitizer coordinates into a pointer position" for `Touch Screen`; pen tablets do work. **[reported, conflicting]** |
| **Multi-monitor mapping, `Mouse`+abs** | **Primary monitor only.** Absolute HID mouse coords are delivered as `MOUSE_MOVE_ABSOLUTE` without `MOUSE_VIRTUAL_DESKTOP`. **[reported twice + documented]** | Whole output-layout **bounding box** by default (wlroots `wlr_cursor_absolute_to_layout_coords`); can be pinned to one output per device. X11: the X screen. **[verified for wlroots; inferred for X]** | One display (the active/main one), not the bounding box. **[reported]** |
| **Multi-monitor mapping, generic `Digitizer`** | **Entire virtual desktop** `(0,0)…(Σwidth, Σheight)`. **[reported, twice independently]** | As above (whole layout). | Unknown. **[unverified]** |
| **Multi-monitor mapping, `Pen`** | **Main display only.** **[reported, twice]** | N/A (tablet, mapped per libwacom/hwdb output) | Unknown. |
| **Mixed DPI / scaling** | Absolute coords are in a single desktop coordinate space; mixed-DPI produces offsets that even commercial tools patch (`MouseMux` "X/Y injection: a manual pixel correction … can happen on unusual multi-monitor or DPI layouts"). **[reported]** | Absolute is normalised `[0,1]` and scaled by the *logical* layout box, so a 4K@2x monitor is 1920 logical units wide — the pad is linear in logical space, **not** in physical pixels. **[verified from wlroots code]** | Logical points, not pixels; same non-uniformity across Retina/non-Retina. **[unverified]** |
| **Two pointer devices (relative + absolute)** | Legal. Two collections ⇒ two "HID-compliant mouse" children; both feed the one system cursor, last event wins. No second cursor, but per-app Raw Input sees two devices and some BIOSes/UEFIs get confused. **[reported]** | Same *interface* ⇒ **one** evdev node holding both REL_X and ABS_X (`hid-input` merges all TLCs of an interface unless `HID_QUIRK_INPUT_PER_APP`). Separate interfaces ⇒ two nodes, one cursor. **[verified]** | Multiple pointing devices merge into one cursor. **[reported]** |

### 2.2 Windows, in detail

**Absolute mouse = primary monitor only.** This is the single most consequential finding.

- Microsoft, *Multiple Monitor Applications on Different Systems* **[verified]**:
  > Input devices that deliver coordinates to the system in absolute coordinates, such as tablets,
  > have their cursor input restricted to the primary monitor.
- `MOUSE_MOVE_ABSOLUTE` semantics **[verified, MS docs]**: without `MOUSE_VIRTUAL_DESKTOP`,
  "in a multimonitor system, the coordinates map to the primary monitor".
- `mouhid.sys` does not set that flag. An OSR thread from 2007 says so and explains you would need
  a filter driver between `mouhid` and `mouclass` to set it. ReactOS's `mouhid` clone, which mirrors
  the documented behaviour, likewise only ever sets `MOUSE_MOVE_ABSOLUTE` **[verified — ReactOS source]**.
- A 2023 hands-on VHF write-up re-confirms it on modern Windows: an absolute-coordinate *mouse*
  placed at `(50,50)` lands at the primary monitor's top-left, and the descriptor's logical range
  "only maps the `(0,0)…(1920,1080)` screen". The author then rebuilt the device as a **Digitizer**
  and got `(0,0)…(5760,1080)` — the whole three-monitor desktop **[reported]**.

**Digitizer = whole virtual desktop; Pen = main display.** Two independent reports agree:

- StackOverflow 76384103 (VHF pen driver, Windows 10/11): the pen "is always stuck to the monitor
  set as my main display", and the accepted answer is: change `0x09,0x02` (Usage Pen) to
  `0x09,0x01` (Usage Digitizer) — "which maps the pen to virtual desktop instead of main monitor."
  **[reported]**
- The same conclusion is restated in a Korean DDK series with full working code and a diagram of
  three monitors. **[reported]**

This matches the HUT wording in §1.1: `Pen` promises "integrated display, position must match the
display", so Windows honours that literally and confines it to one display; generic `Digitizer`
has no such promise and spans the desktop.

**What the user sees change with the digitizer route:** a `Pen & Windows Ink` settings page appears
(Settings → Bluetooth & devices), pen visual effects / cursor, possibly press-and-hold-to-right-click
and handwriting-panel behaviour, and drawing apps switching into pen mode. Device Manager grows an
entry named `HID-compliant digitizer` or `HID-compliant pen` instead of `HID-compliant mouse`.
**[reported — standard Windows pen behaviour; the exact set of effects on a synthetic pen is
[unverified]]**

Also relevant: Microsoft's own HLK guidance says "If your device exposes multiple pen TLCs, you will
need to … disable all HID-compliant pen digitizers, with the exception of the one that you want to
validate" — i.e. Windows happily enumerates several pen collections, and you then have to pick one.
**[verified]**

**Button limits.** `mouhid` historically supports 5 buttons (`Usage <= 5` in the ReactOS clone).
TinyUSB declares 5; PiKVM declares 8. Declaring 8 is fine on modern Windows but buys nothing here.

### 2.3 Linux, in detail

Classification is done by udev, not the kernel driver. `systemd/src/udev/udev-builtin-input_id.c`
**[verified]**:

```c
if (has_abs_coordinates) {
        if (has_stylus || has_pen)          is_tablet = true;
        else if (finger_but_no_pen && !is_direct) is_touchpad = true;
        else if (has_mouse_button)
                /* This path is taken by VMware's USB mouse, which has
                 * absolute axes, but no touch/pressure button. */
                is_abs_mouse = true;
        else if (has_touch || is_direct)    is_touchscreen = true;
        ...
}
...
if (is_mouse || is_abs_mouse) udev_builtin_add_property(event, "ID_INPUT_MOUSE", "1");
```

So a `Mouse` collection with abs X/Y and a left button is classified as a **mouse**, not a tablet
or touchscreen. That is exactly what you want.

libinput then treats it as a pointer and *does* support absolute motion for pointers — the
"absolute axes" documentation lists only touchscreens/tablets, but the implementation is more
generous. `src/evdev-fallback.c` **[verified]**:

```c
/* Single touch or absolute pointer devices */
} else if (dispatch->pending_event & EVDEV_ABSOLUTE_MOTION) {
        if (device->seat_caps & EVDEV_DEVICE_TOUCH) { ... }
        else if (device->seat_caps & EVDEV_DEVICE_POINTER) {
                fallback_flush_absolute_motion(dispatch, device, time);  // -> pointer_notify_motion_absolute()
        }
}
```

X11 through `xf86-input-libinput` handles it too (`xf86libinput_handle_absmotion()` →
`xf86PostMotionEventM(dev, Absolute, mask)`), and even warns if it receives an absolute event from
a device it thinks is relative ("Discarding absolute event from relative device. Please file a
bug"). **[verified]**

Mapping to monitors:

- **wlroots (sway, etc.)** **[verified]**: `wlr_cursor_absolute_to_layout_coords()` uses a per-device
  output mapping if one is configured (`wlr_cursor_map_input_to_output`), otherwise
  `wlr_output_layout_get_box(layout, NULL)` — the **bounding box of all outputs**. Coordinates are
  normalised `[0,1]` and multiplied by the box in *logical* pixels.
- **X11**: absolute valuators are posted into the X screen's coordinate space. With one X screen
  spanning all monitors (`Xinerama`/default RandR), that is the bounding box; with separate screens
  it is one screen. **[inferred from the driver code; not directly documented]**
- **GNOME/mutter**: not verified. A Kaleidoscope maintainer states "GNOME under Linux presents all
  displays combined as a big virtual screen, so warping around on that does cross display
  boundaries." **[reported]**

The historical caveat is real but old: Paul Stoffregen (Teensyduino, 2012) — "there is a big bug in
the Linux X11 server that does not accept absolute coordinates from a mouse device", which is why he
shipped a touchscreen descriptor for cross-OS use. **[reported, pre-libinput]** Modern
libinput/Xorg does handle it, and PiKVM's default mode is absolute on Linux targets. But if you
support an old distro, plan for it not to work. **[verified by code + reported by PiKVM]**

**The duplicate-usage trap (important for the "both mice in one interface" design).**
`hid-input` builds **one** `input_dev` per interface and feeds every report of that interface into
it, unless the device has `HID_QUIRK_MULTI_INPUT` or `HID_QUIRK_INPUT_PER_APP` — quirks that are
per-device table entries, not generic behaviour. Duplicate event codes are silently dropped
**[verified]**:

```c
while (usage->code <= max && test_and_set_bit(usage->code, bit)) {
        ...
        device->status |= HID_STAT_DUP_DETECTED;
        goto ignore;
}
...
if (hid->status & HID_STAT_DUP_DETECTED)
        hid_dbg(hid, "Some usages could not be mapped, ...");
```

Consequence: two `Mouse` collections in one interface both declaring `Button 1…5` → the second
collection's buttons are discarded (debug-level message only, so you will not notice). `ABS_X` vs
`REL_X` are different codes, so the axes themselves do not collide. Two *absolute* collections
(absolute mouse + digitizer, both `ABS_X`) **would** collide.

### 2.4 macOS

- A `GD/Mouse` application collection with absolute X/Y works and needs no kext; Teensyduino's
  `Mouse.moveTo()` is pixel-accurate on macOS, and Keyboardio ships an `AbsoluteMouse` in
  Kaleidoscope. **[reported]**
- The **top-level usage must be `Mouse 0x02`**. There is a whole kext
  (`pmj/QemuUSBTablet-OSX`) whose only job is to rewrite one byte of QEMU's descriptor because
  "the device reports a usage mode of 'pointer' (1). OS X's drivers expect either 'Mouse' (2) or
  'Digitiser'". Without it, 10.9+ treats the device as an **analog stick**: "converting distance
  from the middle of the screen as a velocity". **[reported]** (Current QEMU uses `Usage(Mouse)` as
  the TLC, so the kext is historical — but it pins down what macOS keys on.)
- Multi-monitor: absolute warping is confined to **one display**, not the bounding box — "As far as
  I remember, Windows and OSX don't do this, and warping there is restricted to a single screen"
  (Kaleidoscope maintainer), and a user of the same thread reports OS X "helpfully trying to confine
  it to the active screen". **[reported]**
- Evidence that per-display mapping is genuinely non-trivial on macOS: Sunshine needed a PR
  ("fix(macos/input): incorrect mouse input for non-main display … wrong abs mouse coordinates when
  capturing non-main display"), and Touchward/HIDTouch both conclude that "macOS offers no API
  linking a USB device to a `CGDirectDisplayID`" and require the user to name the display.
  **[verified — project READMEs/PR]**
- No evidence found on what macOS does with a **Digitizer**-page device from a third party. The two
  touch-panel projects exist *because* macOS does nothing useful with `Digitizer/Touch Screen`.
  Whether a `Digitizer/Pen` DIY device gets macOS's tablet path is **[unverified]** — assume it is
  worse than `Mouse`.

### 2.5 Remote desktop, VMs, games, raw input

- **VMs / KVM-over-IP:** the absolute pointer is the *normal* solution (QEMU `usb-tablet` is
  specifically for this), but multi-monitor mapping is a recurring bug class:
  - SPICE mailing list: "With a tablet you also cannot use multiple monitors (the mouse is mapped
    wrongly)." **[reported]**
  - VirtualBox ticket #21137: with USB Tablet + 2 displays, "the mouse movement would register
    across all monitors … But all other mouse events would only register on Monitor 1 and the
    entire width of all the monitors display would be condensed on Monitor 1" — fixed in 7.0.4 by
    changing the host-side scaling. **[verified — bug tracker]**
  - Moonlight/GeForce Experience: absolute position was scaled to the *virtual desktop* instead of
    the streamed monitor's rect, so the middle of the client mapped to the edge of the host screen.
    Fixed in GFE 3.22 by not passing `MOUSEEVENTF_VIRTUALDESK`. **[verified — issue thread]**
  - There is a QEMU patch proposing an `extend-abs-mode` option, stating that "the range of the
    absolute pointer device (usb-tablet) is restricted to any one monitor". **[verified — patch
    submission, may not be merged]**
- **RDP:** RDP's own mouse channel is a different code path and unaffected, but inside an RDP
  session the *host* desktop layout is what gets mapped, so the same primary-vs-virtual-desktop
  question applies to whatever the session exposes.
- **Games / raw input:** applications that read `WM_INPUT` / Raw Input, or that use pointer lock and
  clip the cursor, do not behave like a normal mouse when fed absolute reports. A commercial tool's
  manual spells out the same general problem for the software-injection case: "games, CAD and 3D
  packages and some drawing programs read the raw input stream or the Windows pointer history
  instead, and neither sees a directly positioned cursor." **[reported]** A real HID device does
  generate raw input, but it generates `MOUSE_MOVE_ABSOLUTE`, which many engines either ignore or
  mis-integrate. Expect: aim spinning, or the cursor pinned while the game has the pointer locked.
  **[unverified — needs hardware testing; this is the most likely "works on the desktop, fails in
  the game" outcome]**
- **Secure desktop / UAC / login:** a real HID device works, unlike software injection. That is the
  dongle's whole selling point and it survives an absolute-mode switch. **[verified — inherent]**

---

## 3. Edge cases and mitigations

| Symptom | Cause | Mitigation |
|---|---|---|
| Cursor pinned to a corner / only moves a few pixels | Host expected a larger logical range than declared (classic: driver assumes 0…65535). PiKVM documents exactly this on Win98: "the absolute mouse … moves only within the upper-left quarter of the screen". **[verified — PiKVM docs]** | Declare 16-bit, `Logical Maximum 0x7FFF`, and never exceed it. Do not use a small range like 0…100 or 0…1023. |
| Half-screen / quarter-screen mapping on multi-monitor | You mapped the pad to the whole desktop but the host maps to the primary monitor (Windows `Mouse` route), or vice versa (digitizer). | Decide the usage page first (§1), then compute the pad→host mapping for *that* host's convention. Provide a "one monitor only" calibration mode. |
| Coordinate inversion / mirrored Y | Y origin conventions (HID GD is top-down; macOS `NSEvent` is bottom-up; some pads report bottom-up). | Fix Y=0 at top in the firmware; expose a flip-Y toggle in the page during bring-up; test with a crosshair at the four corners. |
| Absolute pointer treated as a joystick (macOS): cursor drifts toward a point, speed depends on distance | Top-level application usage was `Pointer 0x01` instead of `Mouse 0x02`. **[verified — pmj README]** | `Usage(Mouse)` at the application collection; `Usage(Pointer)` only inside. |
| Linux: nothing moves at all | Device tagged as something libinput rejects (tablet with no resolution, touchscreen, joystick) or an old X11 stack. `libinput list-devices` will not show it as a pointer. | Keep it `Mouse`-shaped (buttons + abs X/Y, no `BTN_TOOL_PEN`, no `BTN_TOUCH`); check `ID_INPUT_*` with `udevadm info`. |
| Linux: one of the two mice' buttons don't work | Duplicate `Button 1…5` usages merged into one `input_dev`; second set dropped (`HID_STAT_DUP_DETECTED`). **[verified — kernel source]** | Use separate HID **interfaces** (→ separate `input_dev`s), or give the second collection a distinct button range, or use only one TLC at a time. |
| Works only after replug | Descriptor changed but the host cached the old configuration; or reports sent before `tud_mounted()`; or the host dropped an idle absolute device. | Re-enumerate properly (§5). Send one "position = centre" report on enable. Consider a low-rate heartbeat while in absolute mode — the VUSB `absolute-mouse` library ships `POLL_WITH_TIMER1` because "some operating systems require constant usb polling (every 50 ms)". **[reported]** |
| Absolute + relative fight each other / jitter | Both report IDs being streamed; or one interface merging both into one node and the compositor applying both. | Send exactly one kind per mode; zero out the other. Do not "nudge" with relative while absolute mode is on. |
| Cursor jumps on every click | Some hosts re-assert the last absolute position on button events. | Always send position + buttons in the same report; never send a buttons-only report in absolute mode. |
| libinput calibration matrix unavailable | libinput exposes calibration config for touchscreens/tablets; a device udev tags as a **mouse** is not one of those. | Do the affine transform in the page/firmware, not on the host. **[unverified — inferred from libinput's device-capability model; test with `libinput_device_config_calibration_has_matrix()`]** |
| BIOS/UEFI: absolute does nothing | Firmware has no absolute pointer support; PiKVM: "The BIOS does not support absolute mouse mode". **[verified]** | Keep the relative mouse and document that pad mode is OS-only. |
| Android / some embedded hosts: absolute does nothing | Some hosts only implement relative HID mice (One-KVM maintainer: "some systems … do not support absolute positioning, only relative"). **[reported]** | Fall back to relative automatically if the page sees no movement. |
| Windows: only the primary monitor is reachable | `Mouse`+absolute is primary-only by design (§2.2). | Accept it, or use `Digitizer 0x01` and accept pen semantics, or fall back to relative for other monitors. |
| macOS: only one display reachable | Absolute warping is confined to one display (§2.4). | Same as above. |

---

## 4. Resolution and quantisation

Short answer: **32767 over a 3840-wide desktop is not a problem; a small range is.**

- With `Logical Maximum 32767`, one count = 1/32767 of the desktop. On a 3840-px-wide single monitor
  that is ~0.12 px per count — you cannot see the quantisation. On a 11520-px three-monitor
  desktop it is ~0.35 px. Still invisible.
- With `Logical Maximum 4095` (a common panel-native range), one count ≈ 0.94 px at 3840 and
  ~2.8 px across 11520. That is visible as snapping, and mobile "drag a tiny amount" gestures will
  feel sticky.
- With `Logical Maximum 255` or 0…100: unusable. A 2012 Arduino-forum reply is blunt about this and
  recommends 0…10000 minimum. **[reported]**

What each host does with the range:

- **Windows:** the HID parser normalises the report value into a 16-bit absolute coordinate
  (0…65535) using the descriptor's logical extents; `mouhid` then hands `MOUSE_MOVE_ABSOLUTE`
  coordinates to `mouclass`. ReactOS's clone scales with
  `(value * VIRTUAL_SCREEN_SIZE) / LogicalMax` **[verified — ReactOS source]**. So Windows' internal
  resolution is 16 bit regardless; 32767 loses exactly one bit (steps of 2 in 65535 space).
  Declaring 65535 would be marginally finer and buys nothing.
- **Linux/libinput:** the abs axis range from the descriptor becomes `absinfo.min/max`; libinput
  normalises to `[0,1]` and the compositor multiplies by the layout box in logical pixels.
  Linear, no fixed divisor. **[verified — libinput/wlroots code]**
- **macOS:** `IOHIDElementGetLogicalMin/Max` are read from the descriptor (that is how the
  touch-panel projects do their scaling). No fixed divisor documented. **[reported]**

There is no "right" answer, but there is a wrong one: **do not assume the host divides by 4096 or by
32767**. The only assumptions I could find in the wild are (a) old Windows drivers assuming a
full 16-bit range (the quarter-screen bug), and (b) host *software* (QEMU, GFE, Spice) assuming
0…0x7FFF on its side, which is irrelevant to a real USB device.

Practical rule: **logical max ≥ the widest desktop you want to address, and a power-of-two-ish
16-bit value.** 0…32767 satisfies that for everything up to 32K-wide desktops.

One more range-adjacent trap: PiKVM reports that Windows 7 rejects negative logical minima
(`-32768…32767`) for an absolute mouse. If you ever want a centred range, don't — use 0-based.

---

## 5. Switching modes (`relative` ↔ `absolute`)

### 5.1 What the descriptor change actually costs

The report descriptor is not a separate object at runtime: its **length is baked into the
configuration descriptor** (`TUD_HID_DESCRIPTOR(..., sizeof(hid_report_descriptor), ...)` in
`main/usb_hid.c`), and on this board the configuration descriptor is a `static const` array handed
to `tinyusb_driver_install()` once. So "just swap the report descriptor" is not enough — you must
rebuild both, then force the host to re-read them.

### 5.2 Three strategies, in order of risk

**(a) No switch at all — always advertise both collections.** Ship the absolute collection in the
descriptor from boot and gate at the application layer (which report IDs the page sends). No
re-enumeration, no descriptor rebuild, no risk to the keyboard. Cost: the host always sees an extra
"HID-compliant mouse" child (Windows) / an extra pointer-capable device. PiKVM does exactly this for
its "dual mode" (a second HID interface for the relative mouse) and it is their V4 default — though
their docs say dual mode is "disabled by default for compatibility reasons", which is the honest
trade-off. **[verified — PiKVM docs]** This is what I would do.

**(b) Runtime switch, same descriptor length.** Two report descriptors of identical total length,
one in RAM; flip the pointer and `tud_disconnect()` / `tud_connect()`. Works only if the *config*
descriptor's `wDescriptorLength` and `wTotalLength` do not change — i.e. both variants padded to the
same size. **Problem on this codebase:** `esp_tinyusb` owns
`tud_descriptor_configuration_cb()` and copies the descriptor *pointer* into a static struct at
install time (`descriptors_control.c`, `tinyusb_set_descriptors()`), so you cannot return a different
config descriptor later without re-installing the driver. You would have to write into a mutable
buffer at the same address.

**(c) Full rebuild + re-enumerate.** Rebuild both descriptors into a RAM buffer, then either
`tud_disconnect()/tud_connect()`, or `tinyusb_driver_uninstall()` + `tinyusb_driver_install()`.
PiKVM's equivalent (configfs gadget) does a full gadget rebuild per preset and their docs say "a
complete USB configuration changing (adding or removing devices) requires a reboot" — heavier than
what TinyUSB needs, but the same shape.

### 5.3 TinyUSB / ESP32-S3 pitfalls

- `tud_disconnect()` is just "disable the D+ pull-up" and `tud_connect()` re-enables it. hathach's
  own guidance on changing descriptors mid-flight: "you can use `tud_disconnect()`/`tud_connect()`
  (disable/enable pull-up resistor) which is more lightweight instead of tearing down the whole
  stack." **[verified — TinyUSB discussion #3242]**
- **But on ESP32-S3 no events are delivered after `tud_disconnect()`.** TinyUSB discussion #3331:
  "On ESP32-S3 we're finding that no events are delivered after calling `tud_disconnect()` — as a
  result device drivers still have their connected state". hathach's reply: "in `dcd_disconnect` we
  just disable the pull-up resistor, if we are lucky some port will send an unplugged event", plus a
  proposed patch that resets `usbd` and calls `tud_umount_cb()`. **[verified]**
  Consequence for you: after a soft disconnect, `tud_mounted()` may still return true, so
  `usb_hid_mouse_report()` will happily "send" into an endpoint nobody is polling. Gate on
  `tud_hid_ready()` as well, and drop reports while the switch is in progress.
- The host side takes real time: a re-enumerated HID device typically needs 0.5–2 s before the OS
  re-attaches it (Windows driver re-bind, macOS IOHID re-match). The web page must tolerate a gap
  and re-arm, and should not assume the first report after re-enumeration lands.
- **Same VID/PID + different collection count** is the case where host caching bites: Windows keeps
  per-collection child devices under the same hardware ID. A distinct `bcdDevice` or PID per mode
  makes it unambiguous. **[unverified — standard Windows behaviour, worth testing]**
- `tinyusb_driver_uninstall()` exists in your vendored `esp_tinyusb` and tears down the PHY
  (`usb_del_phy`) and the TinyUSB task; re-install re-creates them. That is the safest "full
  re-init" path, at the cost of ~100 ms. **[verified — vendored source]**
- `CFG_TUD_HID_EP_BUFSIZE` and `HID_EP_SIZE` are 16 here, which comfortably fits both the 5-byte
  relative report (with ID) and the 8-byte absolute report (with ID). No change needed.
- Endpoints: a second HID **interface** costs one more IN endpoint. The S3 has endpoints to spare
  and you currently use one. Fine.
- Don't touch interface 0. Whatever you do, keep the keyboard report ID, the LED output report
  handling (`tud_hid_set_report_cb`) and the boot-protocol flag exactly as they are, so that a bad
  absolute collection cannot take the keyboard with it.

### 5.4 Why a separate interface is the safer blast radius

On both Windows and Linux, HID drivers bind **per interface**, and the report descriptor is
per-interface. If the absolute collection lives in interface 1 and the host decides it is garbage:

- Windows: interface 0's keyboard/mouse keep their children; only interface 1 fails to start
  (yellow bang).
- Linux: `usbhid` probes per interface; a failed `hid-input` on interface 1 does not unbind
  interface 0.

If instead you put the absolute collection in interface 0's report descriptor and get the collection
nesting wrong, the *whole* interface's descriptor is what the host parses, and a malformed
collection can cost you the keyboard. That is precisely the failure the task is worried about.

Cost of a separate interface: one extra endpoint, one extra "HID-compliant mouse" entry on Windows,
and you need the `tud_hid_n_*` instance APIs (`tud_hid_descriptor_report_cb(instance)` already gets
the instance, and `tud_hid_n_report()` / `tud_hid_n_abs_mouse_report()` take it).

---

## 6. Recommendation

### 6.1 Descriptor: Generic Desktop / `Mouse`, 0…32767, separate HID interface

```
Interface 1 (new):  HID, subclass 0, protocol 0, no boot
Report ID 4:        TUD_HID_REPORT_DESC_ABSMOUSE( HID_REPORT_ID(4) )
Report:             buttons:8, x:int16 LE, y:int16 LE, wheel:int8, pan:int8
Logical:            X,Y = 0 … 32767, no unit, no physical min/max
```

Reasons, in priority order:

1. **It is the shape every host has seen before.** QEMU's tablet, PiKVM, Teensyduino and Keyboardio
   all use `GD/Mouse` + absolute X/Y; there is a 20-year compatibility trail. A Digitizer shape has
   a thinner trail and known Linux/macOS cliffs (§2.3, §2.4).
2. **No pen semantics.** No Windows Ink page, no press-and-hold right-click, no drawing apps
   switching to pen mode, no handwriting panel. The cursor stays an ordinary cursor.
3. **Linux is a solved problem for this shape.** udev explicitly has an `is_abs_mouse` branch for
   "VMware's USB mouse … absolute axes, but no touch/pressure button"; libinput has a fallback
   dispatch path for absolute pointer motion.
4. **It is not the *best* shape on Windows multi-monitor.** That is the price: on Windows the pad
   will address the primary monitor only. If that is unacceptable, the *only* fix is the Digitizer
   route (or software on the host), and you inherit pen behaviour. State this as a product
   limitation; do not discover it in the field.

Do **not** use:
- `Digitizer/Touch Screen` — Windows will synthesise touch (press-and-hold, flicks, on-screen
  keyboard), and libinput may take it down the touchscreen path with palm rejection and gestures you
  did not ask for.
- TinyUSB's `STYLUS_PEN` template as-is — its unit item is wrong; copy QMK's descriptor if you ever
  need a pen.
- `Usage(Pointer)` as the application collection — macOS turns it into an analog stick.

Range: **0…32767, 16-bit, both axes always present in the same report.** Do not use 4095, do not use
a pixel-sized range, do not use negative minima.

### 6.2 Keep the relative mouse

Yes, keep it, in interface 0, untouched. Reasons:

- BIOS/UEFI and Android-class hosts have no absolute support (PiKVM's entire "relative mode"
  feature exists for this).
- It is the fallback when the pad's mapping is wrong, without re-flashing.
- It is the "move the cursor a bit" control for small corrections, which an absolute pad is bad at.

But: **never stream both at once.** Pick a mode in the page, and zero the other. Also keep the two in
**separate interfaces** if you can, because of the duplicate-usage merge on Linux (§2.3) — with one
interface, the second mouse's `Button 1…5` are dropped by `hid-input`, and the two sets of wheel
usages collide too.

Trade-off to accept consciously: two mouse collections means two "HID-compliant mouse" children on
Windows. PiKVM ships that and calls it a compatibility risk for BIOS/NVR devices — they keep it off
by default.

### 6.3 Toggle: don't toggle

Advertise the absolute interface permanently; switch behaviour at the application layer. This is
option (a) in §5.2. It removes re-enumeration, host caching, driver re-bind and "works after replug"
from the risk list entirely, and it means the keyboard never depends on the switch working.

If you later decide the extra device entry is unacceptable, then do the full rebuild:
build both descriptors into a mutable RAM buffer, keep `wTotalLength`/`wDescriptorLength` computed
from the buffer, `tinyusb_driver_uninstall()` + `tinyusb_driver_install()`, and treat the next ~1 s
as "not mounted". Do not attempt a partial `tud_disconnect()` dance on the S3 without also handling
the missing bus-reset event.

### 6.4 What to test first on hardware, in this order

1. **Enumeration survival.** Flash with interface 1 added. Keyboard types on all three OSes; Caps
   Lock LED still round-trips (`tud_hid_set_report_cb`); relative mouse still moves. If any of these
   regress, the descriptor is wrong and nothing else matters.
2. **Linux, with `libinput` as the oracle.**
   `udevadm info /dev/input/eventN` → expect `ID_INPUT_MOUSE=1`, **not** `ID_INPUT_TABLET` /
   `ID_INPUT_TOUCHSCREEN`. `sudo libinput list-devices` → capabilities `pointer`.
   `sudo libinput debug-events` → look for `POINTER_MOTION_ABSOLUTE`. `dmesg | grep -i "usages could
   not be mapped"` → the duplicate-usage warning.
3. **Windows device topology.** Device Manager → Human Interface Devices. Count the
   "HID-compliant mouse" entries (expect 2). Check nothing appears as `HID-compliant pen` /
   `digitizer` / `touch screen`. Then two monitors: does the pad reach monitor 2? (Expect **no** —
   record it.)
4. **macOS.** `ioreg -r -c IOHIDDevice` to confirm the collection usage and the logical max; then
   test on the second display and note the confinement.
5. **Coordinate correctness.** Send the four corners and the centre; measure the landing pixel on
   each OS. This is where off-by-one and Y-inversion show up, and it is cheap to automate with a
   full-screen crosshair.
6. **Persistence / latency.** Does it still work after the host sleeps and wakes, after a page
   reload, after 10 minutes idle (heartbeat question), and in the BIOS (expected: no).
7. **Only then** the hostile cases: a game with pointer lock / raw input, a UAC prompt, a Remote
   Desktop session, and a mixed-DPI two-monitor Windows layout.

---

## 7. Gaps in the evidence

Places where I could not find a trustworthy answer and you should not treat my text as fact:

1. **Windows, current build, absolute HID *mouse* on multi-monitor.** The primary-monitor claim is
   well supported by a 2007 OSR thread, a 2023 VHF experiment, MS GDI docs, and ReactOS source — but
   I did not find a recent Microsoft statement about HID-class absolute mice specifically, and
   VirtualBox's tablet demonstrably works across three monitors in a Windows guest after their 7.0.4
   fix. VirtualBox's fix may be host-side coordinate rewriting, or Windows may have changed. **Test
   this first; it decides the whole design.**
2. **macOS multi-monitor behaviour for a `GD/Mouse` absolute device.** "Confined to one display" is
   inferred from a maintainer's recollection plus a user's observation, both about Kaleidoscope's
   warping. No Apple documentation found. Also unverified: whether macOS applies any scaling for
   mixed DPI on this path.
3. **macOS + `Digitizer` from a DIY device.** No data. Two projects exist precisely because macOS
   does nothing useful with `Digitizer/Touch Screen`; whether `Digitizer/Pen` gets the tablet path
   without a Wacom-class vendor ID is unknown.
4. **GNOME/mutter's mapping of absolute pointer motion.** I verified wlroots only.
5. **Whether libinput's calibration matrix is available for a mouse-class absolute device.** I
   believe not (calibration is a touch/tablet capability) but I did not find a definitive statement.
6. **Games / raw input with a real absolute HID mouse.** Strongly suspected to be bad; the closest
   evidence is about software-injected cursors, not HID. Needs a real test (any FPS with raw input).
7. **Windows digitizer + logical range.** The VHF examples use 0…65535 for the pen route; I did not
   verify whether 0…32767 behaves identically. Assume it scales, but test if you go that way.
8. **`HID_QUIRK_INPUT_PER_APP` provenance.** The kernel honours the quirk but I could not find where
   it is set generically (it is not in `hid-quirks.c` in the tree I read), so I cannot promise any
   particular device gets split per collection. The safe assumption is "one interface = one
   `input_dev`".
