// Drives `vorbis.wasm` from JavaScript, for whichever host holds the bytes.
//
// ONE DRIVER RATHER THAN TWO, because there are two JavaScript hosts - the page
// and the golden's hasher - and the whole argument for this decoder is that
// every host computes the same samples. Two copies of the memory arithmetic
// below would be two chances to disagree about a module neither of them can
// see into, and `docs/decisions.md` already records what a hand-mirrored layout
// costs when it drifts.
//
// It knows nothing about the console, exactly as `vorbis.h` does not: it
// reports what the stream held and refuses nothing on grounds of rate or
// layout. A caller with a narrower requirement than the decoder's supported set
// checks `info` and says so itself.
//
// Loaded the way `player.js` is - a classic script in a browser, a CommonJS
// module under node - so the site needs no module MIME rules and node needs no
// package.json in the deployable.

// `Vorbis_Info` is three 32-bit fields, hand-mirrored here. The header pins its
// size with a `static_assert`, which guards C and says nothing about this file;
// what guards this one is that a wrong offset yields a rate or a channel count
// no caller accepts, and every caller checks both.

const VORBIS_INFO_BYTES = 16;
const VORBIS_INFO_FRAMES = 0;
const VORBIS_INFO_CHANNELS = 4;
const VORBIS_INFO_SAMPLE_RATE = 8;
const VORBIS_INFO_SCRATCH_BYTES = 12;

// `Vorbis_Error`, for turning a refusal back into the sentence the C would
// have printed. Kept as numbers rather than read out of the module, because
// `vorbis_error_string` returns a pointer into its memory and reading it would
// be a second piece of string plumbing for four constants.

const VORBIS_ERRORS = {
    1: "not a readable Ogg Vorbis stream",
    2: "not a supported rate or channel layout",
    3: "the decoder's scratch was too small",
    4: "the output buffer was too small",
};

class Vorbis {
    // `bytes` is the built `vorbis.wasm`. Instantiation is synchronous, which
    // is legal for a module this size and keeps every caller off promises they
    // would otherwise have to thread through their own load path.
    constructor (bytes) {
        const module_ = new WebAssembly.Module (bytes);

        const imports = WebAssembly.Module.imports (module_);

        if (imports.length) {
            throw new Error (`vorbis.wasm declares ${imports.length} import(s); `
                + `it is built to declare none`);
        }

        this.exports = new WebAssembly.Instance (module_, {}).exports;

        // Above `__heap_base`, like every other host here places things: the
        // module's own statics end there and nothing it does will write past
        // it, so anything above is the caller's.
        this.top = this.exports.__heap_base.value;
    }

    // A fresh view every time, because growing linear memory detaches the last
    // one and the growth is exactly what a large track provokes.
    view () {
        return new DataView (this.exports.memory.buffer);
    }

    // ALIGNED WITH ARITHMETIC RATHER THAN WITH BITS, and that is a fix rather
    // than a preference. `(top + 15) & ~15` reads as the obvious idiom, but
    // JavaScript's bitwise operators coerce to SIGNED 32-bit, so the offset
    // wraps negative once the bump pointer passes 2048 MB: measured, 2147378790
    // aligns to 2147378800 and 2147483648 aligns to -2147483648. Through
    // `decode` that surfaced as `Start offset -34469760 is outside the bounds
    // of the buffer`, an error naming nothing a reader could act on. `Math.ceil`
    // is exact to 2^53 and cannot wrap at any size this will ever be handed.
    //
    // What it takes to reach is roughly 373 minutes of audio against an engine
    // ceiling near 4095 MB, so no track will get there - but an allocator whose
    // failure mode is a negative pointer is worth one line of arithmetic.
    //
    // Growth FAILS BY THROWING here, which is worth stating because the other
    // spelling is so nearly right: the wasm instruction `memory.grow` returns
    // -1 on failure, and `WebAssembly.Memory.prototype.grow` - this one -
    // raises a RangeError instead. So there is no return code to test, and the
    // only question is what the caller is told. The engine's own text names
    // neither this decoder nor what the memory was for, so it is rethrown in
    // words that do.
    alloc (size) {
        const at = Math.ceil (this.top / 16) * 16;
        const needed = at + size;
        const have = this.exports.memory.buffer.byteLength;

        if (needed > have) {
            const pages = Math.ceil ((needed - have) / 65536);

            try { this.exports.memory.grow (pages); }
            catch (error) {
                throw new Error (`the decoder could not reserve ${size} more `
                    + `bytes of working memory: ${error.message}`);
            }
        }

        this.top = needed;

        return at;
    }

