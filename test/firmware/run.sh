#!/usr/bin/env bash
# Host tests for the firmware modules that carry real logic.
#
# No ESP-IDF, no cross compiler, no USB stack: the ESP-IDF headers these files
# include are replaced by test/firmware/stubs, and the USB, panel and filesystem
# boundaries by recording fakes. A full run takes about a second.
#
#   test/firmware/run.sh
#
# CC and CFLAGS can be overridden from the environment.
set -euo pipefail

cd "$(dirname "$0")"

CC=${CC:-cc}
CFLAGS=${CFLAGS:--std=gnu11 -O1 -g -Wall -Wextra -Werror}
CPPFLAGS="-I. -Istubs -I../../main"
BUILD=build

mkdir -p "$BUILD"

failed=0

build_and_run() {
    local name=$1
    shift

    if ! "$CC" $CFLAGS $CPPFLAGS "$@" -o "$BUILD/$name"; then
        echo "FAIL build: $name" >&2
        failed=1
        return
    fi

    printf '\n== %s ==\n' "$name"
    if ! "$BUILD/$name"; then
        failed=1
    fi
}

build_and_run test_input_state \
    test_input_state.c fake_usb_hid.c fake_clock.c ../../main/input_state.c

build_and_run test_screen_image \
    test_screen_image.c fake_screen_deps.c ../../main/screen_image.c

build_and_run test_qr_payload \
    test_qr_payload.c ../../main/qr_payload.c

if [ "$failed" -ne 0 ]; then
    echo
    echo "firmware tests FAILED" >&2
    exit 1
fi

echo
echo "firmware tests passed"
