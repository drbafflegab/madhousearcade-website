// The thread the simulation runs on, and no longer the thread the picture is
// drawn on.
//
// `construct`, `step`, the task table, the runner's records, the input queue,
// the recorder and the clock all live here; the page keeps the canvas ELEMENT
// and its CSS box, the audio context, the listeners, the halt table and the
// store; and `render_video` runs a thread further out, in `render.worker.js`,
// on a second instance of the module this one posts descriptions to. THIS
// THREAD OWNS NO CANVAS AND HAS NO DRAWING PATH AT ALL - not a fallback, not a
// first frame - which is `docs/archived/render-worker-plan.md`'s third question
// answered: one path is what lets this tree say what a frame is, and a fallback
// nothing exercises is a fallback that rots.
//
// It exists for the three things a main-thread loop cannot do. A `step` that
// never returns wedges the page with nothing able to say so, and here it wedges
// a thread the page can terminate and report on - which is `docs/decisions.md`
// pending item 10, and `Watchdog` in `player.js` is the page's half of it: this
// thread posts a frame message per display frame, and a run of them with nothing
// coming back is what the page reads as a hang. A main thread stalled by layout,
// a collection or an extension stalls the simulation with it; here it does not,
// and neither the sound nor the picture has a producer on that path.
//
// WHAT THE PICTURE MOVING OUT COSTS is one display frame, and it is paid rather
// than avoided: a description posted from here is drawn on the next turn of
// another thread's event loop, which measured about 26 ms from publish to
// pixels against 8.84 ms for drawing here. What it buys is that a renderer that
// never returns wedges a RENDERER. `docs/archived/render-worker-plan.md` argues
// the trade and holds every figure.
//
// THE CLOCK IS THE DISPLAY'S. This worker asks for its own animation frames and
// runs `Clock` on the timestamp it is given, so there is nothing to estimate and
// no model to be wrong - the page used to post its timestamps here and a
// phase-locked timer used to guess at where the next one would fall, and
// `player.js`'s clock comment carries both and why neither is left. The display
// is not the simulation's rate: `docs/runs/drawing-worker-run.md` read one panel
// at 120 Hz and at 60, so a callback steps whatever the accumulator says, which
// is often no step at all. It is still asked for HERE rather than on the thread
// that draws, because the clock belongs to the run and the renderer holds no
// loop of its own.
//
// A classic worker rather than a module one, for the reason `task.worker.js` is:
// `importScripts` needs no MIME rules on somebody's static host, and the file it
// names sits beside this one because the site copies them all to the same
// directory. One spelling in this tree for "offload to a worker", not four.
//
// WHAT IT DOES NOT DO. It renders no sound and no picture: two consumers do
// that, out of the descriptions every step captures, each on a thread of its
// own and each down a `MessagePort` the page made and handed away - so the only
// thread between a step and a speaker, or a step and a pixel, is this one. And
// it holds no store: `localStorage` does not exist on this thread, so what it
// sends is the BLOB - `save` on the live state, once before frame 0 and then on
// every frame whose report carried `game_report_save` - and the page keeps the
// newest one and writes it. It writes no recording either, for the harder
// version of the same reason: a recording is wanted most by a page whose
// simulation has stopped answering, so what this sends is the entries its logs
// GREW BY, every frame, and the page composes the file out of a record it has
// been holding all along. Both are the same move - hold what a closing or a
// wedged page will need, so there is no round trip left to take.
//
// TWO CONSUMERS AGAIN, and they are fed on two different cadences. The speaker
// is handed the state of every STEP a tick ran, because a skipped 800 samples is
// a hole; the renderer is handed one description per TICK that drew, because a
// skipped picture is invisible. So a catch-up of eight steps is eight messages
// to the speaker, one to the renderer and one frame on the canvas.
// `docs/archived/threaded-host-plan.md` is where that asymmetry was argued and
// `player.js`'s `Consumer` is what reads both ends of it.