    // Decodes a whole stream and returns `{ frames, channels, sampleRate,
    // samples }`, where `samples` is an `Int16Array` COPIED out of the module.
    // Copied rather than viewed, because the next call's `alloc` may grow the
    // memory and detach any view handed out before it.
    //
    // Throws on refusal, carrying the decoder's own reason.
    //
    // The bump pointer is restored in a `finally` rather than at each exit,
    // because one of the exits is not written down: `alloc` throws when the
    // memory cannot grow, which skips every hand-placed reset after it. That
    // left the mark permanently raised on a decoder the caller keeps - and
    // `player.js` keeps one per page - so a track that failed for want of
    // memory made the next attempt start higher and fail sooner. Measured at
    // 9,282 bytes leaked per failed attempt, compounding.
    decode (ogg) {
        const mark = this.top;

        try { return this.#run (ogg); }
        finally { this.top = mark; }
    }

    // Private because calling it is the bug `decode` exists to prevent: this
    // is the body with the arena restore taken off. Enforced rather than
    // asked for, since a guard that can be stepped around is not a guard.
    #run (ogg) {
        // Examined on the bootstrap buffer, then decoded on one sized from
        // what the examine reported - about 59% of the bootstrap on the
        // streams measured so far.
        //
        // This is memory, not reach: examining a stream costs exactly what
        // decoding it costs, measured, so a stream too large for the bootstrap
        // is already refused by the examine above. See `vorbis.c`.
        const examineBytes = this.exports.vorbis_scratch_size ();

        const oggAt = this.alloc (ogg.length);
        const examineAt = this.alloc (examineBytes);
        const infoAt = this.alloc (VORBIS_INFO_BYTES);
        const errorAt = this.alloc (4);

        new Uint8Array (this.exports.memory.buffer, oggAt, ogg.length).set (ogg);

        const examined = this.exports.vorbis_examine (oggAt, ogg.length,
            examineAt, examineBytes, infoAt, errorAt);

        if (! examined) {
            const error = this.view ().getInt32 (errorAt, true);

            throw new Error (VORBIS_ERRORS [error] || `error ${error}`);
        }

        const info = this.info (infoAt);
        const count = info.frames * info.channels;
        const scratchAt = this.alloc (info.scratchBytes);
        const samplesAt = this.alloc (count * 2);

        const decoded = this.exports.vorbis_decode (oggAt, ogg.length,
            scratchAt, info.scratchBytes, samplesAt, count, infoAt, errorAt);

        if (! decoded) {
            const error = this.view ().getInt32 (errorAt, true);

            throw new Error (VORBIS_ERRORS [error] || `error ${error}`);
        }

        const samples = new Int16Array (
            this.exports.memory.buffer.slice (samplesAt, samplesAt + count * 2));

        return { ...info, samples };
    }

    info (at) {
        const view = this.view ();

        return {
            frames: view.getUint32 (at + VORBIS_INFO_FRAMES, true),
            channels: view.getInt32 (at + VORBIS_INFO_CHANNELS, true),
            sampleRate: view.getUint32 (at + VORBIS_INFO_SAMPLE_RATE, true),
            scratchBytes: view.getUint32 (at + VORBIS_INFO_SCRATCH_BYTES, true),
        };
    }
}

