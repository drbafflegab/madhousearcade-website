// The thread a task body runs on in a browser.
//
// It exists for two reasons now. A body is seconds of work by design - an
// opponent's search, a solver, a solvability proof - and on the page's own
// thread those are seconds the game is frozen for. And a body READS FILES, with
// a call that blocks until the bytes are there, so it needs a thread it is
// allowed to block: a synchronous `XMLHttpRequest` is legal in a dedicated
// worker and is not on the page's thread, which is what makes this file the
// only place a loader's `load` can be answered at all.
//
// Nothing it computes differs from the inline path, because it is the same
// `runTaskBody` reached through two message hops, so a replay reproduces the
// same run whichever thread served it. Delivery is frame-stamped whenever the
// output lands, which is why the wait costs determinism nothing.
//
// It knows nothing about the console and nothing about a frame. What it is sent
// is three compiled modules - the game's, the host's own trampoline and the
// rulebook - a resource directory, a descriptor and an input; what it sends
// back is the bytes the body wrote, or a null and a line saying why there are
// none, plus what the body read on its way. Which of those becomes the null the
// runner's `bytes` answers with is the session's business, and the session is on
// the other thread.
//
// THE RULEBOOK IS HERE FOR ONE RULE and no session at all. A body reads files,
// and the six shape-and-length rules a `Game_Resource` is held to are spent
// inside the read that named one - on this thread, in the body's own instance,
// where the strings live. Everything else `products/host-core` owns is about a
// TASK rather than about a body: the table, an id's validity, the release table
// and the runner's stamps all belong to the session, and a body's own `spawn`,
// `done`, `bytes` and `release` are inert wrappers because `interface/game.h`
// says a body reads
// files and cannot spawn. So what crosses is a compiled module, and this thread
// instantiates a memory of its own for it.
//
// A classic worker rather than a module one, for the reason `player.js` is a
// classic script: `importScripts` needs no MIME rules on somebody's static
// host, and the files it names sit beside this one because the site copies them
// all to the same directory. `vorbis.worker.js` is the same shape one subsystem
// over, and deliberately so - one spelling in this tree for "offload to a
// worker", not two.

// `player.js` and nothing else. Every host rule a body's read is held to - the
// grammar, the status check, the decode, the abandonment - is in that file, so
// this one stays a shell over `runTaskBody` rather than a second copy of it.
//
// `vorbis.js` is deliberately NOT here. `resourceReader` reaches for it with a
// second `importScripts` the first time a body asks for a compressed resource,
// so a game that reads none fetches neither the decoder's driver nor its
// module - which is the rule the page already kept when it did the fetching.
importScripts ('player.js');

// The two modules the first task carried, kept for every task after it.
// Compiled on the other thread and cloned across rather than re-read from
// bytes, so a worker never compiles what the page has already compiled; a
// `WebAssembly.Module` is cloneable to a dedicated worker because the two share
// an agent cluster - measured in
// `docs/archived/unified-tasks-phase0/probes.md` section 1, on node and in
// Chrome, where the clone surcharge turned out to be independent of module size.
//
// Two rather than one, because a game imports nothing: a body's own instance
// has to be given `load` through its table before the loader record it is
// handed points at anything, and `runTaskBody` is what does that with the
// second of these. It rides in the same message for the same reason the first
// does.
//
// `TaskRunner` starts a worker per task and ends it at the answer, so in
// practice the first task is the only task and this holds a module for the
// length of one body. The protocol is per MESSAGE all the same rather than per
// worker, and deliberately: it costs one variable, it is what let this file go
// unchanged through a reversal of who runs a body, and it is what
// `products/web-player/tests/tasks.js` drives the shipped file with.

let held = null;
let heldTrampoline = null;
let heldCore = null;

// Where this session's resources are, and the reader built over it. Both arrive
// with the module in the task's own message and neither ever changes: a session
// is one game against one directory, and a page that switches either builds a
// new session.
//
// Null until then, and null for a page that named no directory - which is not a
// state `TaskRunner` can produce, since a session always resolves one, but is
// the honest answer for a worker asked to run a body before it was told
// anything. A body that reads with no reader behind it is abandoned naming a
// host pointed at no resources at all, which is what `console.c` says in the
// same position.

let read = null;

self.onmessage = (event) => {
    const { id, module, trampoline, core, task, input, resources } = event.data;

    if (module) {
        held = module;
        heldTrampoline = trampoline;
        heldCore = new HostCore (core);

        // Against this worker's OWN url for the decoder and the message's
        // directory for the game's files, which is the same split `player.js`
        // kept when the page did the fetching: a resource belongs to one game
        // and sits beside it, where the decoder belongs to the player and one
        // page plays every game.
        read = resources
            ? resourceReader (resources, self.location.href)
            : null;
    }

    if (! held) {
        // Not reachable through `TaskRunner`, which carries the module in the
        // one message it sends a worker. Answered rather than thrown all the
        // same, because a body that cannot be run and a body that trapped are
        // one condition to the game - no output is coming - and a throw here
        // would leave the session waiting for a message that never arrives.
        self.postMessage ({ id, output: null, reads: [],
            note: 'the worker was sent a task before a module' });

        return;
    }

    const answer = runTaskBody (held, heldTrampoline, heldCore, task, input,
        read);

    // Transferred rather than copied, as the decoder's samples are: an output
    // is whatever size its author declared, and a task that answers with a
    // table is the case this subsystem exists for.
    //
    // `reads` goes across copied, because it is a handful of short strings and
    // a host's account of what happened rather than the answer.
    self.postMessage (
        { id, output: answer.output, note: answer.note, reads: answer.reads },
        answer.output ? [answer.output.buffer] : []);
};
