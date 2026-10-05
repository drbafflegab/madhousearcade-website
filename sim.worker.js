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
// THE CLOCK IS THE DISPLAY'S AND THE DISPLAY IS READ ON THE PAGE. The page's own
// animation frame posts its timestamp here as a `tick`, and this thread runs
// `Clock` on the number it is handed - so there is still nothing to estimate and
// no model to be wrong, and this thread asks the browser for nothing at all. It
// used to ask for its own animation frames, on a reading that a worker's
// callback IS the vsync. That reading was Chrome's: a Safari worker's callbacks
// are scattered across the refresh period at a circular concentration of 0.147
// against a uniform null of 0.097, where Chrome's worker reads 0.985, so the
// thread that stepped was reading a clock that was not the display's however
// close its RATE came. `docs/runs/frame-cadence-run.md` section 8 is the phase
// reading, section 16 is what it looks like, and section 19 is why `step` stayed
// on this thread rather than following the clock to the page. A page's callback
// is the display's in both browsers, and the page is the only thread on which
// that is known to be true.
//
// SO THE TIMESTAMP ARRIVES ALREADY ON THE PAGE'S ZERO, and this thread must not
// move it. That zero is the one the input queue is stamped in - every event
// carries the browser's own `event.timeStamp` and `Clock` drains the queue up to
// the boundary its timestamps put it at - and a dedicated worker's time origin
// is its own creation rather than the document's, so a clock run on this
// thread's zero held every press for however long the page took to fetch a
// module. Measured on the shipped page before that was fixed: press to the
// record's arrival read 14.2 ms on one load and 58.5 ms on the next, against
// 29.5 for the page that posted its own timestamps. This file used to subtract
// the two origins for exactly that and no longer has either number to subtract;
// a subtraction here now would move a page timestamp twice.
//
// The display is not the simulation's rate: `docs/runs/drawing-worker-run.md`
// read one panel at 120 Hz and at 60, so a tick steps whatever the accumulator
// says, which is often no step at all.
//
// THE INPUT QUEUE CAN BE REPLACED BY A FILE, once, behind `replay` in the open
// message: the presentation probe plays a committed recording rather than a
// hand, so that the reading it takes off a screen is taken over the same input
// every time. The driver is the block below `frame`, it is reachable from no
// page that did not say `?probe=present`, and `docs/presentation-probe.md` is
// what it is for.
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

// What each consumer has been handed, by resource id - `publishResources`'s own
// bookkeeping, held here because what a consumer holds is its own.
//
// ONE SET PER CONSUMER, and there are two: the speaker and the renderer hold
// separate copies of a resource at the same address in separate memories, and
// each is handed only the resources its own call may lock - the speaker the
// ones scoped for `render_audio`, the renderer the ones scoped for
// `render_video` - so neither set may answer for the other.

let heldByAudio = new Set ();
let heldByScreen = new Set ();

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
// says so where it chooses its own origin.
//
// WHAT IT GUARDS AGAINST HAS MOVED AND THE GUARD HAS NOT. It used to stop the
// fallback timer's own first reading, and there is no timer on this thread any
// more: every timestamp this file sees arrives on a `tick` the host posted. A
// browser's animation-frame timestamp is never zero by the time a module has
// been fetched, so the shipped page cannot reach this line; what can is a HOST
// that chose its own origin, which is why all four node harnesses start at 1000.

let advanced = 0;

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

// What the tick owes the speaker, down the page's channel: one message per step
// the tick ran, each carrying the store as that step left it.
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

//
// AND THE STORE AS THAT STEP LEFT IT, published at the same moment: the rows of
// the table and the bytes of every resource scoped for `render_audio` the
// speaker has not been handed. Taken here rather than when the tick is posted,
// because a speaker renders a step's description against the table as it
// stood when that description was captured, and a tick of eight steps is eight
// different tables.

const soundOf = (session) => ({
    audioState: session.audioStateBytes (),
    ...publishResources (session.publisher (), heldByAudio, CORE.scope.audio),
});

