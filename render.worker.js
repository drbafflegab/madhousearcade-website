// The thread the picture is drawn on, and the only thread that holds a canvas.
//
// It is a second instance of the game's own module - `Consumer` in `player.js`,
// the class the worklet already holds - handed the video description the
// simulation captured after a step and each task block a description can name,
// and never a state block. It runs the game's own `render_video` on those
// bytes, turns the framebuffer into rgba with the same `paint` every host here
// spends, and writes it into the `OffscreenCanvas` the page transferred. The
// simulation steps; nothing on that thread draws.
//
// WHY THE PICTURE IS HERE AT ALL, since it costs a display frame and buys no
// throughput: a `render_video` that never returns used to take the run with it,
// because it ran on the thread that steps. It wedges a thread the page can
// replace now, and the simulation plays on. The trade is argued and the frame
// is priced in `docs/archived/render-worker-plan.md` - about 16.7 ms at 60 Hz,
// measured three ways - and the sentence it insists on is that the frame is
// PAID rather than avoided.
//
// IT OWNS NO ANIMATION FRAME, and that is the one place this is simpler than
// the simulation beside it. A renderer with a frame loop would have something to
// redraw between two states at a new alpha, and there is nothing: the blend was
// removed at `1a9078e`, so a picture is a function of one description and
// redrawing it would produce the pixels already on the canvas. So this draws ON
// RECEIPT, in the message handler, which the plan measured at the same latency
// as a frame loop to a tenth of a millisecond. It also means there is no halt
// here - the page halts the simulation's clock, nothing is posted, and nothing
// is drawn.
//
// THE DELIVERY RULE, from the receiving end. A description names a task by ID
// where a state block carried a pointer, so a description naming an id whose
// block this instance does not hold is a picture drawn out of bytes that are not
// there. The simulation posts every block this instance has not been handed
// BEFORE the description that can name one, down one port, which delivers in
// order - so the rule is kept by the sender and read here as an ordering rather
// than as a check. `<game>_mirror_<replay>` is the case that would catch it
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
// for.

// `player.js` and nothing else, exactly as the simulation beside it: `Consumer`,
// `paint` and the two figures below are all that one file's, so this is a
// message protocol and no second host.
importScripts ('player.js');

// The second instance, or null before the page has opened a run. Built at
// `open` rather than at startup, because the addresses it renders into are the
// simulation's and the page cannot say what they are until its arena is down.

let consumer = null;

// The canvas the page gave away, as the context this thread draws through, and
// the port the simulation publishes down. Null until the run is opened and never
// null after it: a host that has neither has no reason to have started this
// thread at all, so the `open` below takes both and guards for neither. The page
// refuses a browser that will not transfer a canvas rather than playing on
// blind, and it builds no renderer without a channel.
//
// `image` and its `rgba` view are made once and reused, exactly as the page made
// them and the simulation made them after it: `paint` writes three channels a
// pixel and the alpha is filled once and never written again, which is one pass
// over a quarter of a megabyte saved on every frame.
//
// NOTHING IS EVER SENT BACK ON THE PORT. The channel runs one way, from the
// thread that steps to this one, because a renderer that answered would be a
// renderer the simulation waited on - and the whole of what splitting the two
// buys is that it waits on none. What this thread says, it says to the PAGE.

let screen = null;
let image = null;
let rgba = null;
let stream = null;

// The frame the newest description was captured after, which is the number the
// heartbeat below carries. Zero until one has arrived.

let drawn = 0;

// The game's own renderer and the conversion after it, into the canvas the page
// gave away.
//
// `renderVideo` answers false for an instance that has been handed no
// description yet, so a repaint before the first step paints nothing rather
// than the zeros a fresh instance begins with - which is what the canvas
// already shows.
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

    paint (consumer.frame, consumer.palette, rgba, 0);

    screen.putImageData (image, 0, 0);

    // The heartbeat, posted per draw and carrying the frame the description
    // this instance last rendered was captured after.
    //
    // It is the page's half of what a second thread costs: a renderer that has
    // stopped answering while the simulation goes on answering is a wedged
    // RENDERER, and the page replaces it rather than ending the run.
    // `RenderWatch` in `player.js` is the rule that reads it, `player.html`
    // drives it on its own animation frame, and two harnesses read it for
    // something narrower - `products/web-player/tests/plays.js` waits on it to
    // know a paint has landed, and `products/web-player/tests/watchdog.js`
    // counts its absence.
    self.postMessage ({ kind: 'drew', frame: drawn });
};

// One message from the simulation: a task's bytes, or a description to draw.
//
// The two are told apart by `address`, exactly as the worklet's processor tells
// them apart, because both are plain objects and neither carries a kind: this
// channel has two shapes on it and one reader.
//
// NOTHING EXPIRES A BLOCK HERE. The simulation reclaims a released block at the
// frame boundary that settles the release; the copy here is this instance's own
// and is kept until a delivery under the same id replaces it, which is what
// `interface/game.h` promises a description - the block is held until a
// description captured after the release has been rendered.

const receive = (said) => {
    if (! consumer) { return; }

    if (said.address !== undefined) {
        consumer.acceptTask (said.id, said.address, said.bytes);

        return;
    }

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
    // reader is composed in sits. The page holds the canvas and the port from
    // the moment it resets until this message carries them.
    case 'open': {
        // The BYTES rather than the compiled module, compiled here: a
        // `WebAssembly.Module` does clone to a dedicated worker, and the page
        // holds the bytes anyway for the worklet that cannot be handed one, so
        // one spelling serves both consumers. `new WebAssembly.Module` compiles
        // synchronously and this thread has nothing else to do yet.
        consumer = new Consumer (new WebAssembly.Module (message.bytes),
            message.layout, message.trampoline);

        // The regions the simulation laid down once and never writes again: the
        // argument storage and the save blob `construct` was handed. Both are
        // the host's for the whole run by `interface/game.h:34-44`, so a game
        // may hold a pointer into either and a renderer needs both before the
        // first description can be rendered.
        for (const region of message.resident || []) {
            consumer.accept (region.address, region.bytes);
        }

        // `alpha: false` exactly as the page asked for it and the simulation
        // asked for it before this: the framebuffer is opaque by construction
        // and the alpha bytes are filled once. `createImageData` gives a block
        // of zeros, so the fill is what makes every pixel opaque before `paint`
        // writes the three channels it writes.
        screen = message.canvas.getContext ('2d', { alpha: false });
        image = screen.createImageData (FRAME_WIDTH, FRAME_HEIGHT);
        rgba = image.data;

        rgba.fill (255);

        // And the channel, started by being listened to. Everything this thread
        // ever draws arrives here; the message above is the only one the page
        // sends that is not a repaint.
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

    // The page has done something to the canvas that no state of the game can
    // account for - a refit, a fullscreen transition, the HUD coming and going -
    // and wants the frame drawn again whatever the last step claimed.
    //
    // It costs one `render_video` and one `putImageData` over the description
    // this instance is already holding, and it is answered on the message
    // because there is nothing else to answer it on: this thread has no frame
    // loop to wait for. `redraw` in `player.html` is the caller and prices what
    // it is for.
    case 'repaint':
        draw ();

        break;

    // The run is over. The page terminates this thread, so what is left to do
    // is say so on the channel: a port left open on a terminated thread is a
    // port that can never be posted to again, and closing this end is what lets
    // the simulation close its own.
    case 'close':
        if (stream) { stream.close (); stream = null; }

        consumer = null;

        break;
    }
};