// `player.js` and nothing else, which is the whole of what this file is a shell
// over: `Session`, `Input`, `Clock`, `TaskRunner` and the arena are all that one
// file's, so this is a message protocol and no second host.
importScripts ('player.js');

// The run, or null before the page has opened one. Everything below answers for
// a session that may not exist yet, because the page reads the module's
// declaration and arms its listeners before the `open` message is sent.

let session = null;
let input = null;
let clock = null;

// What each consumer has been handed, by task id - `freshDeliveries`'s own
// bookkeeping, held here because release is a consumer's own and local.
//
// ONE MAP PER CONSUMER, and there are two: the speaker and the renderer hold
// separate copies of a block at the same address in separate memories, so a
// delivery is owed to each of them separately and neither map may answer for
// the other. What that costs is one copy of a block per consumer, once, on the
// frame the block first appears - which is what `bytesAt` was already making
// for the one consumer this file had.

let heldByAudio = new Map ();
let heldByScreen = new Map ();

// How much of each replay log the page has already been told about. The same
// bookkeeping as the two maps above and for the same reason: the page keeps a
// record of its own and this thread sends only what it has not sent, so what
// crosses per frame is what the run just did rather than everything it has ever
// done.
//
// THE PAGE HOLDS THE RECORD, and that is not tidiness. Mark used to be a round
// trip - the page asked, this thread answered - and a `step` that never returns
// answers no message at all, so the one moment the page most needs a recording
// is the one moment it could not have got one. It is the same move `writeSave`
// makes one file over: hold what a closing or a wedged page will need, so there
// is no round trip left to take. `player.js`'s `markText` is what composes it.

let reported = { input: 0, tap: 0, task: 0, pointer: 0 };

// Everything the four logs have grown by since the last frame message. Called
// wherever one is posted, including where nothing stepped - the arrays are empty
// then, and a frame message with no records on it is what a page reading them
// unconditionally needs.

const freshRecords = () => {
    const take = (log, name) => {
        const entries = log.slice (reported [name]);

        reported [name] = log.length;

        return entries;
    };

    return {
        input: take (session.inputLog, 'input'),
        tap: take (session.tapLog, 'tap'),
        task: take (session.taskLog, 'task'),
        pointer: take (session.pointerLog, 'pointer'),
    };
};

// The worklet's end of the channel the page made, or null on a page whose
// worklet never arrived - which the page says in as many words, because a port
// nothing drains is a state block a tick that is never freed.

let audioPort = null;

// The states one tick owes the SPEAKER, one per step it ran, with null for a
// step the game reported silent and for every step of a game that renders no
// sound at all. Filled by `Clock`'s own audio callback, which is called once
// per step, and emptied where the tick is posted.
//
// Copied per step rather than per tick because that is what the audio clock
// buys: tick N occupies output frames [800N, 800N + 800), so a step whose state
// was never published is 800 samples of hole. It costs a copy of the SOUND
// DESCRIPTION per step and nothing else - 24 bytes for `games/pong` against a
// state block of 96, and 48 for `games/suika` against 5,984 - which is what the
// descriptions bought here: `docs/decisions.md:494` priced the state block at
// 256 KB a frame and 0.034% of a core. Nothing is copied at all on a page with
// no worklet.

let audio = [];

// The wall clock instant the last frame stepped to, so that a clock cannot be
// handed an interval it has already spent. `Clock` accumulates `now - last` and
// a negative one would give the game back time it had already been paid.
//
// ZERO IS ALSO REFUSED BY IT, and that is deliberate rather than incidental.
// `Clock.advance` spells "no previous timestamp" as a falsy `last`, so a clock
// handed zero primes twice and loses a tick - `products/web-player/tests/loop.js`
// says so where it chooses its own origin. An animation frame's timestamp is
// never zero by the time a module has been fetched; the fallback timer's reading
// could be, and this is where that difference stops.