// How many times slower than the console's own rate the live game is being
// played: 1, or 2 and 4 under the page's slow motion. The clock is what steps
// slower; this is what tells the speaker to stretch each block to match, so a
// block of 800 samples lasts as long as the step it belongs to now does. A
// scrubbed tick is never stretched - the ring plays at sixty a second whatever
// the live game is doing.
let tempo = 1;

const sound = () => {
    if (! audioPort) { audio = []; return; }

    for (const tick of audio) {
        if (! tick) {
            audioPort.postMessage ({ silent: true, stretch: tempo });

            continue;
        }

        // Written out rather than composed, so that the shape a worklet reads
        // is a shape a reader of this file can see - which is also what
        // `products/web-player/tests/worklet.js`'s seam check reads, field by
        // field, out of this source.
        //
        // `scrub` and `reverse` are false on every live tick and set only on a
        // tick the scrubber below replays out of its ring: the worklet mirrors
        // a scrubbed tick's rows without forgetting, and turns a reversed
        // one's samples end for end. `stretch` is `tempo` above on a live tick
        // and 1 on a scrubbed one.
        audioPort.postMessage (
            { audioState: tick.audioState, fresh: tick.fresh, rows: tick.rows,
                scrub: tick.scrub === true, reverse: tick.reverse === true,
                stretch: tick.scrub === true ? 1 : tempo },
            [tick.audioState.buffer,
                ...tick.fresh.map (resource => resource.bytes.buffer)]);
    }

    audio = [];
};

// What the tick owes the RENDERER, down the page's second channel: the one
// description the picture is a function of, and the store as the step that
// captured it left it - the rows of the table, and the bytes of every resource
// scoped for `render_video` the render worker has not been handed.
//
// THE DELIVERY RULE, which is the speaker's rule one channel over. A
// description names a resource by ID, so a description naming an id whose
// bytes the far side does not hold is a picture drawn out of zeros -
// plausible, silent, and exactly what `<game>_mirror_<replay>` exists to name.
// One message carries all three, so the far side never holds a description
// without the table it was captured against.
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

const show = () => {
    if (! screenPort) { return; }

    const { fresh, rows } = publishResources (session.publisher (),
        heldByScreen, CORE.scope.video);

    // Written out rather than composed, for the reason the speaker's tick is:
    // the shape a renderer reads is a shape a reader of this file can see.
    //
    // The FRAME goes with it because the far side has no count of its own and
    // its heartbeat has to name one: a render worker knows nothing about the
    // run except the pixels it was asked for.
    const videoState = session.videoStateBytes ();

    screenPort.postMessage ({ videoState, frame: session.frameIndex, fresh,
        rows }, [videoState.buffer,
            ...fresh.map (resource => resource.bytes.buffer)]);
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

    show ();
};

// ---------------------------------------------------------------------------
// THE SCRUB RING: the last thirty seconds of what every step captured, kept so
// that a paused page can show any of those frames again and sound them forward
// or backward. `docs/archived/scrub-plan.md` is the design and the argument.
//
// DESCRIPTIONS, NOT PIXELS AND NOT STATE. A frame's picture is `render_video`
// over its video description and the store as it stood at the capture, and its
// sound is `render_audio` over its audio description, so a slot holds those two
// and the rows they were captured against and nothing else: nothing is
// snapshotted, nothing is stepped again, and a scrubbed frame is drawn by the
// same consumer out of the same bytes it was drawn from the first time. 1,800
// slots of `games/klondike`'s two descriptions is 5.3 MB, against 104 MB for
// the indexed pixels of the same thirty seconds.
//
// HERE, because this is the one thread that sees every step: the renderer is
// handed one description per TICK, and a tick may step eight times.
//
// ONLY UNDER `scrub` IN THE OPEN MESSAGE. A run opened without it allocates no
// ring, copies nothing per step and answers no `scrub` message, which is what
// keeps the ordinary player untouched.
//
// AND IT RECORDS NOTHING. The ring is read-only output: no message below steps
// the session, queues an input, grows a log or posts a `frame` heartbeat, so a
// recording marked after a scrub is the recording marked without one -
// `web_player_scrubs_the_frame_it_showed` compares the two texts.
// ---------------------------------------------------------------------------

