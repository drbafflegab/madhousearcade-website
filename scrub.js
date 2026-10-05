// The scrub bar: the track a paused page floats over the bottom of the console
// under `?scrub=on`, and the label that names a new tempo for a moment.
//
// `player.html` owns everything about it that is a decision - the keys, the
// pacing, when the bar opens and shuts and what the simulation is asked - and
// `sim.worker.js` owns the ring and the cursor. What is left here is the
// picture of where the cursor stands and the hand on it: one track, filled from
// the oldest frame the ring still holds up to the cursor, with the cursor drawn
// across it, and a pointer that sets the cursor where it presses and drags it
// from there.
//
// NOTHING ELSE ON IT, which is the owner's reading of the first version: the
// floor, the head and the frame number were text nobody needed while looking,
// and a tick per recorded input was a mark nobody could read. What that gives
// up is the frame number as a bridge to `inspector dump --frame`, which the
// bar no longer prints; the simulation still answers every move with it.
//
// OVER THE CONSOLE, AND ONLY HERE. The page keeps its chrome off the picture
// for the ordinary player, and under `?scrub=on` the owner decided on
// 2026-10-05 that the bar and the tempo label go over it - the bar 12 px in
// from the sides and the bottom of the canvas's box, the label in the middle -
// so this is a decision for this mode and not an oversight. Neither takes room
// in the flow, so neither is in `available` and neither refits the canvas;
// both read the canvas's box when they are placed, and the bar is placed again
// whenever that box can have moved: a refit, a resize, fullscreen.
//
// A CLASSIC SCRIPT AND A CONTINUATION OF THE PAGE'S OWN, as `probe.js` is: the
// page appends it after its own script has run, two classic scripts share one
// global lexical environment, and the three functions the page's hooks call
// are declared here - `scrubShown` with each answer the simulation gives,
// `scrubHide` when the pause ends, and `scrubTempoShown` when `S` changes the
// speed. The page asks whether they exist before calling them, because this
// file is fetched and an answer can beat it.

// The bar and its track, built once on first use and kept for the life of the
// page: a reset is a new ring under the same bar.
let scrubParts = null;

// The newest frame the pointer asked for and not yet posted, whether a move is
// on its way to the simulation and unanswered, and whether an animation frame
// is already booked to post one. A drag asks far faster than a renderer draws,
// so at most one move is outstanding: the newest target waits for the answer
// to the last, and the ones in between were never wanted.
let scrubWanted = null;
let scrubAwaiting = false;
let scrubBooked = false;

function scrubBuild () {
    const style = document.createElement ("style");

    // In the page's own palette variables, so the bar is whatever colours the
    // game chose, and opaque - the track paints the panel colour edge to edge -
    // so the cursor reads against any picture under it. `[hidden]` said again
    // for `#hud`'s reason: an author `display` outranks the attribute.
    // `touch-action: none` on the track, so a finger dragged along it scrubs
    // rather than scrolling the page.
    style.textContent = `
      #scrub { position: fixed; z-index: 10; display: flex; }
      #scrub[hidden] { display: none; }
      #scrub canvas { flex: 1; min-width: 0; height: 28px; cursor: pointer;
                      touch-action: none; border: 1px solid var(--edge);
                      border-radius: 6px; }
    `;

    document.head.appendChild (style);

    const row = document.createElement ("div");
    const track = document.createElement ("canvas");

    row.id = "scrub";
    row.hidden = true;

    track.title = "Scrub: drag, or the arrows step a frame and play held, "
        + "Shift goes a second; Escape resumes";

    row.append (track);

    document.body.appendChild (row);

    // Placed again on every change that can move the canvas's box: its size,
    // through the observer, and its place, which a resize or a fullscreen
    // change moves without always changing its size. The page's own listeners
    // for both were registered first, so the refit has happened by the time
    // these run.
    const again = () => {
        if (scrubAt && ! row.hidden) { scrubDraw (scrubAt); }
    };

    new ResizeObserver (again).observe (canvas);

    addEventListener ("resize", again);
    document.addEventListener ("fullscreenchange", again);

    track.addEventListener ("pointerdown", (event) => {
        if (! scrubAt) { return; }

        track.setPointerCapture (event.pointerId);

        scrubAsk (scrubTarget (event));

        event.preventDefault ();
    });

    track.addEventListener ("pointermove", (event) => {
        if (! scrubAt || ! track.hasPointerCapture (event.pointerId)) {
            return;
        }

        scrubAsk (scrubTarget (event));
    });

    // A release lets the capture go of its own accord; a cancellation is said
    // out loud, so a palm or an edge gesture leaves no drag behind.
    track.addEventListener ("pointercancel", (event) => {
        if (track.hasPointerCapture (event.pointerId)) {
            track.releasePointerCapture (event.pointerId);
        }
    });

    scrubParts = { row, track };
}

// The frame under the pointer, clamped to what the ring holds.
function scrubTarget (event) {
    const box = scrubParts.track.getBoundingClientRect ();
    const at = Math.min (Math.max ((event.clientX - box.left)
        / Math.max (box.width, 1), 0), 1);

    return scrubAt.floor + Math.round (at * (scrubAt.head - scrubAt.floor));
}

// The pointer wants this frame. Kept as the newest wish, and posted on the
// next animation frame unless a move is still unanswered - in which case the
// answer posts it.
function scrubAsk (target) {
    scrubWanted = target;

    if (scrubBooked) { return; }

    scrubBooked = true;

    requestAnimationFrame (scrubFlush);
}