let advanced = 0;

// How far this thread's clock has to be moved to be the PAGE's clock, in
// milliseconds, and it is a subtraction rather than a model.
//
// A dedicated worker's time origin is its own creation and not the document's,
// so `performance.now ()` here and `performance.now ()` there are the same unit
// and not the same zero - and an animation-frame callback on this thread is
// handed a timestamp on THIS thread's zero, which was measured for this
// milestone rather than recalled: a worker's `requestAnimationFrame` argument
// sat 0.3 ms from its own `performance.now ()` over 30 frames in Chrome 152,
// with the two origins 31.2 ms apart.
//
// That gap is not academic. Every input event is stamped with the browser's own
// `event.timeStamp`, which is on the PAGE's zero, and `Clock` drains the input
// queue up to the boundary its own timestamps put it at - so a clock run on this
// thread's zero would hold every press for exactly the interval between the
// document being created and this worker being started, which is however long
// the page took to fetch a module. Measured on the shipped page before this was
// fixed: press to the record's arrival read 14.2 ms on one load and 58.5 ms on
// the next, against 29.5 for the page that posted its own timestamps.
//
// `performance.timeOrigin` is the absolute instant each zero stands at, so the
// difference of the two is exact and is taken once, at `open`. Zero for a host
// that names none - `products/web-player/tests/plays.js` and `watchdog.js` drive
// this thread on timestamps they choose for both halves, and there is one clock
// there to be on.

let originShift = 0;

// The renderer's end of the second channel the page made, or null on a host
// that brokered none - a harness driving this thread for something other than
// its pixels, which `products/web-player/tests/watchdog.js` does twice.
//
// It is posted before the first tick rather than when the render worker is
// ready, for the reason the speaker's is: a port holds what is posted to it and
// a transferred port carries its queue with it, so the frames a run draws while
// the renderer is still compiling are drawn rather than dropped.
//
// NOTHING IS EVER RECEIVED ON IT. The channel runs one way, exactly as the
// speaker's does, because a consumer that answered would be a consumer the
// simulation waited on - and `docs/archived/render-worker-plan.md`'s whole
// containment argument is that it waits on none. A renderer that has stopped
// answering is something the PAGE notices, out of a heartbeat this thread never
// sees.

let screenPort = null;

// What the tick owes the speaker, down the page's channel: every block the
// worklet has not been handed, and then one message per step the tick ran.
//
// ONE MESSAGE PER STEP, which is exactly the shape the page posted when it was
// the one forwarding samples: a silent step is a message with no bytes on it and
// still takes a slot, because what the queue on the far side holds is TIME. A
// step dropped instead would drain 800 samples early and put every later sound
// ahead of the frame it belongs to.
//
// Every buffer is transferred, and every one of them was made by `slice` for
// that: the session goes on holding its own bytes.
//
// Nothing at all on a page with no worklet - `audio` is empty then, because the
// callback that fills it asks the same question.

// What one step owes the speaker: the sound description the game captured after
// it, and never the state block, which no host has handed a renderer since a
// module describing none stopped loading.
//
// A description is what makes this copy small and makes it mean something on
// its own: `games/suika`'s state block is 5,984 bytes and every game's sound
// description in the tree is under a hundred.

const soundOf = (session) => ({ audioState: session.audioStateBytes () });

const sound = (deliveries) => {
    if (! audioPort) { audio = []; return; }

    for (const region of deliveries) {
        audioPort.postMessage ({ id: region.id, address: region.address,
            bytes: region.bytes }, [region.bytes.buffer]);
    }

    for (const tick of audio) {
        if (! tick) { audioPort.postMessage ({ silent: true }); continue; }

        // Written out rather than composed, so that the shape a worklet reads
        // is a shape a reader of this file can see - which is also what
        // `products/web-player/tests/worklet.js`'s seam check reads, field by
        // field, out of this source.
        audioPort.postMessage ({ audioState: tick.audioState },
            [tick.audioState.buffer]);
    }

    audio = [];
};