// Thirty seconds at the console's sixty frames, which is the owner's figure.
const SCRUB_FRAMES = 1800;

let ring = null;

// The frame the page is looking at, between the floor and the head.
let cursor = 0;

// The byte stores are laid down once, a slot's span each, so that filling a
// slot is two `set`s and allocates nothing but the rows; the rows are small,
// and are taken exactly as `publishResources` maps them.
const openRing = (session) => ({
    videoSize: session.videoStateSize,
    audioSize: session.audioStateSize,
    video: new Uint8Array (SCRUB_FRAMES * session.videoStateSize),
    audio: session.audioStateSize
        ? new Uint8Array (SCRUB_FRAMES * session.audioStateSize) : null,
    slots: Array.from ({ length: SCRUB_FRAMES },
        () => ({ frame: -1, rows: [], sounds: false })),
    head: 0,
});

// The oldest frame still held. Derived from the head, never stored, so the two
// cannot disagree.
const floorOf = () => Math.max (0, ring.head - SCRUB_FRAMES + 1);

// What the step that just ran captured, copied into its slot. Called with that
// step's report from both places a step is taken - the clock's per-step
// callback and the pause's one step with the pointer away - and once at `open`
// for frame 0, whose descriptions `construct` captured.
//
// THE AUDIO HALF FOLLOWS THE GAME AND NOT THE PORT. The live path pushes null
// with no worklet to send to, so as to copy nothing for nobody; a slot keeps
// the description whenever the game sounded that step, because whether a
// worklet is listening is a fact about the page and a slot is a fact about the
// run.
const remember = (report) => {
    if (! ring) { return; }

    const frame = session.frameIndex;
    const at = frame % SCRUB_FRAMES;
    const slot = ring.slots [at];

    ring.video.set (new Uint8Array (session.memory.buffer,
        session.videoStatePtr, ring.videoSize), at * ring.videoSize);

    slot.sounds = ring.audio !== null && session.sounds
        && ! (report & REPORT.silent);

    if (slot.sounds) {
        ring.audio.set (new Uint8Array (session.memory.buffer,
            session.audioStatePtr, ring.audioSize), at * ring.audioSize);
    }

    slot.rows = session.publisher ().resources ().map (row => ({ id: row.id,
        scope: row.scope, size: row.size, address: row.address,
        dead: row.dead }));

    slot.frame = frame;
    ring.head = frame;
};

// One slot's picture, posted to the renderer as `show` posts a live one, with
// the slot's own rows, no bytes and `scrub` set so that the renderer mirrors
// those rows without forgetting. False where the slot names a resource the
// renderer no longer holds, which is posted nothing: `staleResources` in
// `player.js` says why that is refused rather than drawn.
const showSlot = (frame) => {
    if (! screenPort) { return true; }

    const at = frame % SCRUB_FRAMES;
    const slot = ring.slots [at];

    if (staleResources (slot.rows, heldByScreen, CORE.scope.video)) {
        return false;
    }

    const videoState = ring.video.slice (at * ring.videoSize,
        (at + 1) * ring.videoSize);

    screenPort.postMessage ({ videoState, frame, fresh: [], rows: slot.rows,
        scrub: true }, [videoState.buffer]);

    return true;
};

// One slot's sound, in the shape `sound` posts: null - a silent tick - for a
// step the game reported silent and for a slot naming a resource the worklet
// no longer holds.
const soundSlot = (frame, reverse) => {
    const at = frame % SCRUB_FRAMES;
    const slot = ring.slots [at];

    if (! slot.sounds
        || staleResources (slot.rows, heldByAudio, CORE.scope.audio))
    {
        return null;
    }

    return { audioState: ring.audio.slice (at * ring.audioSize,
        (at + 1) * ring.audioSize), fresh: [], rows: slot.rows, scrub: true,
        reverse };
};