// One move toward the newest wish, silent like a single step.
function scrubFlush () {
    scrubBooked = false;

    if (scrubWanted === null || scrubAwaiting || ! scrubAt) { return; }

    const frames = scrubWanted - scrubAt.frame;

    scrubWanted = null;

    if (frames === 0) { return; }

    scrubAwaiting = true;

    scrubMove (frames, false);
}

// One colour of the page's, as it stands now: the game's palette arrives after
// this file may have been parsed, so it is read at each draw.
function scrubColour (name) {
    return getComputedStyle (document.documentElement)
        .getPropertyValue (name).trim ();
}

// Where the bar goes: 12 px in from both sides of the canvas's box and its
// bottom edge 12 px above the box's, read off the box as it stands now - the
// rect after the grid-snapping translate, which is where the picture is.
const SCRUB_INSET = 12;

function scrubPlace () {
    const { row, track } = scrubParts;
    const box = canvas.getBoundingClientRect ();

    row.style.left = (box.left + SCRUB_INSET) + "px";
    row.style.width = Math.max (0, box.width - 2 * SCRUB_INSET) + "px";
    row.style.top = (box.bottom - SCRUB_INSET - track.offsetHeight) + "px";
}

function scrubDraw (at) {
    scrubPlace ();

    const { track } = scrubParts;
    const ratio = devicePixelRatio || 1;
    const width = Math.max (1, Math.round (track.clientWidth * ratio));
    const height = Math.max (1, Math.round (track.clientHeight * ratio));

    if (track.width !== width) { track.width = width; }
    if (track.height !== height) { track.height = height; }

    const context = track.getContext ("2d");
    const cursor = Math.max (3, Math.round (3 * ratio));
    const span = Math.max (at.head - at.floor, 1);
    const x = Math.round ((at.frame - at.floor) / span * (width - cursor));

    context.fillStyle = scrubColour ("--panel");
    context.fillRect (0, 0, width, height);

    // The track filled up to the cursor.
    context.fillStyle = scrubColour ("--hover");
    context.fillRect (0, 0, x, height);

    // The cursor, in the alarm colour where the simulation refused the picture:
    // the slot names a resource the renderer no longer holds, so what is on
    // the canvas is the last frame drawn rather than this one.
    context.fillStyle = scrubColour (at.stale ? "--alarm" : "--ink");
    context.fillRect (x, 0, cursor, height);
}

// An answer from the simulation: where the cursor is now, and what the ring
// holds. The first one after a pause is what shows the bar, and every one is
// what lets a drag post its next move.
function scrubShown (at) {
    if (! scrubParts) { scrubBuild (); }

    const { row } = scrubParts;

    // Shown with no refit: the bar floats over the picture and the canvas
    // keeps the room it had.
    row.hidden = false;

    scrubDraw (at);

    scrubAwaiting = false;

    if (scrubWanted !== null) { scrubAsk (scrubWanted); }
}

// The pause ended, so the bar goes and a drag still under way has nothing left
// to move.
function scrubHide () {
    scrubWanted = null;
    scrubAwaiting = false;

    if (! scrubParts || scrubParts.row.hidden) { return; }

    scrubParts.row.hidden = true;
}

// ---------------------------------------------------------------------------
// The tempo, said for a moment after `S` changes it - `full speed`, `½ speed`
// or `¼ speed` - and gone again 1.2 s later; a second press says the new one
// and starts the moment again.
//
// FIXED RATHER THAN IN THE FLOW, so showing it moves nothing: no row appears,
// `available` counts nothing new and the canvas is not refitted under a person
// who only asked for a speed. In the MIDDLE of the console's box, read off the
// canvas when it is shown - the owner's placement, over the picture, which the
// header above says is this mode's alone - and large enough, on the panel
// colour, to read at a glance over any game.
// ---------------------------------------------------------------------------

let scrubTempoLabel = null;
let scrubTempoTimer = null;

const SCRUB_TEMPO_MS = 1200;

function scrubTempoShown (divisor) {
    if (! scrubTempoLabel) {
        scrubTempoLabel = document.createElement ("div");

        scrubTempoLabel.style.cssText = "position:fixed;z-index:10;"
            + "transform:translate(-50%,-50%);pointer-events:none;"
            + "background:var(--panel);color:var(--ink);"
            + "border:1px solid var(--edge);border-radius:6px;"
            + "padding:6px 14px;font-size:18px;font-weight:700;"
            + "white-space:nowrap;";

        document.body.appendChild (scrubTempoLabel);
    }

    const label = scrubTempoLabel;

    // Escaped rather than typed, so the two fractions survive whatever charset
    // a server says this file is in.
    label.textContent = divisor === 4 ? "\u00bc speed"
        : divisor === 2 ? "\u00bd speed" : "full speed";

    // Centred on the canvas's box on both axes; the translate above puts the
    // label's own middle there whatever its text measures.
    const box = canvas.getBoundingClientRect ();

    label.style.left = (box.left + box.width / 2) + "px";
    label.style.top = (box.top + box.height / 2) + "px";
    label.hidden = false;

    if (scrubTempoTimer !== null) { clearTimeout (scrubTempoTimer); }

    scrubTempoTimer = setTimeout (() => {
        scrubTempoTimer = null;
        label.hidden = true;
    }, SCRUB_TEMPO_MS);
}