// What the tick owes the RENDERER, down the page's second channel: every block
// the render worker has not been handed, and then the one description the
// picture is a function of.
//
// THE DELIVERY RULE, which is the speaker's rule one channel over and is the
// reason the two posts are in this order and in this function rather than at
// two call sites. A description names a task by ID where a state block carried
// a pointer, so a description naming an id whose bytes the far side does not
// hold is a picture drawn out of zeros - plausible, silent, and exactly what
// `<game>_mirror_<replay>` exists to name. One port delivers in order, so
// posting the blocks first is the whole of the rule.
//
// ONE MESSAGE PER TICK rather than per step, which is where this differs from
// the speaker beside it: a skipped 800 samples is a hole and a skipped picture
// is invisible, so a catch-up of eight steps sounds eight ticks and draws one.
//
// Every buffer is transferred, and every one of them was made by `slice` for
// that: the session goes on holding its own bytes.
//
// Nothing at all on a host with no renderer - the two harnesses that drive this
// thread for something other than its pixels broker no channel, and the guard is
// what lets them run every other line of this file.

const show = (deliveries) => {
    if (! screenPort) { return; }

    for (const region of deliveries) {
        screenPort.postMessage ({ id: region.id, address: region.address,
            bytes: region.bytes }, [region.bytes.buffer]);
    }

    // Written out rather than composed, for the reason the speaker's tick is:
    // the shape a renderer reads is a shape a reader of this file can see.
    //
    // The FRAME goes with it because the far side has no count of its own and
    // its heartbeat has to name one: a render worker knows nothing about the
    // run except the pixels it was asked for.
    const videoState = session.videoStateBytes ();

    screenPort.postMessage ({ videoState, frame: session.frameIndex },
        [videoState.buffer]);
};

// Whether this frame is worth publishing, and then the publishing.
//
// Both skips are the page's own, moved here unchanged and still worth exactly
// what they were - more, in fact, since each of them now also saves a copy, a
// message and a turn of another thread's event loop. `held` is
// `game_report_still` accumulated over however many steps ran, and it says the
// pixels already on the canvas are this frame's too. And a frame that stepped
// NOTHING has nothing new to draw at all: a picture is a function of the
// description the newest step captured, so a display frame that ran no step
// would be asking the renderer to redraw the frame already on the canvas.

const present = (tick) => {
    if (! tick.stepped || tick.held) { return; }

    show (freshDeliveries (session, heldByScreen));
};

// The display's own frames, asked for from here.
//
// `requestAnimationFrame` where this worker's global has one, which
// `docs/runs/drawing-worker-run.md` measured that both browsers the arcade is
// played in do, and a timer at the frame rate where it does not. The two are not
// interchangeable and that log says why: an animation frame IS the vsync, so
// nothing has to estimate where the next one falls, and a hidden tab stops a
// worker's animation frame dead in Chrome while leaving its timer running at
// full rate. So the fallback is exactly the case that would run a game nobody is
// watching at 60 Hz in a background tab, and what stops it is the page's halt on
// `hidden` arriving below as `prime { running: false }`.

const HAS_ANIMATION_FRAME = typeof requestAnimationFrame === 'function';

// The callback that has been asked for and not yet run - an animation frame id
// or a timer handle - or null while this worker is not asking for frames.
//
// `running` is the page's permission rather than this thread's state: a halted
// run asks for nothing, and the two are separate because a callback in flight
// when a halt arrives has to be taken back rather than waited out.

let pending = null;
let running = false;

const ask = () => {
    if (! running || ! session) { return; }

    pending = HAS_ANIMATION_FRAME
        ? requestAnimationFrame (frame)
        : setTimeout (() => frame (performance.now ()), 1000 / FRAME_RATE);

};