// One display frame, read on the PAGE: what the clock owes the game, what the
// game owes the speaker, what it owes the renderer, and the heartbeat the page
// reads. The `tick` case below is its ONE caller, and nothing on this thread
// ever reaches it out of a callback of its own - the other producer of a frame
// message is the `shed { how: 'stepped' }` path, which runs a frame of its own
// out of band and does not come through here.
//
// THE CHAIN IS THE PAGE'S AND THIS FUNCTION ARMS NOTHING. It used to ask for the
// next animation frame on its first line, which is where the page's own loop
// arms and was kept for the same reason: a step that throws - a game trapping
// under the sanitizer - leaves the chain intact and reports once a frame, where
// a re-arm below the throw would take the run down with the first bad frame.
// The property is kept and there is nothing left here to keep it with.
// `player.html`'s `loop` arms itself at the top and posts the tick after, so a
// throw on this thread cannot reach the thing that asks again - and there is no
// callback in flight for a halt to take back, because a halted page simply
// stops posting.
//
// THE TIMESTAMP IS THE PAGE'S OWN, untouched: the clock the input queue is
// stamped in and the clock a boundary means something in. The header says what
// this thread used to do to it and why it must not any more.
//
// THE FRAME MESSAGE IS A HEARTBEAT AND CARRIES NO PICTURE. What is left on it is
// what only the page can act on: the frame count and the four logs' new entries,
// which are the record a wedged page writes its recording out of; `stepped` and
// `held`, which say what the tick did; `idle`, which is the game asking to stop;
// and the save blob on the frames the game asked for one, which is the one thing
// a closing tab needs and cannot ask for. The state block and the deliveries
// were the page consumer's and there is no page consumer.

