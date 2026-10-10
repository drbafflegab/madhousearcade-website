// The thread the picture is drawn on, and it holds no canvas at all.
//
// It is a second instance of the game's own module - `Consumer` in `player.js`,
// the class the worklet already holds - handed the video description the
// simulation captured after a step and each resource scoped for `render_video`,
// and never a state block. It runs the game's own `render_video` on those
// bytes, turns the framebuffer into rgba with the same `paint` every host here
// spends, and posts the finished BLOCK back to the page, which commits it. The
// simulation steps, nothing on that thread draws, and nothing on this one
// writes a layer.
//
// WHY THE PICTURE IS HERE AT ALL, since it costs a display frame and buys no
// throughput: a `render_video` that never returns used to take the run with it,
// because it ran on the thread that steps. It wedges a thread the page can
// replace now, and the simulation plays on. The trade is argued and the frame
// is priced in `docs/archived/render-worker-plan.md` - about 16.7 ms at 60 Hz,
// measured three ways - and the sentence it insists on is that the frame is
// PAID rather than avoided.
//
// IT IS ALSO THE WHOLE REASON THIS THREAD SURVIVED THE CANVAS GOING BACK. The
// page could run `render_video` itself and save the hop, and it would be a
// frame better on latency; this is a console for games nobody here wrote, so a
// renderer that never returns is a plausible failure rather than a theoretical
// one, and on the page it would wedge the tab. `docs/decisions.md` item 41 is
// what bought the containment and this is what keeps it.
//
// THE CANVAS WENT BACK TO THE PAGE, and every line this thread had about a
// display went with it. It held an `OffscreenCanvas`, a `2d` context, an
// animation frame of its own and an unconditional copy inside that frame; what
// it holds instead is a pool of pixel blocks and a `postMessage`. The reason is
// the one that moved the clock one file over: a dedicated worker's animation
// frame is not the display's in Safari - `docs/runs/frame-cadence-run.md`
// section 8 puts its callbacks at a circular concentration of 0.147 round the
// refresh period against a uniform null of 0.097, where Chrome's worker reads
// 0.985 - so a thread committing the picture here was showing it at a moment
// the display did not choose, and no rule running on this thread could correct
// that. Sections 16 to 19 are the owner's readings of both shapes in both
// browsers, and `player.html`'s `loop` is where the commit is now.
//
// THE SLEEPING CANVAS WENT WITH IT, and it is the one thing in that move that
// was not free. A canvas nothing writes is a layer nothing commits, and a layer
// left uncommitted goes to sleep: a run of `games/klondike` rested ten seconds
// under a still cursor and showed its next slide a few hundred milliseconds
// late, with the cursor the game draws stuck beside it, on a visible tab in
// front of everything. What kept it awake was a commit and nothing but a commit
// - the picture written out again, or one pixel of it written back to itself -
// while the sound staying up and the simulation going on asking for frames
// through the rest were both measured and both made no difference.
// `docs/runs/scan-out-run.md` is the measurement and the seven ways it was
// eliminated. The copy that answered it was the loop this thread no longer has,
// and it is the page's loop now, because the only thread that can commit a
// canvas is the one that owns it. `player.html`'s `loop` is where that
// unconditional write lives and what it costs there.
//
// IT RENDERS ON RECEIPT, and there is nothing left here to coalesce. The rate
// is the page's: one animation frame posts one tick, and a tick publishes at
// most one description - `present` in `sim.worker.js` skips a tick that stepped
// nothing and a tick the game claimed `game_report_still` over, and the only
// publish that is not a tick's is the one real frame a pause costs. So a
// description arriving here is a page frame that asked for it. A frame loop on
// this thread would be a second rate between the display and the picture, which
// is exactly the rate the clock was moved onto the page to take out of the
// path, and it would add a wait to every publish for nothing.
//
// THE READING THAT PUT A FRAME LOOP HERE DOES NOT SURVIVE THE CANVAS LEAVING,
// and it is worth saying which reading, because it was a real one: Safari
// committed a worker's canvas at that worker's own rendering update and dropped
// every draw between two updates but the last, so a burst drawn on receipt
// reached the screen as a cut - a 20-frame slide in `games/klondike` lost runs
// of 27, 23 and 19 consecutive drawn frames, against 4 once the draw waited for
// this thread's frame. `docs/archived/safari-presentation-plan.md` section 1.
// Every word of that is about a COMMIT made here, and nothing is committed here
// now: what leaves this thread is a buffer, which no compositor coalesces.
//
// WHAT IT COSTS is one block of 230,400 bytes leaving this thread per published
// frame, and that is a pointer move rather than a copy: an `ArrayBuffer` in a
// transfer list is detached here and adopted there. The spike measured the
// whole round trip - the page posting a tick, the simulation stepping and
// publishing, this thread rendering, the block arriving back - at a median of
// 0.40 ms in Chrome, whose only trip over a frame was this worker compiling its
// own module at startup; the transfer and the two message turns are about 0.1
// ms of that. `docs/runs/frame-cadence-run.md` section 18.
//
// TWO BLOCKS CIRCULATE and neither thread allocates once a run is going: the
// page gives back the block it was holding when the next one arrives and it
// lands here as `spent`, so one is being rendered into while the other is on
// the screen. `takeBlock` below mints one where a return has not got back yet,
// which is what keeps a publish from ever waiting on a message, and it stops
// at a stated ceiling. The comment over the pool argues both halves, because
// the mint is what makes a REPLACED renderer publish at all and an unbounded
// mint is what makes a host that stopped taking blocks back cost a quarter of
// a megabyte a picture.
//
// THERE IS NO HEARTBEAT HERE ANY MORE, and that is a property kept rather than
// a line moved. `drew` used to be posted right after this thread's own
// `putImageData`, because a picture written here was a picture committed; the
// commit is the page's now, so the page marks its own at the instant it makes
// one and `RenderWatch` in `player.js` reads that. What this thread still says
// about itself is that it is open, and after that it says blocks - and a block
// that stops arriving is exactly the silence a renderer is replaced for.
//
// THERE IS STILL NO HALT HERE, and now there is nothing a halt could stop. The
// page halts the simulation's clock, so nothing is posted and no description is
// rendered; what a halt does not stop is the commit, and the commit is not on
// this thread.
//
// A BACKGROUNDED TAB ASKS THIS THREAD FOR NOTHING, which is new. The loop that
// is gone ran on whatever frames a hidden worker was handed - none at all in
// Chrome over the 23.9 seconds `docs/runs/drawing-worker-run.md` (b) watched
// one, and about nine a second in Safari, which throttles a worker to about 113
// ms from roughly a second after the hide - so a backgrounded Safari tab used
// to cost about nine commits a second here. A hidden page is a halted page, a
// halted page publishes nothing, and this thread is then idle.
//
// THE DESCRIPTION LANDS ON RECEIPT AND SO DOES THE DRAW. The bytes, the mirror
// and the frame number are taken in the message handler exactly as before, so
// the delivery rule below is untouched and a lock `render_video` makes is
// answered against the table its description was captured against. Two
// descriptions inside one page frame are two pictures rather than one coalesced
// picture, which is what dropping the loop gave up - the blend that could have
// used the older one was removed at `1a9078e` - and the page commits the newer
// of the two, so what the extra render costs is a render and never a frame.
//
// WHAT THE SUITE RUNS OF ALL THIS is everything but the display at the far end.
// `products/web-player/tests/plays.js` and
// `products/web-player/tests/watchdog.js` stand where the page stands: they
// hand this worker no canvas, because there is none left to hand it, and read
// the blocks it transfers back. The shape `ctest` exercises and the shipped
// shape are one shape again, where the receipt draw used to be the harness's
// and the frame loop the browser's alone -
// `docs/archived/safari-presentation-plan.md` section 4 stated that hole and it
// is closed. What is still reachable only from a headed browser is the page's
// commit and whatever a compositor does with it.
//
// IT STAMPS THE FRAME NUMBER INTO THE PICTURE for one caller and one only: the
// presentation probe, behind `probe` in the open message, which is how a screen
// capture learns which frame is on the screen rather than which frame was drawn.
// The `stamp` block below is the whole of it and `docs/presentation-probe.md`
// is what it is for; an ordinary run never sends the field and never sees a
// band.
//
// It stays HERE rather than moving to the page with the commit, because the
// number the bars carry is the description's frame and not the instant of the
// commit: a block the page commits twice carries the same number both times,
// which is right, and a block it never commits carries a number no capture ever
// sees, which is the reading. What the page adds is the other half of the
// comparison - the instant IT committed - and `probeDrew` there is where that
// is taken.
//
// THE DELIVERY RULE, from the receiving end. A description names a resource by
// ID, so a description naming an id whose bytes this instance does not hold is a
// picture drawn out of bytes that are not there. The simulation posts every
// resource this instance has not been handed, and the store's rows, IN the
// message carrying the description that can name one - so the rule is kept by
// the sender and read here as an ordering rather than as a check. `<game>_mirror_<replay>` is the case that would catch it
// broken, on the frame it first mattered.
//
// A classic worker rather than a module one, for `sim.worker.js`'s reason and
// `task.worker.js`'s before it: `importScripts` needs no MIME rules on somebody's
// static host, and the file it names sits beside this one because the site
// copies them all to the same directory. One spelling in this tree for "offload
// to a worker", not four.
//
// WHAT IT DOES NOT DO. It never calls `construct` and never calls `step`, it is
// never handed a state block, and it renders no `save` - `Consumer` says why
// each of those is the stepping instance's alone. It holds no store and writes
// no recording: it knows nothing about the run except the pixels it was asked
// for. And it holds no canvas, asks for no animation frame and commits nothing,
// which is what this file lost and `player.html` gained.

