// The thread a decode runs on in a browser.
//
// It exists for one reason: a three-minute track is one to three seconds of
// arithmetic, and on the page's own thread that is the game frozen for all of
// it. Nothing it computes differs from the inline path - it is the same
// `Vorbis.decode`, reached through two message hops - so a replay reproduces
// the same run whichever thread served it. Delivery is frame-stamped whenever
// the samples land, which is why the wait costs determinism nothing and why
// this file is free to be the one thing here no test executes.
//
// It knows nothing about the console, exactly as `vorbis.js` does not: it
// reports what the stream held and refuses nothing on grounds of rate or
// layout. The host that has a console to satisfy checks `info` itself.
//
// A classic worker rather than a module one, for the reason `player.js` is a
// classic script: `importScripts` needs no MIME rules on somebody's static
// host, and the file it names sits beside this one because the site copies
// both to the same directory.

importScripts ('vorbis.js');

// Built from the bytes the first decode carries and then kept, so a game with
// several tracks compiles the module once rather than once a track.

let vorbis = null;

self.onmessage = (event) => {
    const { id, wasm, ogg, at, size } = event.data;

    try {
        if (wasm) { vorbis = new Vorbis (new Uint8Array (wasm)); }

        if (! vorbis) {
            throw new Error ('the worker was sent a decode before a module');
        }

        // `at` and `size` rather than the whole buffer, because a transfer
        // moves the buffer and loses the view that described which part of it
        // was the caller's.
        const track = vorbis.decode (new Uint8Array (ogg, at, size));

        // Transferred, not copied. This is the seventeen megabytes.
        self.postMessage ({ id, track }, [track.samples.buffer]);
    }
    catch (error) {
        // The message rather than the error, because an `Error` does not
        // survive a structured clone with its message intact everywhere, and
        // the message is the whole of what the host reports.
        self.postMessage ({ id, error: error.message });
    }
};