const startAsking = () => {
    if (running) { return; }

    running = true;

    ask ();
};

const stopAsking = () => {
    running = false;

    if (pending === null) { return; }

    if (HAS_ANIMATION_FRAME) { cancelAnimationFrame (pending); }
    else { clearTimeout (pending); }

    pending = null;
};

// One display frame: what the clock owes the game, what the game owes the
// speaker, what it owes the renderer, and the heartbeat the page reads.
//
// ARMED AT THE TOP, which is where the page's own loop arms and is kept for the
// same reason: a step that throws - a game trapping under the sanitizer - leaves
// the chain intact and reports once a frame, where a re-arm below the throw
// would take the run down with the first bad frame.
//
// THE FRAME MESSAGE IS A HEARTBEAT AND CARRIES NO PICTURE. What is left on it is
// what only the page can act on: the frame count and the four logs' new entries,
// which are the record a wedged page writes its recording out of; `stepped` and
// `held`, which say what the tick did; `idle`, which is the game asking to stop;
// and the save blob on the frames the game asked for one, which is the one thing
// a closing tab needs and cannot ask for. The state block and the deliveries
// were the page consumer's and there is no page consumer.

const frame = (moment) => {
    pending = null;

    ask ();

    if (! session) { return; }

    audio = [];

    // On the page's clock from here down, because that is the clock the input
    // queue is stamped in and the clock a boundary means something in.
    const now = moment + originShift;

    // A timestamp for an instant already spent is answered rather than dropped,
    // because the page reads a frame message as the heartbeat that says this
    // thread is still there - so a callback that owed no step still says so.
    const tick = now > advanced
        ? (advanced = now, clock.advance (now))
        : { stepped: 0, held: true, idle: false, asked: false };

    // The speaker first, and then the renderer. Each is posted every block it
    // has not been handed before any description that can name one -
    // `docs/archived/threaded-host-plan.md`'s *Delivery*, kept once per
    // consumer because each holds its own copies - and the two channels are
    // independent, so the order between them is this file's convenience rather
    // than a rule.
    sound (tick.stepped ? freshDeliveries (session, heldByAudio) : []);

    present (tick);

    self.postMessage ({
        kind: 'frame',
        frame: session.frameIndex,
        stepped: tick.stepped,
        held: tick.held,
        idle: tick.idle,

        // What this run would keep if the page went away now, rendered on the
        // frames the game asked for one with `game_report_save` and on no
        // others. Null everywhere else, which `player.html` reads as keep what
        // you have: the page holds a mailbox rather than a log, so a frame that
        // says nothing leaves the newest blob standing.
        //
        // PUSHED RATHER THAN ASKED FOR, still, and that half is unchanged. The
        // store is `localStorage` and there is none on this thread, and the
        // commonest way a game is left is a closed tab - where the page is
        // inside `pagehide` with no round trip left to take. That is also why a
        // request is spent on the frame it is made rather than batched: a blob
        // held back for a tick that never comes is a fact the tab took with it.
        // Null for a game that persists nothing, which `Session.renderSave`
        // answers for itself, and for a game that has asked for nothing yet -
        // the `opened` answer below rendered one before frame 0, so the page has
        // never been empty-handed.
        save: tick.asked ? session.renderSave () : null,

        records: freshRecords (),
    });
};