// `player.js` and nothing else, exactly as the simulation beside it: `Consumer`,
// `paint` and the two figures below are all that one file's, so this is a
// message protocol and no second host.
importScripts ('player.js');

// The second instance, or null before the page has opened a run. Built at
// `open` rather than at startup, because the addresses it renders into are the
// simulation's and the page cannot say what they are until its arena is down.

let consumer = null;

// The port the simulation publishes down. Null until the run is opened and
// never null after it: a host with no channel has no reason to have started
// this thread at all, so the `open` below takes it and guards for nothing.
//
// NOTHING IS EVER SENT BACK ON THE PORT. The channel runs one way, from the
// thread that steps to this one, because a renderer that answered would be a
// renderer the simulation waited on - and the whole of what splitting the two
// buys is that it waits on none. What this thread says, it says to the PAGE.

let stream = null;

// The frame the newest description was captured after, which is the number the
// block below carries. Zero until one has arrived.

let drawn = 0;

// The blocks the page has given back, and where a picture is made.
//
// A BLOCK RATHER THAN A CANVAS, which is the whole of what this thread does
// with a finished picture now: `paint` writes into one of these and it is
// transferred to the page, which owns the canvas and commits it. Two circulate
// for the life of a run - the page gives back the one it was holding when the
// next arrives - so the steady state allocates nothing on either thread.
//
// MINTED WHERE THE POOL IS EMPTY, UP TO A CEILING, and both halves of that were
// decided here rather than inherited. The plan this shape came from proposed
// the other rule outright - publish nothing on a frame whose pool is empty, so
// that a late round trip shows as a skipped picture instead of being buried in
// a queue - and that rule cannot be kept, for a reason its prototype never had
// to face: the prototype never replaced a renderer.
//
// A POOL THAT ONLY WAITS NEVER STARTS. The one thing that ever puts a block in
// this pool is the page giving one back, and the page gives one back only when
// a new one arrives, so a thread whose pool is empty and which refuses to mint
// is waiting on a block it is itself the sole source of. That is not a skipped
// picture, it is a thread that never publishes again - at the start of every
// run, and after every replacement, where one block is on the page being
// committed and whatever the terminated thread held died with it. It is the
// silent stall item 41's containment was bought to avoid, and it is why the
// first mint is unconditional.
//
// THE CEILING IS WHAT THE SKIP BOUGHT, kept for the one case a mint must not
// answer. A mint happens only on an empty pool, so the number of blocks alive
// here is the high-water mark of how many are out at once - and that number is
// the HOST's, not this thread's: one block is held for the canvas, one is in
// flight each way, and a host that stops draining its messages while
// descriptions keep arriving raises it by a block per description. Nothing on
// this thread can bound what another agent's event loop does, so the bound is
// stated rather than argued, and a draw past it publishes nothing at all -
// which is the plan's own skip, arrived at as the OVERFLOW rule rather than as
// the ordinary one. The page then commits the block it is already holding, so
// what the skip costs is one repeated frame.
//
// BOTH NUMBERS ARE MEASURED RATHER THAN PICKED, on this tree's own two hosts.
// `products/web-player/tests/plays.js` waits for each picture, which is what a
// display-paced page does, and never gets past TWO blocks alive - the steady
// state this file has always claimed.
// `products/web-player/tests/watchdog.js` paces nothing by anything and runs
// its ticks ahead of its own drain, and reaches SEVEN OR EIGHT: 8, 8 and 7 over
// three runs, at loads of 66 and 6, so it is the shape of the host rather than
// the load on it.
//
// So `POOL_KEPT` is two - the pool a display-paced host never outgrows, and
// enough for the page frame that publishes twice - and a return past it is let
// go of rather than hoarded, which is what keeps a burst from being paid for
// once and then carried for the rest of the run. And `POOL_CEILING` is 64,
// which is about a second of pictures at 60 Hz and 14.7 MB at the console's own
// 240 by 240: eight times the deepest this tree's own suite has ever run, and a
// host 64 pictures behind is not late, it is gone.
//
// AND IT IS SAID ONCE, because a skip nobody can see is the thing the plan
// objected to. A ceiling reached is not a late round trip, it is a host that
// has stopped taking blocks back, and the suite reads it: both harnesses above
// forward a `console.warn` off this thread to the case driving them and fail
// the run over it - `watchdog.js` in its own problem list and `plays.js`
// through the `note` lines `cmake/WebPlayerPlays.cmake` refuses a report for.
// So a ceiling reached anywhere under `ctest` is a red case rather than a
// number nobody looks at, and that was confirmed on both by planting a line on
// this thread and watching the cases go red rather than by reading them.
//
// The alpha is filled once per block and never written again: `paint` writes
// three channels a pixel, so a block whose fourth is zero is an invisible
// picture. A block coming back through `spent` keeps the fill it was given.