const frame = (now) => {
    if (! session) { return; }

    audio = [];

    // A timestamp for an instant already spent is answered rather than dropped,
    // because the page reads a frame message as the heartbeat that says this
    // thread is still there - so a callback that owed no step still says so.
    const tick = now > advanced
        ? (advanced = now, clock.advance (now))
        : { stepped: 0, held: true, idle: false, asked: false };

    // The speaker first, and then the renderer. Each message carries the
    // resources it may need beside the description that can name them -
    // `docs/archived/threaded-host-plan.md`'s *Delivery*, kept once per
    // consumer because each holds its own copies - and the two channels are
    // independent, so the order between them is this file's convenience rather
    // than a rule.
    sound ();

    present (tick);

    // The recording has run out, said once and to the page alone. Nothing here
    // stops on it: a run that has played its last recorded frame goes on
    // stepping with the input it was left holding, which is what keeps a
    // picture on the screen while the probe's report is read off it.
    if (replay && ! replay.done && replay.frames !== null
        && session.frameIndex >= replay.frames)
    {
        replay.done = true;

        self.postMessage ({ kind: 'replayed', frame: session.frameIndex });
    }

    self.postMessage ({
        kind: 'frame',
        frame: session.frameIndex,
        stepped: tick.stepped,
        held: tick.held,

        // A REPLAYED RUN IS NEVER IDLE, and that is the driver below answering
        // the page's halt rather than a claim about the game. `game_report_idle`
        // means nothing more is coming until something happens to the game, and
        // on a replayed run something is: the next recorded frame. The page
        // would otherwise stop asking for frames the instant a recording paused
        // over a still board, and the probe would be reading a screen nobody was
        // drawing to.
        idle: replay ? false : tick.idle,

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

// ---------------------------------------------------------------------------
// A RECORDING PLAYED INSTEAD OF THE MOUSE, which is the presentation probe's
// half of this thread and is reachable from nowhere else.
//
// `docs/presentation-probe.md` is what it exists for. The question that probe
// asks - did a frame that was drawn reach the screen - is answered by comparing
// the instant the page committed a picture against what a screen capture
// decodes off the screen, and an answer is only worth having if the input was
// the same both times. A hand is not the same twice; a committed recording is.
// So the page fetches the file named by `?replay=<path>` behind
// `?probe=present`, hands its text over in `open`, and this plays it.
//
// WHAT THE FILE OVERRIDES. `seed`, `arg` and `save` are the run's header, so
// they outrank what the page composed out of its address bar and read out of
// its store - a recording carries what was DELIVERED rather than a reference to
// where it came from, which is what lets one play on any machine. The `input`,
// `tap` and `pointer` lines are change logs, and they drive `Input` at each
// frame exactly as `goldenhash.js`'s own frame reader does: the held set is the
// last `input` line at or before the frame, an edge is a button newly held or
// tapped, and the pointer is the last `pointer` line, `away` being absence and
// `nohover` a pointer that is there without hovering.
//
// IT IS THE RECORDER'S INVERSE, and that is a claim rather than a hope:
// `web_player_replays_a_recording_it_recorded` plays a committed recording
// through this driver under node and compares the `input`, `tap` and `pointer`
// entries the session writes back with the file's own lines. A driver that
// applied a press a frame late would be a probe measuring a run nobody
// recorded, and nothing about a picture on a screen would show it.
//
// THE PAGE'S HALTS ARE ANSWERED AS IF NOTHING HAPPENED, which is right for a
// probe and wrong for a player. A replayed run reads no queue, so the pointer
// leaving the canvas takes nothing from it and a `shed` steps nothing; and
// `idle` is masked out of the frame message above, because a page that stopped
// asking for frames would leave the capture reading a screen nothing draws to.
// That is why this exists behind `replay` alone and why `player.html` composes
// that field from the probe's own query and from nothing else.
// ---------------------------------------------------------------------------

let replay = null;

// `arg` keeps its value's interior spaces and cannot begin with one, which is
// the grammar `Game_Arg` states and the one line here that a split on
// whitespace would quietly rewrite. Read off the format the way `goldenhash.js`
// reads it rather than checked against it.

const ARG_LINE = /^arg\s+(\S+)(?:\s+([\s\S]*))?$/;

const parseReplay = (text) => {
    const file = { seed: null, args: [], save: null, frames: null,
        inputs: [], taps: [], moves: [], done: false };

    for (const raw of text.split (/\r?\n/)) {
        const line = raw.trim ();

        if (! line || line.startsWith ('#')) { continue; }

        const [key, ...rest] = line.split (/\s+/);

        if (key === 'seed') { file.seed = Number (rest [0]); }
        else if (key === 'save') { file.save = rest [0] || ''; }
        else if (key === 'frame') { file.frames = Number (rest [0]); }
        else if (key === 'input') {
            file.inputs.push ({ frame: Number (rest [0]),
                names: rest.slice (1) });
        }
        else if (key === 'tap') {
            file.taps.push ({ frame: Number (rest [0]),
                names: rest.slice (1) });
        }
        else if (key === 'pointer') {
            const frame = Number (rest [0]);

            file.moves.push (rest [1] === 'away'
                ? { frame, x: 0, y: 0, present: false, hovers: true }
                : { frame, x: Number (rest [1]), y: Number (rest [2]),
                    present: true, hovers: rest [3] !== 'nohover' });
        }
        else if (key === 'arg') {
            const written = line.match (ARG_LINE);

            if (written) {
                file.args.push ({ name: written [1],
                    value: written [2] === undefined ? '' : written [2] });
            }
        }
    }

    return file;
};

// The `save` line's hex, back into the blob the run was constructed from.
// `Session` holds it to `save_size` and answers zeros for anything else, so a
// line this cannot read is a fresh run rather than a refusal - which is the
// same ladder `SaveStore` on the page climbs for a defective store.

const hexBytes = (hex) => {
    const bytes = new Uint8Array (Math.floor (hex.length / 2));

    for (let index = 0; index < bytes.length; index++) {
        bytes [index] = parseInt (hex.slice (index * 2, index * 2 + 2), 16);
    }

    return bytes;
};

// The queue, replaced by the file. Every method `Clock` and the halts above
// reach for is answered here, so nothing outside this function knows which of
// the two is driving - which is what keeps the shipped loop the loop the probe
// measures.
//
// `applyUpTo` is handed a BOUNDARY by the clock and reads the FRAME instead,
// and that is the whole of the difference between the two drivers: a queue is
// drained by wall-clock time because that is when a hand moved, and a recording
// is indexed by frame because that is what it wrote down. `frameOf` answers with
// the frame the step about to run will be recorded under - `Session.advance`
// counts the frame after the step rather than before it - so a line at frame N
// is applied to the step that becomes frame N.

const scriptInput = (target, file, frameOf) => {
    let held = new Set (), previous = new Set ();
    let pointer = { x: 0, y: 0, present: false, hovers: true };
    let heldAt = 0, tapAt = 0, moveAt = 0;

    target.applyUpTo = () => {
        const frame = frameOf ();

        while (heldAt < file.inputs.length
            && file.inputs [heldAt].frame === frame)
        {
            held = new Set (file.inputs [heldAt++].names);
        }

        let tapped = new Set ();

        while (tapAt < file.taps.length && file.taps [tapAt].frame === frame) {
            tapped = new Set (file.taps [tapAt++].names);
        }

        while (moveAt < file.moves.length
            && file.moves [moveAt].frame === frame)
        {
            pointer = file.moves [moveAt++];
        }

        // An edge is a button newly held or one tapped inside the frame, which
        // is the reader's rule rather than this file's: the held log cannot
        // express a press and a release inside one frame, so the `tap` log
        // carries exactly those and both readers of the format derive the rest.
        for (const button of RECORDED_BUTTONS) {
            const down = held.has (button);

            target.buttons [button] = down;
            target.edges [button] = (down && ! previous.has (button))
                || tapped.has (button);
        }

        previous = held;

        target.pointer = { x: pointer.x, y: pointer.y,
            present: pointer.present, hovers: pointer.hovers };
        target.live = target.pointer;
    };

    // And everything else a host may do to a queue, answered with what a
    // recording means by it. The edges are cleared after each step exactly as
    // they are for a hand, because the next `applyUpTo` sets them again; a
    // release takes nothing, because there is nothing held that the file did
    // not put there; an event cannot be queued, because the page sends none on
    // a run it is not driving; and nothing is ever waiting, because the next
    // frame is already written down.
    target.clearEdges = () => {
        for (const button of RECORDED_BUTTONS) { target.edges [button] = false; }
    };

    target.releaseButtons = () => {};
    target.releasePointer = () => {};
    target.queue = () => false;
    target.queuePointer = () => false;
    target.queuePointerButton = () => false;
    target.waiting = () => false;
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

        // The recording this run plays instead of the mouse, or null on every
        // run that is not a probe's. Parsed before the session is built,
        // because its header is what the session is built FROM.
        replay = message.replay ? parseReplay (message.replay) : null;

        // And the blob it was constructed from, which REPLACES the one the page
        // read out of its store rather than being preferred to it. A recording
        // carries what was delivered rather than a reference to where it came
        // from, and an absent `save` line is the format's own spelling for
        // zeros - `Session.saveLines` writes one only where the delivered blob
        // had a non-zero byte - so a recording with no line has to construct
        // from zeros here too. Falling back on the page's store instead would
        // make a replay of a bare recording depend on whatever this browser
        // happened to be holding for this game, which is the one thing a
        // recording exists to be independent of.
        const saved = ! replay ? message.saved
            : (replay.save !== null ? hexBytes (replay.save) : null);

        // A blob of the wrong length is a store this module has outgrown, and
        // the answer is the one `SaveStore` gives: `save_size` zeros, which is
        // what `interface/game.h` means by fresh. `write` is never called, and
        // could not be answered if it were - the store is the page's, and what
        // reaches it is the blob this thread renders and posts.
        const store = {
            read: (name, size) => saved && saved.length === size
                ? new Uint8Array (saved)
                : new Uint8Array (size),
            write: () => {},
        };

        session = new Session (message.bytes, message.trampoline,
            new HostCore (message.core),
            replay && replay.seed !== null ? replay.seed : message.seed,
            replay ? replay.args : message.args,
            message.workerUrl, message.resources, store);

        input = new Input ();

        // And the queue, replaced by the file where there is one. Said out loud
        // on the one message this thread sends that is neither a frame nor an
        // answer, because a probe run that silently played the wrong recording
        // - or none - would be a reading nobody could tell from a good one, and
        // the page has no console of its own in front of the person taking it.
        if (replay) {
            scriptInput (input, replay, () => session.frameIndex);

            self.postMessage ({ kind: 'note', text: `replaying `
                + `${replay.frames} frames at seed ${replay.seed}: `
                + `${replay.inputs.length} input lines, ${replay.taps.length} `
                + `taps, ${replay.moves.length} pointer lines` });
        }

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
        //
        // And the scrub ring, where the page asked for one, filled from the
        // same callback because it is the one place that runs once per step
        // with both descriptions in hand - and given frame 0 here, which is
        // what `construct` captured and the oldest frame a short run can show.
        ring = message.scrub === true ? openRing (session) : null;

        remember (0);

        clock = new Clock (() => session, input, (report) => {
            remember (report);

            audio.push (! audioPort || ! session.sounds
                || report & REPORT.silent ? null : soundOf (session));
        });

        clock.slow (tempo);

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

        break;
    }

    // ONE DISPLAY FRAME, READ ON THE PAGE AND POSTED HERE. `player.html`'s
    // `loop` arms itself, posts this with the timestamp its own animation frame
    // was handed, and does its two watchdog reads after; everything from `frame`
    // down is this thread's.
    //
    // THIS IS THE WHOLE OF WHAT MAKES THE GAME MOVE, so there is no permission
    // to keep beside it. A halted run - a pause, a hidden tab, a game that
    // reported itself idle, a tab opened into the background that was never
    // unhalted - is a page whose loop is not armed and which therefore posts
    // nothing, and that is one mechanism rather than two. It used to be two:
    // this thread asked the display for its own frames and the page sent a
    // separate `running` flag to stop it, and a flag that can only ever agree
    // with the absence of the message it gates is a flag that rots.
    //
    // `session` is the only guard and it is the one that matters. `open` is
    // posted before a first tick can be - the page builds the worker, posts
    // `open` and only then arms its loop, and messages are delivered in order -
    // and `close` nulls the session, so a tick either side of a run steps
    // nothing rather than trapping.
    case 'tick':
        if (! session) { break; }

        frame (message.time);

        break;

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
        // resource at all, so a record of what the DEAD one had been handed
        // would keep every live resource from ever being published again and
        // leave the new renderer drawing pictures out of zeros - silently, on
        // the first frame a description named one. Cleared here rather than
        // asked for, because the page cannot tell this thread what another
        // thread's memory holds and does not have to: a new port is a new
        // consumer by construction.
        heldByScreen = new Set ();

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

        // A REPLAYED RUN SHEDS NOTHING, because it holds nothing the browser
        // put there: the pointer leaving the canvas is a fact about a hand, and
        // this run's pointer is a line in a file. The page is still owed its
        // answer - it holds the sound off until one lands - so a `stepped` shed
        // is answered with a frame that stepped nothing.
        if (replay) {
            if (message.how === 'stepped') {
                self.postMessage ({ kind: 'frame', frame: session.frameIndex,
                    stepped: 0, held: true, idle: false, pointerAway: true,
                    save: null, records: freshRecords () });
            }

            break;
        }

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

                // A step like any other, so the ring keeps it: the frame on the
                // screen when the scrub bar opens is this one.
                remember (report);

                audio.push (! audioPort || ! session.sounds
                    || report & REPORT.silent ? null : soundOf (session));
            }

            sound ();

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

    // The page moving the cursor over the ring, while it holds the run paused.
    // One kind and three spellings: `begin` puts the cursor at the head, `move`
    // moves it by `move` frames, and `end` shows the head again with the live
    // rows. Each is answered with `scrubbed`, which is its own kind rather
    // than a `frame` because a heartbeat grows the page's record and answers
    // its watchdog, and a scrubbed frame does neither.
    //
    // A MOVE SHOWS ONE FRAME AND MAY SOUND MANY. The picture is the frame the
    // cursor lands on; with `sound` set, every slot passed on the way is posted
    // to the worklet in the order it was passed, so a paced run feeds the
    // speaker one description per frame exactly as live play does. A move
    // toward the floor sounds each block reversed, which is read off the
    // direction rather than off the message, so the two cannot disagree.
    //
    // `stale` is a picture refused, and the page draws its bar in the alarm
    // colour for it; `staleResources` in `player.js` says when.
    //
    // Nothing at all with no session or no ring: a page that did not open the
    // run with `scrub` is owed no answer, and gets none.
    case 'scrub': {
        if (! session || ! ring) { break; }

        const floor = floorOf (), head = ring.head;

        if (message.begin) {
            cursor = head;

            self.postMessage ({ kind: 'scrubbed', frame: cursor, floor, head });

            break;
        }

        if (message.end) {
            cursor = head;

            // The live description and the live rows, through `show` itself,
            // so the renderer's mirror is put back by the ordinary forgetting
            // path. Nothing has stepped since the pause, so this is the head
            // slot's picture.
            show ();

            self.postMessage ({ kind: 'scrubbed', end: true, frame: head,
                floor, head });

            break;
        }

        const from = Math.min (Math.max (cursor, floor), head);
        const to = Math.min (Math.max (from + Math.trunc (message.move || 0),
            floor), head);

        if (message.sound) {
            const step = to < from ? -1 : 1;

            audio = [];

            for (let frame = from + step; frame !== to + step && from !== to;
                frame += step)
            {
                audio.push (soundSlot (frame, step < 0));
            }

            sound ();
        }

        cursor = to;

        const shown = showSlot (to);

        self.postMessage ({ kind: 'scrubbed', frame: to, floor, head,
            ...(shown ? {} : { stale: true }) });

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

    // The interval that has not been lived through, forgotten.
    //
    // The page arms this wherever it would have primed the clock itself -
    // entering or leaving a pause, a hidden tab, a rest - because an animation
    // frame that arrives after a stall carries every second of it, and the
    // accumulator would spend that on a catch-up of up to eight steps nobody
    // played. Sent on the way into a halt as well as on the way out, and the two
    // are now one message: what used to tell them apart was the flag below, and
    // priming a clock that is about to stop costs a subtraction and saves a
    // branch.
    //
    // IT NO LONGER CARRIES THE HALT. It used to say whether this thread might go
    // on asking the display for frames, and that flag WAS the halt; the display
    // is read on the page now, so a halted page stops posting `tick` and there
    // is nothing here left to stop. What a hidden tab would otherwise cost is
    // unchanged and is still refused on the page - `docs/runs/drawing-worker-run.md`
    // (b) measured a hidden tab's worker keeping a timer at full rate in Chrome
    // and both clocks at about nine ticks a second in Safari.
    case 'prime':
        if (clock) { clock.prime (); }

        advanced = 0;

        break;

    // Slow motion, which the page asks for under `scrub=on`: the clock steps
    // once every `divisor` of the console's frames and the speaker stretches
    // each block by as much. Anything else is the console's own rate. No prime,
    // because the accumulator only ever moves by what has elapsed since the
    // last callback, and a change of rate between two is the rate from then on.
    //
    // HELD HERE AND NOT ON THE CLOCK ALONE, because the page posts it right
    // behind `open` on every run and the clock may not exist yet when it
    // lands: `open` hands it on to the clock it builds.
    case 'tempo':
        tempo = message.divisor === 2 || message.divisor === 4
            ? message.divisor : 1;

        if (clock) { clock.slow (tempo); }

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
                maxTaskCount: session.maxTaskCount,
                maxResourceCount: session.maxResourceCount,
                saveSize: session.saveSize,
                readLog: session.readLog,
                taskTable: session.taskTable (),
                resourceTable: session.resourceTable (),
            },
        });

        break;

    // Every thread this session is still holding, ended. A body running for a
    // game that no longer exists is a core spent on an answer nothing will read.
    case 'close':
        if (session) { session.runner.stop (); }

        session = null;
        ring = null;

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