self.onmessage = (event) => {
    const message = event.data;

    switch (message.kind) {

    // A new run, which is a new session, a new linear memory and a new arena.
    // The page builds a fresh worker for a reset rather than reopening this one,
    // so this happens once per worker - and the answer below is what the page
    // waits on before it opens the renderer, because everything a renderer is
    // told about where to draw is a fact about the arena this message lays
    // down.
    case 'open': {
        // The store, which is the page's: `localStorage` does not exist on this
        // thread. What arrives is the blob the page read for this game, and the
        // shim below is what hands it to `Session` at the one moment a session
        // asks - after `save_size` is known and before `construct` runs.
        //
        // Which zero the page's timestamps stand on, so that this thread's own
        // may be moved onto it. Absent from a host that drives both clocks
        // itself, and then the shift is zero and nothing moves.
        if (message.pageTimeOrigin) {
            originShift = performance.timeOrigin - message.pageTimeOrigin;
        }

        // A blob of the wrong length is a store this module has outgrown, and
        // the answer is the one `SaveStore` gives: `save_size` zeros, which is
        // what `interface/game.h` means by fresh. `write` is never called, and
        // could not be answered if it were - the store is the page's, and what
        // reaches it is the blob this thread renders and posts.
        const store = {
            read: (name, size) => message.saved && message.saved.length === size
                ? new Uint8Array (message.saved)
                : new Uint8Array (size),
            write: () => {},
        };

        session = new Session (message.bytes, message.trampoline,
            new HostCore (message.core), message.seed, message.args,
            message.workerUrl, message.resources, store);

        input = new Input ();

        // A task becoming ready under a game whose state had no other reason to
        // move, which is the half of ending `game_report_idle` the player cannot
        // cause and this thread is the only one that can see.
        //
        // The OTHER half - an event arriving - is deliberately not sent from
        // here even though `Input.onQueued` exists for it. The page wakes itself
        // where its listener takes the event off the browser, one line before it
        // posts it, because a wake resumes the audio context and `resume` is
        // gated behind user activation: activation is in hand inside the
        // handler and gone by the time a message comes back. The queue this
        // thread holds is fed by that same page, so nothing is missed.
        session.onStaged = () => self.postMessage ({ kind: 'wake' });

        // One entry per step, and what it holds is the STATE that step ended in
        // rather than the samples it sounds: `render_audio` runs in the worklet
        // now, on its own instance of this module, so what crosses is the same
        // bytes the picture is drawn from. Null is `game_report_silent`, which
        // the far side plays as its own 800 zeros - a frame of silence costs no
        // copy here and no render there.
        //
        // Nothing is copied at all with no worklet to send it to, which is what
        // the guard is: a page whose `addModule` failed pays no state copy a
        // step for a consumer that does not exist.
        clock = new Clock (() => session, input,
            (report) => audio.push (! audioPort || ! session.sounds
                || report & REPORT.silent ? null : soundOf (session)));

        self.postMessage ({
            kind: 'opened',
            layout: session.layout (),
            resident: session.residentRegions (),

            // What the page says about the run without opening the module a
            // second time. The consumer reads the identity off its own instance
            // - it is a declaration of the module and the same in both - so what
            // is here is only what a SESSION knows: the seed it really ran with,
            // and the directory a body would read from.
            seed: session.seed,

            // And the two header halves of a recording, which are fixed for the
            // life of a run: the blob it was constructed from and the pairs it
            // was told. They go here rather than being asked for later for the
            // reason `reported` above states - a hung thread answers nothing,
            // and a page that has held these since frame 0 can still write a
            // file about the frame that stopped.
            saveLines: session.saveLines (),
            argLines: session.argLines (),

            // And the blob this run holds BEFORE its first step, rendered here
            // and kept by the page exactly as a frame's is.
            //
            // It is the one render this thread makes that no game asked for,
            // and it is owed: `construct` may rewrite a field on the way in - a
            // stale blob brought forward, a fresh one filled - and that is a
            // fact the page should hold from frame 0 rather than a lie until
            // the first request. A tab closed before any request still writes
            // the right bytes because of this line. Null for a game that
            // persists nothing.
            save: session.renderSave (),
        });

        // And the display, asked for its frames - unless the page says it is
        // already halted, which a tab opened into the background is. The default
        // is to run, because a host that says nothing about halting has no halt
        // table: `products/web-player/tests/plays.js` and `watchdog.js` both
        // drive this thread through a shimmed animation frame and neither has
        // one.
        if (message.running !== false) { startAsking (); }

        break;
    }

    // Who is listening: the worklet's end of a `MessageChannel` the page made,
    // or NULL for a page whose worklet never arrived.
    //
    // It is posted before the first `tick` rather than when the worklet is
    // ready, so nothing this run sounds is lost while `addModule` resolves - a
    // port holds what is posted to it, and a transferred port carries its queue
    // with it. The null is the other half of that and is not politeness: without
    // it a page with no audio would have this thread copying a state block per
    // step into a port nobody drains, for the life of the run.
    //
    // NOTHING IS EVER RECEIVED ON IT. The channel runs one way, from this thread
    // to the audio thread, because a consumer that answered would be a consumer
    // the simulation waited on - and `docs/archived/threaded-host-plan.md`'s
    // whole release argument is that it waits on none.
    case 'audience':
        if (audioPort) { audioPort.close (); }

        audioPort = message.port || null;

        break;

    // And who is WATCHING: the render worker's end of a second `MessageChannel`
    // the page made, or NULL for a host that brokered none.
    //
    // Everything the message above says applies here word for word, one channel
    // over - it arrives before the first tick so a port holds what a compiling
    // renderer has not drained, and the null keeps a thread with no renderer
    // from copying a description a frame into a port nobody reads. What differs
    // is only what a missing far side means: no sound is a game played in
    // silence, and no renderer is a game played blind.
    case 'viewer':
        if (screenPort) { screenPort.close (); }

        screenPort = message.port || null;

        // AND A CLEAN SLATE OF WHAT THAT CONSUMER HOLDS, which is the one thing
        // this case owes that the speaker's does not. The page sends this
        // message twice in a run's life: once at `reset`, into a map that is
        // already empty, and once when it has replaced a wedged renderer with a
        // fresh worker on a fresh linear memory. That second instance holds no
        // task block at all, so a record of what the DEAD one had been handed
        // would keep every live block from ever being delivered again and leave
        // the new renderer drawing pictures out of zeros - silently, on the
        // first frame a description named a task. Cleared here rather than
        // asked for, because the page cannot tell this thread what another
        // thread's memory holds and does not have to: a new port is a new
        // consumer by construction.
        heldByScreen = new Map ();

        break;

    // An event the page's listeners took off the browser, with the instant the
    // browser stamped it. Queued here rather than there so that the boundary a
    // step drains to and the boundary the recorder writes down are one clock
    // and one queue - `web_player_reports_a_press_where_it_was_pressed` is the
    // case that reads it, and it reads `Input` rather than either host.
    case 'key':
        if (input) { input.queue (message.time, message.code, message.down); }

        break;

    case 'pointer':
        if (input) {
            input.queuePointer (message.time, message.id, message.x, message.y,
                message.present, message.hovers);
        }

        break;

    case 'pointerbutton':
        if (input) {
            input.queuePointerButton (message.time, message.id, message.button,
                message.down);
        }

        break;

    // What a halt takes from the player, in the three spellings `haltChange`
    // answers with. `stepped` is the one that runs a real frame - the pointer
    // leaving as the pause begins - so it answers with one, and the page holds
    // the sound off until that answer has been published and played.
    case 'shed': {
        if (! session) { break; }

        if (message.how === 'quiet') {
            input.applyUpTo (Infinity);
            input.releaseButtons ();
            input.releasePointer ();
            input.clearEdges ();
        }

        if (message.how === 'backlog') {
            input.applyUpTo (Infinity);
            input.clearEdges ();
        }

        if (message.how === 'stepped') {
            // ALWAYS ANSWERED, including with nothing, and that is the one thing
            // this branch owes the page that the inline version did not: the
            // page holds the audio context off until this answer lands, so a
            // shed that decided there was no frame to run has to say so. A game
            // that reads no pointer and a pointer already off the screen are
            // both that decision.
            const runs = session.controls.pointer !== NEED.none;

            if (runs) { input.applyUpTo (Infinity); }

            const moves = runs && input.pointer.present;

            if (runs && ! moves) { input.clearEdges (); }

            audio = [];

            let report = 0;

            if (moves) {
                input.releasePointer ();

                report = session.advance (input.buttons, input.edges,
                    input.pointer);

                input.clearEdges ();

                audio.push (! audioPort || ! session.sounds
                    || report & REPORT.silent ? null : soundOf (session));
            }

            sound (moves ? freshDeliveries (session, heldByAudio) : []);

            const still = (report & REPORT.still) !== 0;

            // Published from here rather than left to the next display frame,
            // and that is what "it costs one real frame" has always meant: the
            // halt that asked for this frame is about to stop this thread asking
            // the display for anything, so a description waiting on a callback
            // would be posted whenever the pause ended or never.
            present ({ stepped: moves ? 1 : 0, held: still });

            self.postMessage ({
                kind: 'frame',
                frame: session.frameIndex,
                stepped: moves ? 1 : 0,
                held: still,
                idle: false,
                pointerAway: true,

                // The same rule as the display frame above, read off the one
                // step this path takes rather than off a burst: a pointer
                // leaving the screen can be the input that ends a run, and a
                // run that ends writes a fact.
                save: (report & REPORT.save) ? session.renderSave () : null,
                records: freshRecords (),
            });
        }

        break;
    }

    // A window that lost focus, which is not a keyup: the held state is dropped
    // and the pointer is left where it is. `player.html` carries the argument.
    case 'blur':
        if (! session) { break; }

        input.applyUpTo (Infinity);
        input.releaseButtons ();
        input.clearEdges ();

        break;

    // The interval that has not been lived through, forgotten, and whether this
    // thread may go on asking the display for frames.
    //
    // The page arms this wherever it would have primed the clock itself -
    // entering or leaving a pause, a hidden tab, a rest - and both halves matter.
    // The clock is primed because an animation frame that arrives after a stall
    // carries every second of it, and the accumulator would spend that on a
    // catch-up of up to eight steps nobody played. And `running` is the halt
    // itself: a page that has stopped watching stops this thread asking, which
    // is what keeps a hidden tab from running a game at whatever rate the
    // browser leaves the worker's clock at.
    case 'prime':
        if (clock) { clock.prime (); }

        advanced = 0;

        if (message.running) { startAsking (); }
        else { stopAsking (); }

        break;

    // This host's own account of the run, which is what a session knows about
    // itself and no game is ever told: how many frames have gone, what its
    // bodies read and what became of each, and the task table as
    // `console_tasks` reports it. Nothing acts on it - the page prints the
    // resource line at startup and `products/web-player/tests/plays.js` compares
    // the lot against what `inspector info` reads out of the native plug-in -
    // and it is asked for rather than pushed, because it is a diagnostic and not
    // a frame.
    case 'report':
        if (! session) { break; }

        self.postMessage ({
            kind: 'reported',
            token: message.token,
            report: {
                seed: session.seed,
                frameIndex: session.frameIndex,
                stateSize: session.stateSize,
                taskMax: session.taskMax,
                saveSize: session.saveSize,
                readLog: session.readLog,
                taskTable: session.taskTable (),
            },
        });

        break;

    // Every thread this session is still holding, ended. A body running for a
    // game that no longer exists is a core spent on an answer nothing will read.
    case 'close':
        stopAsking ();

        if (session) { session.runner.stop (); }

        session = null;

        // And the two consumers' ends of the two channels, because the page's
        // own ends went to a worklet and a renderer that are about to be opened
        // on a new run: a port left open on a terminated thread is a port that
        // can never be posted to again, and saying so here is what lets each far
        // side close its own.
        if (audioPort) { audioPort.close (); audioPort = null; }

        if (screenPort) { screenPort.close (); screenPort = null; }

        break;
    }
};