const POOL_CEILING = 64;
const POOL_KEPT = 2;

let pool = [];
let blocks = 0;
let warned = false;

const takeBlock = () => {
    if (pool.length) { return new Uint8ClampedArray (pool.pop ()); }

    if (blocks >= POOL_CEILING) {
        if (! warned) {
            warned = true;

            console.warn (`player: the renderer has ${POOL_CEILING} blocks of `
                + 'pixels out and none of them back, so it published no '
                + 'picture. The page is committing the last one it was given.');
        }

        return null;
    }

    blocks++;

    const made = new Uint8ClampedArray (
        consumer.frameWidth * consumer.frameHeight * 4);

    made.fill (255);

    return made;
};

// ---------------------------------------------------------------------------
// THE FRAME STAMP, which is the presentation probe's whole purchase on this
// thread and is off on every run but its own.
//
// With `probe: true` in the open message every picture carries the frame it was
// drawn from in its top 24 rows: eight rows of pure red as a locator, then
// sixteen bars of fifteen pixels, black or white, the frame number's bits high
// first. A screen capture of the page can then decode which frame is ACTUALLY on
// the screen, which is the one thing no thread here can say about itself - a
// heartbeat says a picture was drawn and says nothing about whether it was ever
// presented. `docs/presentation-probe.md` is the reading, and
// `docs/archived/safari-presentation-plan.md` section 1 is what it found:
// Safari committed one draw per rendering update and dropped the rest, so a
// burst of drawn frames reached the screen as a cut.
//
// IT COSTS THE TOP 24 ROWS OF THE PICTURE, which is why the field is sent only
// from a page that said `?probe=present` and why every case that plays a game
// through these workers reads pixels this would have painted over.
//
// Sixteen bars of fifteen is exactly `FRAME_WIDTH`, the console's own width; a
// narrower frame loses the bars past its edge. A frame number wraps at
// 65,536 - a run of eighteen minutes at 60 Hz. A probe run longer than that
// reads the low sixteen bits, which is what the decoder expects: the runs it
// measures are tens of frames and a wrap is one bad comparison in eighteen
// minutes.
// ---------------------------------------------------------------------------