// An asynchronous front for `Vorbis`, so a caller need not know which thread
// the decode ran on.
//
// A three-minute track is one to three seconds of arithmetic, and on a page's
// own thread that is the game frozen for all of it - so a browser gets a
// worker and every other host calls the same function directly. WHICH ONE RUNS
// IS THE ONLY DIFFERENCE: the samples are `Vorbis.decode`'s either way, which
// is what keeps the offload outside the reproducibility argument entirely.
// Delivery is frame-stamped whenever the samples land, so a slow decode and a
// fast one reproduce the same run.
//
// THE OFFLOAD IS THE ONE PART NO TEST RUNS. `typeof Worker` is undefined under
// node, so `ctest` takes the inline branch end to end and exercises the same
// decode a browser reaches through two message hops. That is the hole
// `cmake/WebPlayerPlays.cmake` prices for the `AudioContext` and the worklet,
// and this joins it deliberately rather than by omission - the alternative is
// a decode that visibly freezes the page, which is worse than a wrapper
// somebody has to read.

class VorbisDecoder {
    // `wasmBytes` is the built module. `workerUrl` is where `vorbis.worker.js`
    // sits, or null for a host that has no worker to offload to.
    constructor (wasmBytes, workerUrl) {
        this.wasmBytes = wasmBytes;
        this.workerUrl = workerUrl || null;
        this.inline = null;
        this.worker = null;
        this.primed = false;
        this.next = 1;
        this.pending = new Map ();
    }

    // Whether a decode will leave this thread. Nothing about the samples
    // depends on the answer; a host may report it, and nothing may branch on
    // it in a way a replay would see.
    offloads () {
        return typeof Worker !== "undefined" && this.workerUrl !== null;
    }

    decode (ogg) {
        if (this.offloads ()) { return this.offload (ogg); }

        try {
            if (! this.inline) { this.inline = new Vorbis (this.wasmBytes); }

            return Promise.resolve (this.inline.decode (ogg));
        }
        catch (error) { return Promise.reject (error); }
    }

    // The ogg goes across TRANSFERRED rather than copied, and the samples come
    // back the same way: a three-minute track is seventeen megabytes of PCM,
    // and a structured clone of it would cost more than the decode did. The
    // caller's `ogg` is detached by this and must not be read afterwards.
    //
    // The module's own bytes are the exception and are copied, once, with the
    // first decode. Transferring them would leave the inline fallback with
    // nothing to build from, and sixty kilobytes one time is not worth a
    // second code path.
    offload (ogg) {
        if (! this.worker) { this.start (); }

        const id = this.next++;

        const message = {
            id,
            ogg: ogg.buffer,
            at: ogg.byteOffset,
            size: ogg.byteLength,
        };

        const transfer = [ogg.buffer];

        if (! this.primed) {
            message.wasm = this.wasmBytes.slice ().buffer;
            this.primed = true;
        }

        return new Promise ((resolve, reject) => {
            this.pending.set (id, { resolve, reject });

            this.worker.postMessage (message, transfer);
        });
    }

    start () {
        this.worker = new Worker (this.workerUrl);

        this.worker.onmessage = (event) => {
            const { id, track, error } = event.data;
            const waiting = this.pending.get (id);

            if (! waiting) { return; }

            this.pending.delete (id);

            if (error) { waiting.reject (new Error (error)); }
            else { waiting.resolve (track); }
        };

        // A worker that fails to start fails every decode waiting on it, and
        // there is no retry: whatever stopped it starting will not have
        // changed. Rejecting is what turns this into a slot the game sees as
        // failed rather than one it waits on for the rest of the run.
        this.worker.onerror = (event) => {
            const reason = new Error (event.message
                || `the decoder worker did not start from ${this.workerUrl}`);

            for (const waiting of this.pending.values ()) {
                waiting.reject (reason);
            }

            this.pending.clear ();
        };
    }
}

if (typeof module !== "undefined") {
    module.exports = { Vorbis, VorbisDecoder, VORBIS_INFO_BYTES, VORBIS_ERRORS };
}