let strip = false;

const stamp = (pixels, frame, width) => {
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;

            pixels [at] = 255;
            pixels [at + 1] = 0;
            pixels [at + 2] = 0;
        }
    }

    for (let bar = 0; bar < 16; bar++) {
        const value = (frame >> (15 - bar)) & 1 ? 255 : 0;

        for (let y = 8; y < 24; y++) {
            for (let x = bar * 15; x < Math.min (bar * 15 + 15, width); x++) {
                const at = (y * width + x) * 4;

                pixels [at] = value;
                pixels [at + 1] = value;
                pixels [at + 2] = value;
            }
        }
    }
};

// The game's own renderer and the conversion after it, into a block bound for
// the page.
//
// `renderVideo` answers false for an instance that has been handed no
// description yet, so a repaint before the first step posts nothing rather than
// the zeros a fresh instance begins with - and the page then goes on committing
// whatever it already holds, which on such a run is nothing at all.
//
// `seen` is discarded here and the accumulator with it: the running record of
// which palette entries a run has drawn had exactly one reader, the identity row
// of `web_player_plays_<game>`, and that case reads the entries back out of the
// pixels this call produced.

const draw = () => {
    // Before the run is open there is nothing to draw from and nowhere to put
    // it, and that window is real rather than theoretical: the page builds this
    // worker at `reset` and opens it when the simulation answers, and a refit or
    // a fullscreen transition in between posts a repaint.
    if (! consumer) { return; }

    if (! consumer.renderVideo ()) { return; }

    const view = takeBlock ();

    // The ceiling above, and the only path on which a description that reached
    // this thread does not reach the page. The render has already happened -
    // the block is taken after `render_video` rather than before it, so that a
    // repaint arriving before the first description mints nothing - so what is
    // dropped here is the publish and not the picture.
    if (! view) { return; }

    paint (consumer.frame, consumer.palette, view, 0);

    if (strip) { stamp (view, drawn, consumer.frameWidth); }

    // And out, with the block in the transfer list, which is what makes this a
    // pointer move rather than a quarter of a megabyte copied twice.
    //
    // IT IS THE ONLY THING THIS THREAD SAYS ABOUT A PICTURE, and there is no
    // heartbeat beside it. A `drew` posted here would claim a commit this
    // thread does not make: the page commits, so the page marks the commit, and
    // `RenderWatch` in `player.js` reads the page's mark. What that leaves this
    // message carrying is both halves at once - the pixels, and the fact that
    // this thread is still rendering them.
    self.postMessage ({ kind: 'pixels', frame: drawn,
        width: consumer.frameWidth, height: consumer.frameHeight,
        pixels: view.buffer }, [view.buffer]);
};

// One message from the simulation: a description to draw, the resources scoped
// for `render_video` this instance has not been handed, and the rows of the
// store as the step that captured the description left it.
//
// In that order, and in one message, which is the whole of the delivery rule
// from this end: the bytes land at their addresses, the mirror is made the table
// the description was captured against, and only then is anything drawn - so a
// lock `render_video` makes here is answered and refused exactly as the
// simulation's store would have answered it on that frame.
//
// ALL OF IT HAPPENS ON RECEIPT, the draw included. Nothing here waits for a
// frame, because the frame that mattered has already happened: the page read
// the display, posted the tick this description was stepped on, and will commit
// the block this call is about to hand it.
//
// A SCRUBBED FRAME COMES DOWN THE SAME PATH, marked `scrub`: an old description
// out of the simulation's ring with the rows it was captured against and no
// bytes, because a scrub delivers nothing. The mirror is made that old table
// without forgetting what this instance holds, since the rows lack every id
// loaded since and the simulation will not send those bytes twice -
// `Consumer.mirrorResources` says the rest.

const receive = (said) => {
    if (! consumer) { return; }

    consumer.acceptResources (said.fresh);
    consumer.mirrorResources (said.rows, said.scrub === true);

    consumer.acceptDescriptions ({ videoState: said.videoState });

    drawn = said.frame;

    draw ();
};

self.onmessage = (event) => {
    const message = event.data;

    switch (message.kind) {

    // A new run, which is a new instance and a new linear memory. The page
    // builds a fresh worker for a reset rather than reopening this one, so this
    // happens once per worker.
    //
    // It arrives AFTER the simulation has opened, because everything in it that
    // is not the module is a fact about the simulation's arena: where the
    // description hole is, where the framebuffer is, and where the record a
    // store is composed in sits. The page holds the port from the moment it
    // resets until this message carries it, and it holds the canvas for good.
    case 'open': {
        // The BYTES rather than the compiled module, compiled here: a
        // `WebAssembly.Module` does clone to a dedicated worker, and the page
        // holds the bytes anyway for the worklet that cannot be handed one, so
        // one spelling serves both consumers. `new WebAssembly.Module` compiles
        // synchronously and this thread has nothing else to do yet. The
        // trampoline and the rulebook arrive compiled, and the rulebook is what
        // this instance's mirror of the store is kept in.
        consumer = new Consumer (new WebAssembly.Module (message.bytes),
            message.layout, message.trampoline, message.core);

        // Whether every picture carries its frame number in its top rows, which
        // is the probe's and nothing else's. `=== true` rather than a coercion,
        // because a page that never heard of the field sends nothing and a
        // picture with a red band across it is not a thing to arrive at by
        // accident.
        strip = message.probe === true;

        // The regions the simulation laid down once and never writes again: the
        // argument storage and the save blob `construct` was handed. Both are
        // the host's for the whole run by `interface/game.h:35-50`, so a game
        // may hold a pointer into either and a renderer needs both before the
        // first description can be rendered.
        for (const region of message.resident || []) {
            consumer.accept (region.address, region.bytes);
        }

        // There is no canvas in this message and no context to take. The size
        // the module declared is read off this instance's own `Game` and is
        // what a block is made at, and the page has already sized the element
        // it commits into out of the same declaration.
        //
        // And the channel, started by being listened to. Everything this thread
        // ever draws arrives here; the message above is the only one the page
        // sends that is not a repaint or a block coming back.
        stream = message.port;
        stream.onmessage = (said) => receive (said.data);

        // And the one thing this thread says that is not about a picture: it
        // is up.
        //
        // It is what ARMS the page's render watchdog, and a watchdog needs it
        // for the reason `RenderWatch` in `player.js` states: the simulation's
        // is armed by its first answer, which arrives every display frame
        // whether or not anything stepped, and a renderer answers only when it
        // has drawn - so the case this whole split exists for, a `render_video`
        // that never returns from its FIRST call, would arm nothing and be
        // reported by nothing. Everything before this line is a thread still
        // starting: the worker's own fetch, the `importScripts` above, and the
        // compile two statements up, none of which is bounded and none of which
        // is a hang.
        //
        // Posted after the port is listened to rather than before, so the
        // ordering the page reads is the real one: this thread is open, and
        // then it draws.
        self.postMessage ({ kind: 'ready' });

        break;
    }

    // A block the page has finished with, back in the pool - or let go of,
    // where the pool already holds its two.
    //
    // It arrives on the page's own receipt of the NEXT one rather than on its
    // commit, which is what keeps this circulating through a halt: a paused or
    // resting page commits the block it holds over and over and is handed no
    // new one, so nothing is owed back and nothing is waiting.
    //
    // A RETURN PAST `POOL_KEPT` IS DROPPED, which is the other half of the
    // ceiling above and what keeps a burst from being carried for ever. A host
    // that ran eight pictures ahead of its own drain hands those blocks back
    // once it catches up, and a pool that kept them all would hold that
    // burst's memory for the rest of the run and count it against the ceiling
    // the whole time. Dropping is exactly what it says: the reference goes,
    // the page has none either, and the engine reclaims it.
    //
    // `blocks` is this thread's own count and not an accounting identity: the
    // block a page hands a REPLACED renderer was minted by the thread before
    // it, so a run that has replaced one can hold one more block than this
    // count says. That is the direction to be wrong in - it makes the ceiling
    // one block more generous - and it is bounded by one per replacement,
    // which is one per run.
    case 'spent':
        if (pool.length < POOL_KEPT) { pool.push (message.buffer); }
        else { blocks--; }

        break;

    // The page has done something to the canvas that no state of the game can
    // account for - a refit, a fullscreen transition, the HUD coming and going -
    // and wants the frame drawn again whatever the last step claimed.
    //
    // It costs one `render_video` and one block over the description this
    // instance is already holding, and the page commits what comes back on its
    // next animation frame.
    //
    // A RE-COMMIT WOULD NOT DO, which is why this message still exists now that
    // the page writes the canvas on every frame it is given. That write is the
    // same bytes again; a caller here has had the canvas change under it - a
    // refit, a fullscreen transition, the HUD coming and going, a return from
    // hidden - and wants the frame RENDERED again whatever the last step
    // claimed. Nothing on this thread and nothing on the page's can produce
    // that except running the game's renderer, which is this.
    //
    // There is nothing to coalesce: a repaint is one request rather than a
    // burst. And the block it produces carries the frame the last description
    // carried, so the page recognises it as a picture it has already committed
    // and marks no new commit for it - which is `RenderWatch`'s rule kept from
    // the far end, and a hole closed rather than carried: the heartbeat this
    // draw used to post cleared a wait the renderer still owed.
    case 'repaint':
        draw ();

        break;

    // The run is over. The page terminates this thread, so what is left to do
    // is say so on the channel: a port left open on a terminated thread is a
    // port that can never be posted to again, and closing this end is what lets
    // the simulation close its own.
    //
    // Dropping the instance is what stops a description still in the port's
    // queue from being rendered into a block for a run that no longer exists.
    case 'close':
        if (stream) { stream.close (); stream = null; }

        consumer = null;
        pool = [];
        blocks = 0;

        break;
    }
};
