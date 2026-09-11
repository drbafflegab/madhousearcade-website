// The player's browser-free half: everything between a module's bytes and the
// pixels a host hands to a screen.
//
// `player.html` is the other half, and the line between them is exactly the
// browser. Anything that touches `document`, a canvas, an `AudioContext` or
// `requestAnimationFrame` is in the page; nothing else is. What is left here is
// the whole of what a host has to get right about a game - the struct offsets,
// the two records it hands a game and the trampoline that makes them callable,
// the answer protocol, the input queue, the clock that decides how many steps
// an interval owes and the palette - and it lives in a file of its own so that
// it can be run without a browser at all.
// `cmake/WebPlayerPlays.cmake` is what runs it that way, over the assembled
// site, and its header says which of the page's claims survive the move and
// which went with the browser.
//
// THERE ARE TWO SIDES OF THE GAME IN HERE NOW, and the line between them is a
// thread rather than a browser. `Session` is the SIMULATION - it constructs,
// steps, runs the tasks and records - and `Consumer` is what renders somewhere
// else: a second instance of the same module, handed the state block and each
// task block at their own addresses, on which the game's own `render_video`,
// `render_audio` and `save` are called and `construct` and `step` never are.
// `sim.worker.js` holds the first and the page holds the second, and both are
// this file's because a consumer needs no browser either.
//
// Loaded three ways, and it has to stay loadable all three:
//
// - As a classic `<script src="player.js">` ahead of the page's own inline
//   script, where every declaration below lands in the global lexical scope the
//   inline script then reads. Not a module script: that is a second set of MIME
//   rules to satisfy on somebody's static host, for nothing the page needs.
// - Through `importScripts` in `task.worker.js` and `sim.worker.js`, which is
//   the same classic-script rule one realm over.
// - As CommonJS under node, through the four lines at the foot of this file.
//   `module` is undefined in a browser, so the page never runs them.

"use strict";

// ---------------------------------------------------------------------------
// Struct layout.
//
// Mirrors interface/game.h for wasm32, where pointers are 4 bytes. THIS MUST BE
// KEPT IN STEP WITH THE HEADER BY HAND: nothing here reads DWARF, so a field
// added to Game or Channel shifts these offsets silently. The eventual fix is
// to generate this block from the module's own debug info, which the CLI will
// be able to do once it parses DWARF.
// ---------------------------------------------------------------------------

const LAYOUT = {
    // `taskMax` is the newest member and `bytes` moved 52 to 56 with it, which
    // is the whole toll a tail addition charges this mirror: no offset above it
    // moved, on either target. Verified against the built modules rather than
    // read off the header - `factory` writes 2 at offset 52 of
    // `games/example/artifacts/example.wasm` and nothing at 56, and a module
    // declaring none leaves the word the host zero filled.
    //
    // A mirror that FORGOT this member reads 0, and 0 is the legal declaration
    // meaning *this game spawns nothing* - so the page would refuse every spawn
    // a working game makes. That is why `web_player_plays`'s identity check has
    // `task_max` as its sixth field and why `games/example` declares a non-zero
    // one, exactly as `games/pong` declares a non-zero `background`.
    //
    // ARGUMENTS MOVED NOTHING HERE, and that is the thing to know about them at
    // this offset table. A game declares nothing about them - a run passes
    // pairs through and a game reads the ones it recognises by name - so no
    // member went in, `bytes` is what it was before a run could be told
    // anything at all, and the identity check `web_player_plays` runs is six
    // fields rather than seven. What arguments DID move is `construct`'s
    // ARITY, which no offset in this block can see and which the arity check
    // further down is the whole reader of.
    // SAVE STATE moved two members in, at the tail again, and `bytes` went 56
    // to 64. `saveSize` is read for the same reason `taskMax` is - a mirror one
    // field short reads 0, which is the legal declaration meaning *this game
    // persists nothing*, so a saving game would be constructed from null with
    // every other check green.
    // THE CAPTURES moved four more in, at the tail again, and `bytes` went 64
    // to 80. The two sizes fail exactly as `saveSize` does - a mirror one field
    // short reads 0, which is the legal declaration meaning *the state block IS
    // the description* - so a game that captures would be handed its own block
    // and drawn from the wrong bytes. Every game in this tree declares 0 today
    // and this page refuses anything else by name, which is what stops the two
    // paths coexisting before there is a second one to coexist with.
    //
    // A BLEND SAT BETWEEN THE SAVE PAIR AND THE CAPTURES, at 64, and every
    // offset behind it was four bytes further out while it did. It is gone, and
    // the four that follow moved down with it - which is the one edit a tail
    // rule cannot spare a hand-written mirror, and the reason every figure here
    // was taken from the header's own assert rather than counted.
    game: { size: 0, name: 4, version: 8, palette: 20, construct: 24,
            step: 28, renderVideo: 32, renderAudio: 36, controls: 40,
            background: 48, taskMax: 52, saveSize: 56, save: 60,
            videoStateSize: 64, audioStateSize: 68, captureVideo: 72,
            captureAudio: 76, bytes: 80 },

    // Game_Task, which a game points at when it spawns. Read through the
    // pointer one call hands over rather than walked as an array, like
    // `resource` below: nothing declares a set of these, so a wrong offset
    // costs one descriptor read as garbage rather than every entry after the
    // first.
    //
    //     0 | const char * name
    //     4 | Game_Task_Body * body
    //     8 | uint32_t input_size
    //    12 | uint32_t scratch_size
    //    16 | uint32_t output_size
    //       | [sizeof=20, align=4]
    task: { name: 0, body: 4, inputSize: 8, scratchSize: 12, outputSize: 16,
            bytes: 20 },

    // Game_Task_Runner, the record `construct` and `step` are handed - and one
    // of the two blocks in this file that this mirror WRITES rather than reads.
    //
    //     0 | void * context
    //     4 | uint32_t (* spawn) (void *, Game_Task const *, void const *)
    //     8 | _Bool (* done) (void *, uint32_t)
    //    12 | const void * (* bytes) (void *, uint32_t)
    //    16 | void (* release) (void *, uint32_t)
    //       | [sizeof=20, align=4]
    //
    // 20 rather than the native 40, because all five members are pointers and
    // a wasm32 pointer is four bytes where a native one is eight. The header's
    // `static_assert` is target-conditional for that reason.
    //
    // `stride` rather than `bytes` for the record's own size, which every other
    // block here spells `bytes`: this record HAS a member called `bytes`, and one
    // key cannot be both. `Game_Task_Result` and its `LAYOUT.result` block went
    // with the results array - a game asks about a task by id now, so nothing
    // about an answer crosses this boundary as a struct at all.
    //
    // The four function members are TABLE INDICES here rather than addresses. A
    // game imports nothing, so it reaches a host by `call_indirect` on its own
    // `__indirect_function_table`, and what goes in these words is where
    // `installTrampoline` put this host's wrappers in that table.
    runner: { context: 0, spawn: 4, done: 8, bytes: 12, release: 16,
              stride: 20 },

    // Game_Resource_Loader, the record a task BODY is handed - written into the
    // body's own instance rather than into the game's, because that is where a
    // body runs and what it can reach.
    //
    //     0 | void * context
    //     4 | uint32_t (* load) (void *, Game_Resource const *, void *,
    //       |                    uint32_t)
    //       | [sizeof=8, align=4]
    //
    // 8 against the native 16, for the reason above. Two members and not three:
    // a body reads files and cannot spawn, which `interface/game.h` says with a
    // parameter list and this mirror says again with a shorter record.
    loader: { context: 0, load: 4, bytes: 8 },

    // Game_Task_Reader, the record every RENDERER is handed - and the third
    // block in this file this mirror writes rather than reads.
    //
    //     0 | const void * context
    //     4 | const void * (* bytes) (const void *, uint32_t, uint32_t *)
    //       | [sizeof=8, align=4]
    //
    // 8 against the native 16, for the reason the loader is 8 against 16. Two
    // members and not five: a renderer names a task's bytes and can do nothing
    // else, which `interface/game.h` says with a parameter list and this mirror
    // says again with a shorter record.
    //
    // `stride` rather than `bytes` for the record's own size, for the reason
    // `runner` above spells it that way: this record HAS a member called
    // `bytes`, and one key cannot be both.
    reader: { context: 0, bytes: 4, stride: 8 },

    // Game_Controls, whose members are offsets within it rather than within
    // Game - `game.controls` above says where it starts. Two `Game_Need`s, and
    // a Game_Need is a C23 enum with an explicit `: int32_t`, so four bytes
    // each and four bytes on the native target too.
    //
    //     0 | Game_Need buttons
    //     4 | Game_Need pointer
    //       | [sizeof=8, align=4]
    //
    // It sat LAST in Game when it arrived, and that is what this block is
    // evidence of: adding it moved no offset above, so the mirror gained two
    // constants rather than editing eleven. `background` went in after it and
    // cost exactly the same - one offset and a new `bytes` - and `task_max`
    // after that cost the same again, which is why the tail is where Game grows
    // and where the next member goes too.
    //
    // What moved everything from `construct` on was the manifest LEAVING the
    // struct: its array, its count and the entry that filled in a wanted set
    // were deleted rather than relocated, so `Game` lost twelve bytes and every
    // offset after `palette` shifted by them at once. That is the largest
    // change this mirror has taken and the shape it gets wrong in silence,
    // which is why the dump above was run again rather than the numbers being
    // adjusted by hand.
    controls: { buttons: 0, pointer: 4, bytes: 8 },

    // Game_Input's pointer member, again as offsets within Game_Input. The six
    // buttons are two bytes each from 0, which the loop in `advance` computes;
    // everything past them is here because nothing computes it.
    //
    //    12 | Game_Pointer pointer
    //    12 |   uint8_t x
    //    13 |   uint8_t y
    //    14 |   _Bool present
    //    15 |   Game_Button_State primary       (held 15, edge 16)
    //    17 |   Game_Button_State secondary     (held 17, edge 18)
    //    19 |   _Bool hovers
    //       | [sizeof=20, align=1]
    //
    // Every member of Game_Input is a byte, so there is no padding in it at all
    // and the native layout is identical - unlike `event` above, which holds a
    // pointer and therefore differs between the two targets.
    pointer: { x: 12, y: 13, present: 14, primary: 15, secondary: 17,
               hovers: 19 },

    inputBytes: 20,   // 6 buttons { held, edge }, then Game_Pointer
};

// ---------------------------------------------------------------------------
// The host core's own layout and vocabulary.
//
// `products/host-core` is the rulebook every host has to agree on, compiled
// natively into `inspector` and to `host-core.wasm` for this file - so the task
// table and the validity of an id, release and residency, argument settling,
// descriptor grammar and the ring a runner's context is stamped with are one
// implementation rather than three. `docs/host-core-rules.md` is the
// measurement that says which sentences those are and where each one used to
// live; `docs/archived/host-core-plan.md` is why they moved.
//
// IT HAS A LINEAR MEMORY OF ITS OWN, separate from the game's, and nothing
// crosses between them but bytes: a descriptor goes in as a blob, a settled
// pair comes back as a blob, and a task's output block is an opaque number the
// core stores beside an id and never dereferences. That is the copy
// `interface/game.h` already mandates - `task` and `input` are copied during
// the call and never retained - relocated one memory along, which is what lets
// this host embed a freestanding wasm module rather than share a heap with one.
//
// Mirrored by hand for wasm32 exactly as `LAYOUT` above is, and the same
// warning applies: nothing here reads DWARF, so a member added to
// `Host_Core_Task` shifts these silently. What is NOT mirrored is any capacity
// - `host_core_figure` answers those, because a number written down here would
// be exactly the hand mirror this migration exists to delete.
// ---------------------------------------------------------------------------

const CORE = {
    // `Host_Core_Figure`, which is how a JavaScript host reads a figure the
    // console reads off an enumerator in the header.
    figure: { contextRing: 0, argumentMax: 1, argumentNameMax: 2,
              argumentTextMax: 3, saveMax: 4 },

    // `Host_Core_Context_Check`. `absent` is a slot outside the ring and its
    // construct twin, which is what a non-null context that is not one of this
    // host's arrives as.
    context: { live: 0, stale: 1, absent: 2 },

    // `Host_Core_Spawn_Verdict`, and the answer it arrives in:
    //
    //     0 | uint32_t id
    //     4 | Host_Core_Spawn_Verdict verdict
    //     8 | uint32_t input_size
    //       | [sizeof=12, align=4]
    //
    // One CONDITION and four bugs. `crowded` is the game already holding every
    // id it declared, which is answered with the 0 the game acts on; the rest
    // end the run, and `input_size` is the figure two of their sentences quote.
    verdict: { accepted: 0, crowded: 1, bodyless: 2, unfed: 3, overfed: 4,
               full: 5 },
    spawn: { id: 0, verdict: 4, inputSize: 8, bytes: 12 },

    // `Host_Core_Id`, which is the whole of what `done`, `bytes` and `release`
    // are held to: the table is the oracle, past the counter is an id no spawn
    // returned, and absent below it is one the game let go.
    id: { live: 0, none: 1, unissued: 2, released: 3 },

    // `Host_Core_Arguments_Verdict`, and `Host_Core_Arguments` beside it:
    //
    //     0 | Host_Core_Arguments_Verdict verdict
    //     4 | size_t at
    //     8 | size_t earlier
    //    12 | size_t span
    //       | [sizeof=16, align=4]
    //
    // `at` and `earlier` index the CALLER's list rather than the sorted one, so
    // a refusal quotes what was typed rather than what sorted into its place.
    //
    // TWO CALLS ANSWER OUT OF ONE VOCABULARY, in the order they run.
    // `host_core_extract_seed` reaches `unseeded` and `repeated`;
    // `host_core_settle_arguments` reaches everything but `unseeded`, because
    // settling never reads a value as a number.
    argument: { taken: 0, crowded: 1, unnamed: 2, longName: 3, unseeded: 4,
                repeated: 5, unvalued: 6, longValue: 7 },
    settled: { verdict: 0, at: 4, earlier: 8, span: 12, bytes: 16 },

    // `Host_Core_Seed`, which is what a run said about the one term every run
    // has:
    //
    //     0 | uint32_t seed
    //     4 | _Bool named
    //       | [sizeof=8, align=4]
    //
    // `named` is the whole of the answer for a run that told none. The number
    // beside it is 0 and stands for nothing: what to construct with instead is
    // the host's own policy rather than a figure the rulebook has, and this
    // one's policy is that its composer already filled the query.
    seed: { seed: 0, named: 4, bytes: 8 },

    // `Host_Core_Pair`: two pointers into the core's own memory, and the
    // strings behind them are copied out of it before the call returns.
    pair: { name: 0, value: 4, bytes: 8 },

    // `Host_Core_Resource_Verdict`, which of the six a descriptor broke.
    resource: { legal: 0, unnamed: 1, unformatted: 2, badPath: 3,
                longToken: 4, longFile: 5 },

    // `Host_Core_Task`, one row of the table:
    //
    //     0 | uint32_t id
    //     4 | uint32_t spawned
    //     8 | uint32_t finished
    //    12 | uint32_t output_size
    //    16 | uintptr_t block
    //    20 | size_t span
    //    24 | Host_Core_Task_State state
    //    28 | _Bool constructed
    //    29 | _Bool staged
    //    30 | _Bool staged_failed
    //    31 | _Bool dead
    //       | [sizeof=32, align=4]
    //
    // `block` is an address in the GAME's linear memory, and that is the whole
    // of what an opaque `uintptr_t` buys: two memories, one number, and no way
    // for the rulebook to read a byte it was not handed.
    row: { id: 0, spawned: 4, finished: 8, outputSize: 12, block: 16,
           span: 20, state: 24, constructed: 28, staged: 29, stagedFailed: 30,
           dead: 31, bytes: 32 },

    // `Host_Core_Task_State`, as the words a dump prints. `running` is not one
    // of them and cannot be: WHERE a body is executing is the embedder's
    // business, so the table says `ready` from the spawn onwards and this file
    // supplies that word from what it knows about its own threads.
    state: ["ready", "failed", "resident", "empty"],
};

// What the page passes for an array with nothing in it. Null is the count-zero
// spelling and nothing else, which is `interface/game.h`'s own sentence: an
// array is its count long, so a null at a non-zero count is a contract
// violation rather than an empty one.
const NOTHING = 0;

// What `context` carries in the runner record this host composes, and the frame
// that record was armed for.
//
// `interface/game.h` makes `context` the capability: opaque to the game, never
// examined by it, handed straight back as the first argument of `spawn` and
// `release`, and validated by the host at every entry. What this host puts
// there is a number carrying the frame, so the validation `console.c` does by
// comparing a `Runner_Context`'s `frame` is arithmetic here - a record used a
// step after the one it was armed for still names that step, and is refused by
// name.
//
// One of these where the console has two halves, because the LOADER's context
// is minted where a body runs - `runTaskBody` below, in an instance of its own,
// on another thread - and never crosses this boundary except as the one thing a
// body can carry out.
const RUNNER = 0x20000000;

// The same for the loader a body is handed. Distinct from `RUNNER` so that a
// body writing its loader into its output and a `step` calling back through it
// - the one route a capability has out of the call that owns it - arrives as a
// context this session's `load` refuses rather than as one it serves.
const LOADER = 0x10000000;

// And the same for the reader a RENDERER is handed. Distinct from both, so that
// a record kept out of one call and spent in another arrives as a context the
// wrong service refuses rather than as one it serves. One value rather than a
// ring: a renderer is never called inside another, so there is no second reader
// to tell this one apart from and a flag is the whole of *is this call live*.
const READER = 0x30000000;

// And the record a host with no table of its own hands over, which is a null
// one. It is the arrangement a `step` gets from a caller with no session behind
// it, which every game's own tests hand a null runner
// (`games/pong/tests/a_game_spends_exactly_the_block_it_asked_for.c:155`).
//
// A `Consumer` or a worklet processor built WITHOUT a trampoline is that host:
// there is then no wasm function in its instance's table that a reader's
// `bytes` could name, so the record it hands over is this. It renders anyway -
// a description that names no task never asks - and what it cannot do is answer
// one that does. Handing a trampoline to a consumer is what buys the answer,
// and it costs one more module compiled in whatever scope the consumer lives
// in: measured for an `AudioWorkletGlobalScope` in
// `docs/runs/threaded-host-run.md` (c), where compiling the GAME's bytes
// synchronously in that scope is already what every run does.
const NO_READER = 0;

// HOW MANY FRAMES' RUNNER RECORDS ARE KEPT DISTINCT is not written down here
// any more. It is `host_core_context_ring`, read back through
// `host_core_figure` - one number, in the rulebook both hosts answer out of,
// where it used to be a constant in this file that happened to say 64 as well.
//
// A RING OF RECORDS rather than one record re-stamped, which is what the number
// is for. A game stashes the record's ADDRESS, so a single record whose
// `context` moved every frame would answer a stale pointer with this frame's
// context and nothing could tell them apart - the failure `products/host-core`
// records having measured the hard way, with one context per session and a
// fixture that sailed through. Sixty-four slots put a frame's record at a
// different address from the frames either side of it, and a slot used again
// exactly that many frames later is freshly armed for the frame using it and is
// indistinguishable. That is far past the shape this catches, which is a record
// put in the state block and used on the next step.
//
// What this file still owns is the RECORD - three words in the game's own
// memory, two of them table indices - because a native record holds addresses
// and a wasm one holds indices, and no core can compose both.

// `console_name_max` and `console_format_max`, the buffers the native host
// composes a filename in. Mirrored here so that a descriptor legal by the
// grammar and too long for the host with a filesystem fails the task on BOTH
// targets rather than on one - the length is decidable from the module alone,
// which is what makes it the game's own bug rather than a deployment's.
//
// They are PARAMETERS to the grammar check rather than figures inside it, and
// that is `interface/game.h`'s own arrangement: it says what a descriptor may
// CONTAIN and leaves how long a filename a host composes to the host. The
// charsets moved into `products/host-core`; these three did not, because they
// are not the same kind of thing.
const NAME_MAX = 64, FORMAT_MAX = 16;

// `Game_Resource`, hand-mirrored for wasm32 like every other offset in LAYOUT:
// three pointers, four bytes each. Read through the pointer one call hands over
// rather than walked as an array, because nothing declares a set of these any
// more - so what a wrong offset costs here is one descriptor read as garbage
// rather than every entry after the first.
//
// It is read inside a TASK instance now rather than in the game's, which is the
// only thing about it that moved: the offsets are the same struct on the same
// target.
//
// `path` went in at the TAIL, for the reason `Game.controls` did: this mirror
// gained one constant and moved nothing it already knew. `RESOURCE_BYTES` is
// the stride the header pins at 12 on wasm32 against 24 natively, and it is
// written down rather than derived because a descriptor read one field short
// resolves every path-carrying read at the ROOT - which answers a real file, on
// the web only, with the native half reading the right one. That is the exact
// shape of divergence this console exists to make unreachable.
const RESOURCE_FORMAT_OFFSET = 4, RESOURCE_PATH_OFFSET = 8;
const RESOURCE_BYTES = 12;

// `console_file_max`, the buffer the native host composes a whole filename in -
// `<path>/<name>.<format>` with its terminator. Mirrored here for the reason
// `NAME_MAX` and `FORMAT_MAX` are, and it is the third of the same family: the
// two of them bound the halves and this bounds what they compose into.
// `interface/game.h` states what a descriptor may CONTAIN and leaves how long
// a filename a host composes to the host, so a descriptor legal by the grammar
// and too long for the host with a filesystem has to fail the task on BOTH
// targets rather than on one - the length is decidable from the module and the
// run alone, which is what makes it the game's own bug rather than a
// deployment's.
const PATH_MAX = 128;

// `Game_Arg`, the pair `construct` is handed - and the one struct in this file
// that this mirror WRITES rather than reads. Nothing on a module describes it:
// a game declares no arguments, so there is no array here to walk out of a
// module's memory and no declaration to match anything against.
//
//     0 | const char * name
//     4 | const char * value
//       | [sizeof=8, align=4]
//
// Eight here against sixteen natively, since both members are pointers, and
// `interface/game.h` pins both figures for exactly this reason: the array is
// FLAT, so a stride mirrored wrong reads every entry after the first out of the
// middle of its predecessor.
//
// The one other rule a mirror owes because it writes is alignment. The pairs
// and the strings they point at are laid down at what C requires - four bytes
// on wasm32 - because the game reads them back through a typed pointer, and a
// misaligned load is undefined behaviour rather than a slow one. There is
// nothing else to get right, which is most of what the pair bought this file:
// both members point at bytes written here, so no value carries a
// representation a game could trap on loading and no entry is optional.
const PAIR = { name: 0, value: 4, bytes: 8 };

// HOW MANY PAIRS A RUN MAY CARRY, how long a name may be and how long a value
// may be are not written down here any more either. They are
// `host_core_argument_max`, `host_core_argument_name_max` and
// `host_core_argument_text_max`, read back through `host_core_figure`, and they
// bound the storage that actually holds them - which is the whole reason a
// capacity belongs to whoever has to store it.
//
// This file used to carry all three as hand mirrors of the native host's, for a
// reason that was correct and is now met a better way: a run's identity has to
// be the same wherever it is played, so one address bar, one command line and
// one recording are one run, and a capacity only one host kept would make a
// query legal on the page and refused under `inspector` with the module and the
// input log identical. No golden can see that - a run that will not start
// records nothing to compare against the run that did. Two mirrors of one
// number are now one number.
//
// The CHARSETS went with them. An argument's name is `[a-z0-9_]+` and a value
// is printable ASCII with no outer space, and both are settled in
// `products/host-core` against the same list every host settles.

// The one predicate about a value this file kept, and it DECIDES NOTHING.
// `host_core_settle_arguments` answers a bad value with one verdict where this
// page has two sentences for it - a byte outside printable ASCII, and an outer
// space - so this chooses which of the two to say about a value the rulebook
// has already refused. `docs/host-core-rules.md` measures that the three hosts
// do not word their refusals alike, and aligning them is a decision nobody has
// taken; until somebody does, a host composing its own sentence sometimes needs
// to know which sentence it is.
const PRINTABLE = /^[\x20-\x7e]*$/;

// The keys this page KEEPS. `module` says which game this is and `resources`
// says which bytes it plays against, and neither is an argument any more than a
// filename typed at a shell is.
//
// TWO AND NOT THREE. `seed` was the third and is not held back here any more:
// it is still this host's own term and still reaches `construct` as that call's
// own parameter, but it RIDES THE QUERY as an ordinary pair and
// `host_core_extract_seed` is where the spelling ends - so one grammar carries
// it from an address bar, a command line and a recording's forwarding alike,
// and the array a game walks cannot carry it whatever a run wrote.
//
// EVERY OTHER KEY IS THE GAME'S and is passed through as a pair: there is no
// declaration to match it against, so a key this game has never heard of is a
// key for a harness, for a menu or for the next version of it, and the run
// starts regardless.
const PAGE_KEYS = ["module", "resources"];
const SEED_KEY = "seed";

const FRAME_WIDTH = 240, FRAME_HEIGHT = 240;
const PALETTE_SIZE = 16, FRAME_RATE = 60;

// game_sample_rate. Requested explicitly rather than taken from the device:
// Chrome honours any rate asked for - measured - and pinning it is what makes
// the page and `inspector wav` produce the same samples rather than the same
// music at two different rates.
const SAMPLE_RATE = 48000;
const SAMPLES_PER_FRAME = SAMPLE_RATE / FRAME_RATE;
const BUTTONS = ["up", "down", "left", "right", "a", "b"];

// The pointer's own two, which live in `Game_Pointer` rather than on the pad so
// that a press implies a position - see the header, which states that neither
// is ever reported while `present` is clear.
const POINTER_BUTTONS = ["primary", "secondary"];

// All eight, in the order a recorded held byte packs its bits. That order is
// not this file's to choose: `products/mark` keeps held and edges as one
// `uint8_t` per frame over six names, and the pointer's two take the two bits
// the pad leaves free, so nothing about the replay format widened to carry
// them. A ninth button would, which is worth knowing before anyone adds one.
const RECORDED_BUTTONS = [...BUTTONS, ...POINTER_BUTTONS];

// `Game_Need`, as the module reports it. Zero being `game_need_none` is load
// bearing rather than tidy: the host presents `Game` zero filled, so a game
// that assigns no `controls` declares nothing and is delivered nothing.
const NEED = { none: 0, optional: 1, required: 2 };

// The same three as the words the header uses, indexed by the value, so a
// reader sees what the game said rather than a number.
const NEED_NAMES = ["none", "optional", "required"];

// `Game_Report`, as a step hands it back. Disjoint bits rather than a state,
// because a frame may be any combination of them and one that is all three - a
// puzzle game between moves - is the ordinary case rather than the exceptional
// one.
//
// Zero has to be the answer that costs nothing, and it matters more in this
// host than in any other, because here it has a second way of arriving. A wasm
// module built before `step` returned anything at all returns NOTHING, and what
// a JS caller reads back from a void export is `undefined` - measured through
// the indirect function table on a module built for the purpose, where the
// call answers `undefined` and `undefined | 0` is 0. So a page one build ahead
// of a game claims nothing about it: redraw, play, keep stepping. Inverted, the
// same pair would put a live game to sleep, in silence, on a screen the page
// had stopped painting, with every check in this tree green.
//
// The four are read here and acted on entirely in the page, because every one
// of them is about something only a browser has: `game_report_still` is a paint
// and an upload not made, `game_report_silent` is a block the worklet is owed,
// `game_report_idle` is the 60 Hz wakeup and the audio thread behind it, and
// `game_report_save` is the blob a closing tab writes to `localStorage`.
// Nothing about any of them can reach the game.
const REPORT = { none: 0, still: 1, silent: 2, idle: 4, save: 8 };

// The keyboard, as the console's six buttons see it. Here rather than in the
// page because it is a table rather than an event handler: what arrives is a
// `KeyboardEvent.code`, which is a string, and mapping one to a button needs no
// browser at all. The page owns the listeners; this owns what they mean.
const KEYS = {
    ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down",
    ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
    KeyZ: "a", Comma: "a", KeyX: "b", Period: "b",
};

// The pointer's buttons, by the same argument and in the same place: what
// arrives is a `PointerEvent.button`, which is a number. 0 and 2 are the
// primary and secondary the operating system has already resolved - a
// left-handed user whose buttons are swapped reports 0 for the one under their
// index finger, which is exactly why these are not called left and right. Every
// other number is a button this console does not have.
const POINTER_KEYS = { 0: "primary", 2: "secondary" };

// What every wasm module begins with, checked here so that a file that is not
// one is refused by name. A server answering 200 with an error page, or a
// resource handed to `?module=`, otherwise arrives as a compile error from
// inside the session constructor with the URL nowhere in it.
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

// ---------------------------------------------------------------------------
// Refusal, in the console's idiom: `console_load` rejects a module whose
// factory left the Game struct incomplete, and says so naming the module rather
// than running it half-configured.
//
// The page needs the same move for the same reason and one more of its own. A
// game that asks for something no host can honour - a runner used after its
// step, an id asked about after it was released - has said something
// the page cannot answer, and the alternative to refusing is a run nobody can
// reproduce: on screen a game that plays, and in a recording a run that never
// happened.
//
// Those arrive mid-run rather than at load, because they are things a game DOES
// rather than things it declares: the earliest any of them can be known is the
// frame it happens on. The throw leaves the loop through the animation frame
// that was running it, which is the same exit a refusal at load takes.
//
// `console_fault` is the native half and does not stop the run - it keeps the
// first fault and lets `inspector` exit non-zero on it. The page has no caller
// to hand one to, so it stops where the console records, and the WHEN is what
// the two hosts have to agree about rather than the what-next.
//
// Where the reason is SHOWN is the one part of this a browser owns, so it is
// the one part that is injected: the page hangs its HUD banner here, and a host
// with nothing to show one on installs nothing and gets the throw. The console
// line and the throw are common to both, because neither is the browser's.
// ---------------------------------------------------------------------------

let showRefusal = () => {};

function onRefusal (show) { showRefusal = show; }

function refuse (reason) {
    showRefusal (reason);

    console.error ("player: " + reason);

    throw new Error (reason);
}

// The module's bytes, over the network, as bytes.
//
// `fetch` and not `WebAssembly.instantiateStreaming`, deliberately: the
// streaming form throws unless the response carries `Content-Type:
// application/wasm`, which is a fact about whichever server is in front of the
// file rather than about the file. Measured on Chrome 151, one directory served
// two ways: as `application/wasm` both forms compile, and as
// `application/octet-stream` the streaming form is a `TypeError: Incorrect
// response MIME type` while the array form is unchanged. Serving it right is
// easy where the server is ours - `products/server` does, and so does `python3
// -m http.server` on 3.14.6 - and is not ours to fix on somebody's static host.
//
// This is also what makes a server necessary at all. On file:// Chrome refuses
// fetch, XMLHttpRequest and dynamic import outright, so the page a player used
// to double-click is now a page a player serves; `docs/decisions.md` records
// both tables, and `./serve.sh` is the one line that answers it.

async function fetchModule (base) {
    let response;

    // Every failure below ends as a refusal naming the URL, because the
    // alternative is a blank canvas that reads as a hang.
    try {
        response = await fetch (base);
    } catch (error) {
        refuse (`no module at ${base.href}: ${error}.`
            + (typeof location !== "undefined" && location.protocol === "file:"
                ? " This page is open from file://, where a browser refuses"
                + " every fetch there is. Serve the site instead."
                : ""));
    }

    if (! response.ok) {
        refuse (`no module at ${base.href}: the server answered `
            + `${response.status} ${response.statusText}.`);
    }

    const bytes = new Uint8Array (await response.arrayBuffer ());

    if (WASM_MAGIC.some ((byte, index) => bytes [index] !== byte)) {
        refuse (`${base.href} is not a WebAssembly module: it does not `
            + `begin with the wasm magic. ?module= names a game's <name>.wasm.`);
    }

    return bytes;
}

// ---------------------------------------------------------------------------
// The trampoline: how a host's function gets into a game's table at all.
//
// A game module imports NOTHING. `interface/game.h` hands the host over as a
// `Game_Task_Runner` and a `Game_Resource_Loader`, records whose members are
// function pointers, and on wasm32 a function pointer is an index into the
// module's own `__indirect_function_table`. So this host has a problem the
// native one does not: `console.c` writes the addresses of three `static`
// functions into its records and is done, and a JavaScript closure is not a
// wasm function and a funcref table will not hold one.
//
// `products/trampoline` is the answer, and it is one small wasm module: three
// functions with exactly the signatures the record members declare, each
// forwarding to a closure it was instantiated with. This host instantiates it
// once per instance it has to reach into - the game's, and a fresh one per task
// body - grows that instance's table by three and writes the wrappers in, then
// puts the indices they landed at into the records it composes.
//
// `docs/archived/capability-records-plan.md` calls this out as what the design accepts,
// and it is the whole of the cost: one mechanism, built once, tested like
// anything else. Every rule about a spawn, a release or a read is still on this
// side of it, in the closures below, where it was when they were imports.
// ---------------------------------------------------------------------------

// The trampoline's own module, over the network, compiled.
//
// Against the PLAYER's base rather than a game's, exactly as `vorbis.wasm` is
// and for the same reason: one page plays every game, so a file resolved
// against a module would have to be copied into every game's directory to be
// found. It is this host's half rather than the game's, so it belongs beside
// this file.
async function fetchTrampoline (base) {
    let response;

    try {
        response = await fetch (base);
    } catch (error) {
        refuse (`no trampoline at ${base.href}: ${error}. It is this player's `
            + `own half - three wasm functions a game's table is given so that `
            + `a module importing nothing can call a host at all - and it is `
            + `published beside player.js.`);
    }

    if (! response.ok) {
        refuse (`no trampoline at ${base.href}: the server answered `
            + `${response.status} ${response.statusText}.`);
    }

    // THE BYTES BESIDE THE MODULE, because one consumer cannot be handed the
    // module: a `WebAssembly.Module` will not deserialize into an
    // `AudioWorkletGlobalScope` - posted to a port it arrives at
    // `onmessageerror`, measured in `docs/runs/threaded-host-run.md` (c) -
    // where the bytes cross and `new WebAssembly.Module` compiles synchronously
    // off the main thread. The processor needs its own copy of this module
    // because a description names a task by id and answering one is a wasm
    // function in that instance's table.
    const bytes = await response.arrayBuffer ();

    return { module: new WebAssembly.Module (bytes), bytes };
}

// This host's own functions, in one instance's table, at the indices it answers
// with.
//
// `host` is `{ spawn, done, bytes, release, load, read }`, the closures that
// decide everything; the module below only carries the call across the
// boundary. One instantiation per game instance and per body instance, because
// an import is bound at instantiate and the closures differ.
//
// The six land at the same indices in every instance of one module, and that
// is load bearing rather than incidental: a table's initial length is the
// module's, so growing by six from the same length gives the same six indices
// in the game's instance and in a body's. It is what makes a loader record
// carried out of a body and called through by a `step` land on THIS host's
// `load` - a refusal naming the rule - rather than on whatever index the game's
// table happened to hold.
function installTrampoline (trampoline, instance, host) {
    const table = instance.exports.__indirect_function_table;

    let at;

    // The one failure this can have, and it is a build's rather than a run's:
    // wasm-ld pins a table's maximum to its initial size unless it is told not
    // to, and a table that cannot grow is a module no host can hand a record.
    // `cmake/WasmCompiler.cmake` passes `--growable-table` for exactly this,
    // so a refusal here names the flag rather than the throw.
    try { at = table.grow (6); }
    catch (error) {
        refuse (`this module's function table will not grow, so this host has `
            + `nowhere to put the six functions a \`Game_Task_Runner\`, a `
            + `\`Game_Resource_Loader\` and a \`Game_Task_Reader\` are made `
            + `of. A module is linked with --growable-table for that reason; `
            + `this one was not.`);
    }

    const shim = new WebAssembly.Instance (trampoline, { host });

    table.set (at, shim.exports.spawn);
    table.set (at + 1, shim.exports.done);
    table.set (at + 2, shim.exports.bytes);
    table.set (at + 3, shim.exports.release);
    table.set (at + 4, shim.exports.load);
    table.set (at + 5, shim.exports.read);

    return { spawn: at, done: at + 1, bytes: at + 2, release: at + 3,
             load: at + 4, read: at + 5 };
}

// ---------------------------------------------------------------------------
// The rulebook, instantiated.
//
// One wasm instance, one linear memory, and a bump arena above `__heap_base` -
// the same discipline `Session` follows in the game's memory, for the same
// reason: `products/host-core` allocates nothing and has no libc, so the
// embedder owns every byte it writes into and hands it over as a block whose
// size the module reports from the game's own declaration.
//
// WHAT CROSSES THE BOUNDARY CROSSES AS A BLOB. A descriptor, a list of pairs
// and a resource go in as bytes written into a scratch region here; a settled
// pair and a table row come back as bytes read out of one.
// No pointer means anything on the other side, which is why a task's output
// block travels as a number the core stores beside an id and never
// dereferences. `interface/game.h` already has a host copy `task` and `input`
// during the call and retain neither, so the copies this costs are the copies
// the contract required, made one memory further along.
//
// The scratch region is REUSED rather than stacked, and that is safe because no
// entry point retains a pointer into it: `host_core_spawn` reads its descriptor
// during the call, `host_core_settle_arguments` copies both halves of every
// pair into the session block, and `host_core_check_resource` scans in place.
// One region, one call at a time.
//
// One instance per SESSION, and per body's worker, rather than one for the
// page. A reset is a new game memory and a new set of workers, and a core whose
// arena outlived it would grow a session block per reset for the life of the
// page - the same argument `Session` makes about laying its pairs down once.
// ---------------------------------------------------------------------------

class HostCore {
    // `module` is `host-core.wasm`, compiled. Instantiated against NOTHING, for
    // the reason a game is: the module imports nothing at all, which
    // `cmake/CheckImports.cmake` reads back off the linked file.
    constructor (module) {
        this.module = module;
        this.instance = new WebAssembly.Instance (module, {});
        this.ex = this.instance.exports;
        this.heap = this.ex.__heap_base.value ?? this.ex.__heap_base;

        // Where a blob crosses, and how much of one fits there now.
        this.scratchAt = 0;
        this.scratchSpan = 0;

        // The session a settled argument list lands in when the caller has no
        // game. `argumentList` runs on a URL before a module has been fetched
        // and in a harness with no module at all, and settling is a pure
        // function of the list, so a table of no tasks is enough of a session
        // to hold one. What a game is handed is copied into the GAME's memory
        // either way - the core's storage is where the checking, the
        // deduplication and the sort happen and is never what `construct` reads.
        this.held = 0;
    }

    view () { return new DataView (this.ex.memory.buffer); }

    // The same bump `Session.alloc` is, in the other memory. Built after the
    // growth rather than before it for the same reason: `memory.grow` detaches
    // every view of the buffer.
    alloc (span, alignment = 16) {
        this.heap = (this.heap + alignment - 1) & ~(alignment - 1);

        const need = this.heap + span;

        if (need > this.ex.memory.buffer.byteLength) {
            this.ex.memory.grow (Math.ceil (
                (need - this.ex.memory.buffer.byteLength) / 65536));
        }

        const at = this.heap;

        this.heap += span;

        return at;
    }

    scratch (span) {
        if (span > this.scratchSpan) {
            this.scratchAt = this.alloc (span);
            this.scratchSpan = span;
        }

        return this.scratchAt;
    }

    string (at) {
        const bytes = new Uint8Array (this.ex.memory.buffer);
        let text = "";

        for (let index = at; bytes [index]; index++) {
            text += String.fromCharCode (bytes [index]);
        }

        return text;
    }

    // One NUL terminated string, laid where the core can read it, ANSWERING
    // WITH WHAT IT SPENT so a caller can lay the next one after it.
    //
    // Anything outside printable ASCII is written as `0x7f`, which is a
    // substitution and has to be: a JavaScript string is UTF-16 code units and
    // a C string is bytes to a terminator, so a code unit truncated into a byte
    // could turn a character the rulebook refuses into one it takes, and an
    // embedded NUL would end the string early and hide the rest of a value
    // behind a length nothing measured. `0x7f` is outside every charset the
    // core accepts and is not a space, so a value carrying one is refused for
    // being outside printable ASCII - which is what it was.
    lay (at, text) {
        const bytes = new Uint8Array (this.ex.memory.buffer);

        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt (index);

            bytes [at + index] = code >= 0x20 && code <= 0x7e ? code : 0x7f;
        }

        bytes [at + text.length] = 0;

        return text.length + 1;
    }

    // A figure this library was built with, which is what the console reads off
    // an enumerator and a page cannot.
    figure (which) { return this.ex.host_core_figure (which) >>> 0; }

    // One session's worth of rules, in a block this arena owns. `note_span` is
    // 0: the console keeps a task's diagnostic name in the core's note so that
    // the compaction moves it with the entry, and this host keeps a JavaScript
    // object per id instead - a `Uint8Array` of output bytes and a line saying
    // why there are none do not fit in a byte span.
    begin (taskMax) {
        const span = this.ex.host_core_size (taskMax, 0) >>> 0;

        if (! span) {
            refuse (`this module declares task_max ${taskMax}, which is more `
                + `than the rules a session needs can be sized for on this `
                + `target. It is a run to refuse exactly as a \`Game.size\` `
                + `that will not map is.`);
        }

        return this.ex.host_core_begin (this.alloc (span), taskMax, 0) >>> 0;
    }

    holder () {
        if (! this.held) { this.held = this.begin (0); }

        return this.held;
    }

    slots (host) { return this.ex.host_core_slots (host) >>> 0; }

    issued (host) { return this.ex.host_core_issued (host) >>> 0; }

    frame (host) { return this.ex.host_core_frame (host) >>> 0; }

    advance (host) { this.ex.host_core_advance (host); }

    armRunner (host) { return this.ex.host_core_arm_runner (host) >>> 0; }

    retireRunner (host) { this.ex.host_core_retire_runner (host); }

    // `construct`'s own slot, one past the ring. It runs before frame 0, so a
    // stamp taken out of the ring would be the very slot step 0 arms - and a
    // record `construct` stashed and step 0 spent would then be live.
    armConstruct (host) {
        return this.ex.host_core_arm_construct (host) >>> 0;
    }

    retireConstruct (host) { this.ex.host_core_retire_construct (host); }

    // Whether the slot a record names is the call using it, and which frame it
    // WAS armed for - so a refusal can name the call the record belonged to
    // rather than only the call that misused it.
    checkRunner (host, slot) {
        const at = this.scratch (4);
        const verdict = this.ex.host_core_check_runner (host, slot, at);

        return { verdict, armed: this.view ().getUint32 (at, true) };
    }

    // Every rule a spawn is held to, out of the module and the call alone: the
    // two malformed shapes, the game's own live count, and the table this host
    // cannot outgrow.
    //
    // The descriptor goes across as the twenty bytes of `Game_Task` the rules
    // read, with `name` left null: nothing in the rulebook reads a task's name,
    // and this host keeps its own beside the id.
    spawn (host, task, carried) {
        const at = this.scratch (LAYOUT.task.bytes + CORE.spawn.bytes);
        const answerAt = at + LAYOUT.task.bytes;

        if (task) {
            const compose = this.view ();

            compose.setUint32 (at + LAYOUT.task.name, 0, true);
            compose.setUint32 (at + LAYOUT.task.body, task.body, true);
            compose.setUint32 (at + LAYOUT.task.inputSize, task.inputSize,
                true);
            compose.setUint32 (at + LAYOUT.task.scratchSize, task.scratchSize,
                true);
            compose.setUint32 (at + LAYOUT.task.outputSize, task.outputSize,
                true);
        }

        this.ex.host_core_spawn (host, task ? at : 0, carried ? 1 : 0,
            answerAt);

        const answer = this.view ();

        return {
            id: answer.getUint32 (answerAt + CORE.spawn.id, true),
            verdict: answer.getInt32 (answerAt + CORE.spawn.verdict, true),
            inputSize: answer.getUint32 (answerAt + CORE.spawn.inputSize, true),
        };
    }

    // Whether an id is one the game may ask about at all, which is the verdict
    // three hosts have to reach identically and the one thing a game cannot
    // work out for a host.
    checkId (host, id) {
        return this.ex.host_core_check_id (host, id);
    }

    done (host, id) { return !! this.ex.host_core_done (host, id); }

    // The block the id answered with, as the opaque number this host gave the
    // rulebook - which here is an address in the GAME's linear memory, and is
    // what `bytes` hands straight back to the game.
    bytes (host, id) { return this.ex.host_core_bytes (host, id) >>> 0; }

    answer (host, id, finished, block, span) {
        this.ex.host_core_answer (host, id, finished ? 1 : 0, block, span);
    }

    stage (host, id, abandoned) {
        return !! this.ex.host_core_stage (host, id, abandoned ? 1 : 0);
    }

    // `blocks` is NULL at both of these, and it is the one place this host
    // cannot follow the console.
    //
    // `Host_Core_Blocks.reclaim` is a function pointer, which on wasm32 is an
    // index into the CORE's own table - and a JavaScript closure is not a wasm
    // function, exactly as it is not one in a game's table.
    // `products/trampoline` is the answer to that problem for a game and cannot
    // be the answer here: its six wrappers carry the six signatures
    // `Game_Task_Runner`, `Game_Resource_Loader` and `Game_Task_Reader`
    // declare, and `reclaim`'s is none of them. The core guards for a record it was not given, so it drops
    // the block and says nothing, and `Session.reclaimBlocks` reconciles
    // afterwards: every address this host's arena holds that no row of the
    // table names any more goes back on the spare list. That decides nothing -
    // which entries end, and when, is still read off the table the rules left.
    //
    // `release` takes no record at all now, on any host: a release marks the
    // entry and settles at the frame boundary, so `retire` below is the one
    // call that can hand a released block back.
    release (host, id) { this.ex.host_core_release (host, id); }

    retire (host) { this.ex.host_core_retire (host, 0); }

    show (host) { this.ex.host_core_show (host, 0); }

    taskCount (host) { return this.ex.host_core_task_count (host) >>> 0; }

    // One row, read out of the core's memory into the plain object this file's
    // own code reads. Never kept: an entry belongs to the block and moves
    // whenever the table compacts.
    task (host, index) {
        const at = this.ex.host_core_task (host, index) >>> 0;

        if (! at) { return null; }

        const view = this.view ();
        const bytes = new Uint8Array (this.ex.memory.buffer);

        return {
            id: view.getUint32 (at + CORE.row.id, true),
            spawned: view.getUint32 (at + CORE.row.spawned, true),
            finished: view.getUint32 (at + CORE.row.finished, true),
            outputSize: view.getUint32 (at + CORE.row.outputSize, true),
            block: view.getUint32 (at + CORE.row.block, true),
            span: view.getUint32 (at + CORE.row.span, true),
            state: view.getInt32 (at + CORE.row.state, true),
            constructed: !! bytes [at + CORE.row.constructed],
            staged: !! bytes [at + CORE.row.staged],
            dead: !! bytes [at + CORE.row.dead],
        };
    }

    // The run's own term, taken back out of the pairs before the array a game
    // walks exists.
    //
    // Called BEFORE `settleArguments` rather than by it, and both orderings are
    // load bearing. A host applies its own policy to absence - this one's is
    // that `composeRun` already wrote a number into the query - and the roof
    // is counted over what is left, so a query naming this host's fill of pairs
    // AND a seed is a run rather than one pair too many.
    //
    // The list is COMPACTED IN PLACE by the rulebook, so what comes back is the
    // pairs that are left, read out into this file's own objects before the
    // next call reuses the scratch they were laid in.
    extractSeed (given) {
        let span = CORE.settled.bytes + CORE.seed.bytes + 4
            + given.length * CORE.pair.bytes;

        for (const entry of given) {
            span += `${entry.name}`.length + `${entry.value}`.length + 2;
        }

        const answerAt = this.scratch (span);
        const seedAt = answerAt + CORE.settled.bytes;
        const countAt = seedAt + CORE.seed.bytes;
        const arrayAt = countAt + 4;

        let textAt = arrayAt + given.length * CORE.pair.bytes;
        let view = this.view ();

        for (let index = 0; index < given.length; index++) {
            const nameAt = textAt;

            textAt += this.lay (nameAt, `${given [index].name}`);

            const valueAt = textAt;

            textAt += this.lay (valueAt, `${given [index].value}`);

            const pair = arrayAt + index * CORE.pair.bytes;

            view.setUint32 (pair + CORE.pair.name, nameAt, true);
            view.setUint32 (pair + CORE.pair.value, valueAt, true);
        }

        // `count` is read as well as written: the rulebook answers with one
        // fewer entry where it took a seed out.
        view.setUint32 (countAt, given.length, true);

        const taken = !! this.ex.host_core_extract_seed (
            given.length ? arrayAt : 0, countAt, seedAt, answerAt);

        view = this.view ();

        if (! taken) {
            return {
                taken: false,
                verdict: view.getInt32 (answerAt + CORE.settled.verdict, true),
                at: view.getUint32 (answerAt + CORE.settled.at, true),
                earlier: view.getUint32 (answerAt + CORE.settled.earlier, true),
            };
        }

        const count = view.getUint32 (countAt, true);
        const bytes = new Uint8Array (this.ex.memory.buffer);
        const pairs = [];

        for (let index = 0; index < count; index++) {
            const pair = arrayAt + index * CORE.pair.bytes;

            pairs.push ({
                name: this.string (view.getUint32 (pair + CORE.pair.name,
                    true)),
                value: this.string (view.getUint32 (pair + CORE.pair.value,
                    true)),
            });
        }

        return {
            taken: true,
            named: !! bytes [seedAt + CORE.seed.named],
            seed: view.getUint32 (seedAt + CORE.seed.seed, true),
            pairs,
        };
    }

    // The whole of what a run was told, checked, deduplicated and sorted, or
    // the verdict and the figures a refusal quotes.
    //
    // Every string is laid down at its own length rather than at the storage's,
    // because a name or a value PAST the storage is a refusal the rules have to
    // be allowed to make and cannot make about bytes that never arrived.
    settleArguments (given) {
        const host = this.holder ();

        let span = CORE.settled.bytes + given.length * CORE.pair.bytes;

        for (const entry of given) {
            span += `${entry.name}`.length + `${entry.value}`.length + 2;
        }

        const answerAt = this.scratch (span);
        const arrayAt = answerAt + CORE.settled.bytes;

        let textAt = arrayAt + given.length * CORE.pair.bytes;
        let view = this.view ();

        for (let index = 0; index < given.length; index++) {
            const nameAt = textAt;

            textAt += this.lay (nameAt, `${given [index].name}`);

            const valueAt = textAt;

            textAt += this.lay (valueAt, `${given [index].value}`);

            const pair = arrayAt + index * CORE.pair.bytes;

            view.setUint32 (pair + CORE.pair.name, nameAt, true);
            view.setUint32 (pair + CORE.pair.value, valueAt, true);
        }

        const taken = !! this.ex.host_core_settle_arguments (host,
            given.length ? arrayAt : 0, given.length, answerAt);

        view = this.view ();

        if (! taken) {
            return {
                taken: false,
                verdict: view.getInt32 (answerAt + CORE.settled.verdict, true),
                at: view.getUint32 (answerAt + CORE.settled.at, true),
                earlier: view.getUint32 (answerAt + CORE.settled.earlier, true),
                span: view.getUint32 (answerAt + CORE.settled.span, true),
            };
        }

        // Read back out of the core's storage rather than sorted again here:
        // the order is `interface/game.h`'s and is settled there, and a list
        // this file re-sorted would be a second sort to keep in step.
        const from = this.ex.host_core_arguments (host) >>> 0;
        const count = this.ex.host_core_argument_count (host) >>> 0;
        const pairs = [];

        for (let index = 0; index < count; index++) {
            const pair = from + index * CORE.pair.bytes;

            pairs.push ({
                name: this.string (view.getUint32 (pair + CORE.pair.name,
                    true)),
                value: this.string (view.getUint32 (pair + CORE.pair.value,
                    true)),
            });
        }

        return { taken: true, pairs };
    }

    // The six rules a `Game_Resource` is held to, over a descriptor composed
    // here out of the three strings a body's own memory held.
    //
    // The three capacities are PARAMETERS, which is `interface/game.h`'s
    // arrangement rather than an omission: it says what a descriptor may
    // contain and leaves how long a filename a host composes to the host.
    checkResource (name, format, path, nameMax, formatMax, fileMax) {
        const at = this.scratch (RESOURCE_BYTES + 4
            + name.length + format.length + path.length + 3);

        const composedAt = at + RESOURCE_BYTES;

        let textAt = composedAt + 4;

        const nameAt = textAt;

        textAt += this.lay (nameAt, name);

        const formatAt = textAt;

        textAt += this.lay (formatAt, format);

        const pathAt = textAt;

        textAt += this.lay (pathAt, path);

        const compose = this.view ();

        compose.setUint32 (at, nameAt, true);
        compose.setUint32 (at + RESOURCE_FORMAT_OFFSET, formatAt, true);
        compose.setUint32 (at + RESOURCE_PATH_OFFSET, pathAt, true);

        const verdict = this.ex.host_core_check_resource (at, nameMax,
            formatMax, fileMax, composedAt);

        return { verdict,
                 composed: this.view ().getUint32 (composedAt, true) };
    }
}

// The rulebook's own module, over the network, compiled.
//
// Against the PLAYER's base rather than a game's, exactly as the trampoline and
// the decoder are and for the same reason: one page plays every game, so a file
// resolved against a module would have to be copied into every game's directory
// to be found. It is the host's half twice over - the rules `inspector` links
// are the rules this page runs - and `cmake/Website.cmake` is what puts it
// beside player.js.
//
// It answers a MODULE rather than an instance, like `fetchTrampoline`, because
// a session wants one of its own: an instance is a linear memory, and a reset
// is a new one.
async function fetchCore (base) {
    let response;

    try {
        response = await fetch (base);
    } catch (error) {
        refuse (`no host core at ${base.href}: ${error}. It is the rulebook `
            + `every host answers a spawn, an id's validity and a refused `
            + `argument out of - products/host-core, compiled to wasm - and it `
            + `is published beside player.js.`);
    }

    if (! response.ok) {
        refuse (`no host core at ${base.href}: the server answered `
            + `${response.status} ${response.statusText}.`);
    }

    return new WebAssembly.Module (await response.arrayBuffer ());
}

// ---------------------------------------------------------------------------
// Resources: the bytes a task body reads, and the one place their rules live.
//
// Nothing here is delivered to a game. `interface/game.h` makes a loader's
// `load` body-scoped, synchronous and blocking, so the whole of what a host
// owes a resource is "hand a body its decoded bytes, or fail the task" - and
// the two ends of that are a READER, which is whatever has the bytes, and
// `runTaskBody` below, which holds the game to the grammar and abandons the
// body when the reader cannot answer.
//
// A reader is `read (name, format, path) -> Uint8Array` and throws when it
// cannot answer, which is `Console_Reader` spelled for a target with exceptions
// instead of a return code. It is supplied by whoever has the bytes, exactly as
// `inspector` and never the console supplies the one `console_start` takes: in
// a browser that is `task.worker.js`, which builds `resourceReader` below out
// of the directory the session posted it; under node it is whatever the harness
// hands the session, since node has no `XMLHttpRequest` and a body's read
// cannot wait for a promise.
// ---------------------------------------------------------------------------

// A static string out of a module's linear memory, given that module's exports.
//
// A free function rather than `Session.string` because the strings that matter
// most now are read out of a TASK instance, in `runTaskBody`, where there is no
// session at all: a descriptor's `name` and `format` sit in the module's data
// segment, and a body hands over a pointer into its own copy of it.

function stringAt (ex, at) {
    const bytes = new Uint8Array (ex.memory.buffer);

    let text = "";

    for (let index = at; bytes [index]; index++) {
        text += String.fromCharCode (bytes [index]);
    }

    return text;
}

// The console's audio format, asserted against what the stream turned out to
// hold. `products/vorbis` accepts 44100 or 48000 Hz and mono or stereo, because
// it is a library that knows nothing about this console; what a game can play
// is mono at `SAMPLE_RATE`, so anything else is refused naming what it found
// rather than resampled into something no golden pins.
//
// Synchronous, over a `Vorbis` rather than a `VorbisDecoder`, because it is
// called from inside a body's read and a body has no frame to wait on. That is
// the whole of what the unified design changed here: the samples are the same
// samples, computed by the same module, and `inspector` asserts the same two
// fields in `resource_deliverable`.

function consolePcm (vorbis, bytes) {
    const track = vorbis.decode (bytes);

    if (track.sampleRate !== SAMPLE_RATE || track.channels !== 1) {
        throw new Error (`the track is ${track.sampleRate} Hz and `
            + `${track.channels} channel(s), but the console plays `
            + `${SAMPLE_RATE} Hz mono`);
    }

    return new Uint8Array (track.samples.buffer);
}

// What a body receives, dispatching on the format the descriptor declares.
// `bin` is opaque bytes and is handed over as it lies; `ogg` is decoded here,
// which is the one thing a host decodes and the reason a descriptor carries a
// format at all.
//
// The host may decode exactly this much and no more, and the reason is narrow:
// a page that decoded a PNG with the browser's decoder would hand the game
// pixels the CLI would then have to reproduce byte for byte with a decoder of
// its own. `products/vorbis` escapes that because it is compiled once and built
// twice - wasm for this host, native for `inspector` - so there are not two
// implementations and one golden pins both.
//
// `codec` is a function answering a `Vorbis`, called only when a format needs
// one, so a game that declares no compressed resource never fetches the
// decoder.

function decodeResource (name, format, bytes, codec) {
    if (format === "bin") { return bytes; }

    if (format !== "ogg") {
        throw new Error (`${name}.${format} declares format "${format}", `
            + `which this host cannot deliver; it knows bin and ogg`);
    }

    return consolePcm (codec (), bytes);
}

// One file, over the network, synchronously.
//
// A body blocks on this by design: it runs off the frame, in a worker of its
// own, so the wait costs the game nothing and buys a call with no error return
// for a body to branch on. `docs/archived/unified-tasks-phase0/probes.md`
// section 4 measured it in Chrome 151 - `responseType = 'arraybuffer'` on a synchronous
// request is legal in a worker, and the bytes are byte-identical by digest to
// the same file over an asynchronous one.
//
// THE STATUS IS CHECKED RATHER THAN THE BYTE COUNT, and that is the finding
// rather than the obvious care: the same probe measured a 404 arriving with a
// 225-byte BODY, so a reader that copied whatever it was handed would deliver
// the server's error page as the asset - silently, into a system that would
// then reproduce it. The status check is the whole of what makes a missing file
// one of the header's task failures rather than a corrupt success.

function syncFetch (url) {
    const request = new XMLHttpRequest ();

    request.open ("GET", url, false);
    request.responseType = "arraybuffer";

    try { request.send (); }
    catch (error) {
        throw new Error (`${url} could not be fetched: ${error}`);
    }

    // 200 exactly. A cache hit still answers 200, and every other code a static
    // host can produce for a plain GET either carries no body or carries one
    // that is not the file. `file://` answers 0, which is the same refusal and
    // is the reason the site needs a server at all.
    if (request.status !== 200) {
        throw new Error (`the server answered ${request.status} for ${url}`);
    }

    return new Uint8Array (request.response);
}

// The browser's reader: `<name>.<format>` under one directory, fetched when a
// body first asks for it and decoded before it is handed over.
//
// Null on a runtime with no `XMLHttpRequest`, which is every host without a
// browser. A session with no reader fails every task whose body reads anything,
// naming a host that was pointed at no resources at all - which is a true
// account of one, and is what `console.c` says in the same position.
//
// Cached by filename for the life of the reader, which in a browser is the life
// of ONE BODY: a worker is one task's, so the cache spans the reads a single
// body makes and goes with the thread that made them. `interface/game.h` says
// each call is its own read and that whether the host went to the file twice is
// its own business, which is what makes that lifetime a host's choice rather
// than a divergence - two bodies reading one file are two fetches where a
// resident worker made one, and the bytes a game is handed are the same either
// way.

function resourceReader (base, codecBase) {
    if (typeof XMLHttpRequest === "undefined") { return null; }

    const held = new Map ();

    let vorbis = null;

    // Fetched beside the first compressed resource rather than at startup, so a
    // game that reads none never pays for it - neither the driver nor the
    // module. Against the PLAYER's own base rather than the game's: one page
    // plays every game, so a decoder resolved against a module would have to be
    // copied into every game's directory to be found.
    //
    // `importScripts` rather than a top-level import in `task.worker.js`,
    // because that is what makes the laziness real: a classic worker may load a
    // script at any point, and a game with no ogg then never asks for one. In a
    // host that already has `Vorbis` in scope - the page, or a harness that
    // evaluated the driver itself - this does nothing.
    //
    // It is a PER WORKER cost now, which is per body, so the laziness matters
    // more rather than less: a game whose one compressed asset is read by one
    // body imports the driver in that body's worker and in no other, where a
    // resident worker held it for the whole session on the strength of a single
    // read.
    const codec = () => {
        if (vorbis) { return vorbis; }

        const near = codecBase || base;

        if (typeof Vorbis === "undefined"
            && typeof importScripts === "function")
        {
            importScripts (new URL ("vorbis.js", near).href);
        }

        vorbis = new Vorbis (syncFetch (new URL ("vorbis.wasm", near).href));

        return vorbis;
    };

    // `path` is the directory the descriptor named under the run's root, or
    // the empty string for the root itself. Composed into the filename rather
    // than into the base, so the cache is keyed on the whole of what was read
    // and two descriptors naming one stem in two directories are two entries.
    return (name, format, path) => {
        const file = path ? `${path}/${name}.${format}` : `${name}.${format}`;
        const already = held.get (file);

        if (already) { return already; }

        const bytes = decodeResource (name, format,
            syncFetch (new URL (file, base).href), codec);

        held.set (file, bytes);

        return bytes;
    };
}

// ---------------------------------------------------------------------------
// Tasks: the body, run in a second instance of the same module.
//
// `Game_Task.body` is a function pointer, and on wasm32 a function pointer is
// an INDEX into the module's indirect function table. The element segment that
// fills that table is part of the module, so a fresh instance of the same bytes
// puts the same function at the same index - which is the whole mechanism here:
// the host instantiates the module again and calls `table.get(index)` against
// THAT instance's linear memory.
//
// What it buys is the isolation `interface/game.h` states rather than merely
// promises. The game's instance and the task's share nothing at all: not the
// state block, not the globals, not the arena. `console.c` reaches the same
// isolation by forking, which is the same sentence spelled for a target that
// has processes, and `goldenhash.js` reaches it exactly as this does.
//
// This function is the whole of what crosses the thread boundary, and it is a
// free function rather than a method for that reason: `task.worker.js` reaches
// it through `importScripts` and calls it with a module that arrived over
// `postMessage`, while a host with no `Worker` calls it on its own thread. One
// writer, two callers, and nothing about the answer differs between them.
// ---------------------------------------------------------------------------

// One body, to completion, in an instance of its own.
//
// A FRESH instance per body, for the reason the console forks per spawn rather
// than once: scratch and output are zero because linear memory begins zero, and
// a body that wrote to a global cannot reach the next one. Measured under node
// against `borrower.wasm`: 0.13 ms to compile the module and 0.034 ms an
// instantiate, so a spawn costs the second of those and the module is compiled
// once, wherever it is compiled.
//
// The answer is `{ output, note, reads }`, and a null `output` becomes the null
// the runner's `bytes` hands the game, which means one thing only: the host
// could not run it, the host abandoned it, or the body did not finish. `note`
// is what `Console_Task.diagnostic` is natively - what the run has to say about
// the failure - and there is far less of it for a trap here, because a wasm
// trap carries no file and no line where a native sanitizer prints both.
// `reads` is every resource the body asked for and what became of it, which is
// this host's half of `inspector dump --resources` and reaches no game.
//
// ABANDONMENT IS A THROW, and it is the whole of how this target keeps the
// header's hardest sentence: a loader's `load` does not return to its caller
// when the host cannot answer. There is no process to end here as there is
// natively - `docs/archived/unified-tasks-phase0/probes.md` section 6 measured
// that half - so the closure throws, the throw crosses the trampoline, and it
// unwinds the wasm frames into the catch below. Section 6's web half measured
// all of it: the throw arrives as an
// ordinary `Error` rather than a `WebAssembly.RuntimeError`, so a host inability
// and a trapping body stay distinguishable; a fresh instance afterwards answers
// normally; and a `worker_threads` thread running the shipped protocol survives
// one and runs the next body.
//
// **A partially written output is still in the instance when the throw lands**,
// which is the same finding the native probe made about its `MAP_SHARED`
// mapping and matters for the same reason: abandoning a body is not on its own
// enough to keep half an answer from escaping. What keeps it in is the `return`
// below - a null `output`, computed nowhere - rather than anything about the
// instance, and a host that reached for the output region in the catch would
// hand a game a structurally valid answer over a buffer nothing filled.
//
// Everything a body can throw is caught here and nowhere else, because only
// here is a throw a failed TASK rather than a failed run: a trap arrives as
// `WebAssembly.RuntimeError`, and a `body` index past the table's bound arrives
// from `get` as a `RangeError`, which is the same answer the native host gives
// a function pointer that is not one - a child that died.
//
// Nothing bounds how long a body runs, exactly as nothing bounds it natively.
// A body that never returns is a worker that never answers, and the game waits
// for an answer that never comes - which is what it does for a task the host is
// still running, and a game can tell the two apart by nothing at all.
//
// `read` is the host's reader, or null for a host that has no bytes to offer.
// `trampoline` is `products/trampoline`'s compiled module, which is how the
// loader record this body is handed gets a `load` it can call at all.
//
// `core` is a `HostCore`, and it is here rather than in the session because
// this is where the descriptor grammar is spent: a body's read is answered in
// the body's own instance, on the thread the body runs on, so the six rules a
// `Game_Resource` is held to have to be reachable from there. It is the ONE
// thing about a task the rulebook is needed for on this side of the message -
// a body's own `spawn` and `release` are inert wrappers, because
// `interface/game.h` says a body reads files and cannot spawn - so what a
// worker gets is a compiled module and an instance of its own rather than a
// session.
function runTaskBody (module, trampoline, core, task, input, read) {
    let instance;

    // Every read the body made and what became of it, IN CALL ORDER and kept
    // whether the body finished or not - the abandoning read is the last entry
    // and is what a reader wants to see first.
    const reads = [];

    // The three parts of `interface/game.h`'s six failures that are decidable
    // from the module and the call alone, then the deployment's, then the
    // host's. Every one of them throws, and none of them returns.
    const readResource = (context, resource, buffer, capacity) => {
        // The record rule, and the one shape a game can break it in: a body
        // wrote its loader into the output and a `step` read it back. That call
        // reaches the session's own `load` rather than this one, which answers
        // nothing at all; what reaches HERE is a body handed one loader and
        // calling through another, which no game in this tree can spell and
        // which `console.c` refuses in the same position - on the `context`
        // rather than on the record that carried it, exactly as this does.
        if (context !== LOADER) {
            throw new Error ("a loader this body was not handed was used to "
                + "read a resource");
        }

        const ex = instance.exports;
        const view = new DataView (ex.memory.buffer);
        const name = stringAt (ex, view.getUint32 (resource, true));
        const format = stringAt (ex,
            view.getUint32 (resource + RESOURCE_FORMAT_OFFSET, true));

        // Null and empty say the same thing here and nowhere else: both are
        // the run's own directory, so a game handed the empty string composes
        // `<name>.<format>` at the root exactly as one handed nothing does.
        const pathPtr = view.getUint32 (resource + RESOURCE_PATH_OFFSET, true);
        const path = pathPtr ? stringAt (ex, pathPtr) : "";

        const refuse = (reason) => {
            reads.push ({ name, format, path, size: 0, failed: true, reason });

            throw new Error (reason);
        };

        // ALL SIX RULES IN ONE CALL, and none of them in this file any more.
        // `name` and `format` carry neither a dot nor a separator, so the two
        // cannot spell a path however they combine; `path` reintroduces the
        // separator on purpose and is held to segments of `[a-z0-9_]+` with no
        // leading and no trailing one, no empty segment and nothing that
        // climbs; and the composition has to fit the filename this host
        // composes into. `products/host-core` is where all of that is written
        // down, once, for the console and this page alike -
        // `docs/host-core-rules.md` rows G1 to G5 and G8 are what moved.
        //
        // What is left here is the SENTENCES and the URL. A host says these
        // things in its own voice, and the same document measures that the
        // three hosts do not word them alike, so the core answers a verdict and
        // a length and this composes what the page has always said.
        const held = core.checkResource (name, format, path, NAME_MAX,
            FORMAT_MAX, PATH_MAX);

        if (held.verdict === CORE.resource.unnamed) {
            refuse (`"${name}" is not a resource name: a name is [a-z0-9_]+, `
                + `with no separator and no dot`);
        }

        if (held.verdict === CORE.resource.unformatted) {
            refuse (`format "${format}" is not a resource format: a format is `
                + `[a-z0-9]+, with no separator and no dot`);
        }

        if (held.verdict === CORE.resource.badPath) {
            refuse (`path "${path}" is not a resource path: segments of `
                + `[a-z0-9_]+ separated by single /, with no leading and no `
                + `trailing separator and nothing that climbs`);
        }

        // Composed here rather than there, because what it becomes is a URL and
        // a URL is the browser's business: the core measures the length the
        // composition WOULD have and never builds one.
        const file = path ? `${path}/${name}.${format}` : `${name}.${format}`;

        if (held.verdict === CORE.resource.longToken) {
            refuse (`"${name}.${format}" is longer than a host composes `
                + `filenames of (${NAME_MAX - 1} and ${FORMAT_MAX - 1} bytes)`);
        }

        if (held.verdict === CORE.resource.longFile) {
            refuse (`"${file}" is ${file.length + 1} bytes with its `
                + `terminator, and this host composes filenames of `
                + `${PATH_MAX}; it is the last of the six rules a `
                + `descriptor is held to.`);
        }

        if (! buffer) {
            refuse (`${file} was read into a null buffer; a size `
                + `probe is a reserved extension rather than a mode`);
        }

        if (! read) {
            refuse (`${file} cannot be read: this host was pointed `
                + `at no resources at all`);
        }

        let bytes;

        try { bytes = read (name, format, path); }
        catch (error) { refuse (`${error.message || error}`); }

        if (bytes.length > capacity) {
            refuse (`${name}.${format} does not fit: the read offered `
                + `${capacity} bytes and ${name}.${format} is ${bytes.length}`);
        }

        // The view is built HERE rather than kept, and that is a measured
        // hazard rather than housekeeping: a body that reads a large asset is
        // exactly a body that grew its own memory to hold one, and
        // `memory.grow` detaches every view the host is holding.
        // `docs/archived/unified-tasks-phase0/probes.md` section 2 measured the
        // failure as a loud `TypeError` from `set` on a detached buffer, and
        // measured rebuilding per call as the fix.
        new Uint8Array (ex.memory.buffer, buffer, bytes.length).set (bytes);

        reads.push ({ name, format, size: bytes.length, failed: false,
                      reason: null });

        return bytes.length;
    };

    // The module imports nothing, so it instantiates against nothing - and
    // everything this host owes a body goes in through the table instead.
    //
    // All six wrappers are installed rather than only `load`, and that is a
    // deliberate mirror rather than tidiness: the six land at fixed indices
    // in every instance of one module, so installing the same six here keeps
    // the game's instance and this one agreeing about what each index means. A
    // body may read and may not spawn, poll or draw - `interface/game.h` says
    // so with a parameter list, and the five inert answers say it again,
    // because a table slot that existed in one instance and not the other would
    // be the two disagreeing about a number a record carries.
    let slots;

    try {
        instance = new WebAssembly.Instance (module, {});

        slots = installTrampoline (trampoline, instance, {
            load: readResource,
            spawn: () => 0,
            done: () => 0,
            bytes: () => 0,
            release: () => {},
            read: () => 0,
        });
    }
    catch (error) {
        return { output: null, reads,
                 note: `it could not be instantiated: ${error}` };
    }

    const ex = instance.exports;

    let heap = ex.__heap_base.value ?? ex.__heap_base;

    const room = (size) => {
        heap = (heap + 15) & ~15;

        const need = heap + size;

        if (need > ex.memory.buffer.byteLength) {
            ex.memory.grow (Math.ceil (
                (need - ex.memory.buffer.byteLength) / 65536));
        }

        const at = heap;

        heap += size;

        return at;
    };

    // THE LOADER RECORD IS THE FIRST ALLOCATION IN THIS INSTANCE, and that is
    // not an ordering preference. `borrower_mode_stale` is a body writing the
    // record's ADDRESS into its output and a `step` reading it back and calling
    // through it - the one route a capability has out of the call that owns it,
    // and the misuse `interface/game.h` requires both targets to refuse in the
    // same words. Natively the address means the same thing on both sides of a
    // fork, so the console reaches its own `resource_load` and rules on the
    // `context` it finds. Two linear memories have no such luck: an address
    // carried across is a number, and it names whatever the GAME's memory has
    // at that offset.
    //
    // So this host puts the record where that number still means it. Both this
    // arena and `Session`'s bump from `__heap_base` at sixteen byte alignment,
    // and both spend their first block on this record, so the loader a body is
    // handed sits at one address in every instance of one module - and a stale
    // pointer read back in the game's instance finds a well formed record whose
    // `load` is this host's own and whose `context` this host refuses. The
    // refusal is a refusal rather than a trap, which is the whole point.
    //
    // Everything else follows, and all of it before anything is written,
    // because `memory.grow` detaches every view of the buffer and the last
    // allocation is exactly what may have grown it. A zero sized part still
    // takes a byte, so that no two of them are the same address.
    const loaderAt = room (LAYOUT.loader.bytes);
    const inputAt = room (task.inputSize || 1);
    const scratchAt = room (task.scratchSize || 1);
    const outputAt = room (task.outputSize || 1);

    // Composed whole, here, one statement after the address it names: the
    // capability and the two words that spend it go down together, exactly as
    // `console.c` composes a loader immediately after arming its context.
    {
        const compose = new DataView (ex.memory.buffer);

        compose.setUint32 (loaderAt + LAYOUT.loader.context, LOADER, true);
        compose.setUint32 (loaderAt + LAYOUT.loader.load, slots.load, true);
    }

    if (task.inputSize) {
        new Uint8Array (ex.memory.buffer, inputAt, task.inputSize).set (input);
    }

    try {
        ex.__indirect_function_table.get (task.body)
            (inputAt, scratchAt, outputAt, loaderAt);
    }
    catch (error) {
        // The output region is deliberately not read here. Whatever the body
        // wrote before it was abandoned is sitting in the instance, and
        // delivering it would be a structurally valid answer computed over a
        // buffer nothing filled - the finding both halves of the S15 probe
        // made, one about a shared mapping and one about this instance.
        return { output: null, reads, note: `${error.message || error}` };
    }

    return {
        output: new Uint8Array (ex.memory.buffer, outputAt,
            task.outputSize).slice (),
        note: null,
        reads,
    };
}

// Where a body runs, which is a worker when there is one and this thread when
// there is not.
//
// `VorbisDecoder` is the shape this follows, deliberately and line for line:
// one thing in this tree already offloads work to a worker and falls back
// inline, and a second spelling of it would be a second thing to get wrong. The
// promise is the same promise either way, so nothing above here has two paths.
//
// ONE WORKER PER LIVE TASK, created at the spawn, ended at the answer, and
// ended at a release that beats the answer. What it replaced is a single
// resident worker every body queued behind, and the reversal buys two things
// that one could not offer.
//
// A release before the answer becomes a REAL CANCEL. A runner's `release` has
// always promised the game that the id it took is never answered, and the
// resident worker kept that promise by throwing the answer away at the doorstep
// while the body ran on to the end. A worker of its own can be
// terminated where it stands, because nothing else is behind it, so the promise
// is now kept by stopping the work rather than by discarding it.
//
// And the two hosts stop being asymmetric about who runs a body. `console.c`
// forks a process at the spawn; this starts a thread at the spawn. One body,
// one execution context, one target's spelling of the other's sentence - where
// before, one host had a context per body and the other had one for all of
// them.
//
// WHAT IT COSTS, measured rather than argued, because accepting a hit is worth
// nothing without the number beside it. In Chrome 151 a `new Worker (url)` over
// `task.worker.js`, primed with the compiled module and handed one body,
// answers in a median 4.6 to 4.9 ms, against 37 to 43 us for a round trip to a
// worker that is already warm. The page's OWN thread pays neither: the
// constructor and the priming post together are 22 to 23 us on the frame that
// spawned - 0.13% of one at 60 Hz - and every other part of that 5 ms happens
// off the frame. Under node's `worker_threads` the same reading is a median
// 16.4 to 17.4 ms, because a node thread is a fresh V8 isolate where a
// browser's worker is not, and nothing in this tree ships to node.
//
// So a light task's answer arrives about 5 ms later than it did and the frame
// that asked for it costs the same. That is the trade, and it is taken because
// this is not a real-time job system: `interface/game.h` prices a body in
// seconds - an opponent's search, a solver, a level's worth of decoded bytes -
// and a game that wanted an answer inside the frame would compute it in `step`.
//
// The module goes across COMPILED rather than as bytes, with the one task the
// worker exists for - `WebAssembly.Module` is cloneable to a dedicated worker,
// which shares this agent cluster - so a worker never recompiles what this
// thread has already compiled. Cloning it per worker rather than once is what
// `docs/archived/unified-tasks-phase0/probes.md` section 1 measured as free: the
// clone surcharge is 0.0012 to 0.0019 ms and INDEPENDENT of module size, which
// is what a clone by reference looks like and what a serialise-and-recompile
// would not.
//
// It also carries WHERE the bytes are, and that is the whole of what a worker is
// told about resources: a directory, posted with the module, out of which it
// builds `resourceReader` for itself. Nothing crosses this boundary per read - a
// body's read is a synchronous XHR on its own worker's thread, which is why this
// thread never hears about one until the answer comes back.
class TaskRunner {
    // `module` is the game's own compiled module. `workerUrl` is where
    // `task.worker.js` sits, or null for a host that has no worker to offload
    // to - which is every host without a browser, and is why this file can be
    // run under node at all.
    //
    // `resources` is `{ base, read }`, both optional. `base` is the directory
    // the worker fetches out of; `read` is a synchronous reader for the INLINE
    // path, which a host without a worker has to supply because node has no
    // `XMLHttpRequest` and a body's read cannot wait for a promise. A runner
    // with neither runs bodies that read nothing, and every task whose body
    // reads anything delivers `failed` - which is the same answer `console.c`
    // gives a session `console_start` was handed a null reader for.
    constructor (module, trampoline, core, workerUrl, resources) {
        this.module = module;

        // This host's own module, carried beside the game's for the same
        // reason and by the same route: a body's instance needs its three
        // wrappers as much as the game's does, and a `WebAssembly.Module`
        // clones to a worker rather than being recompiled there.
        this.trampoline = trampoline;

        // And the rulebook, for the one rule a body needs: the six a
        // `Game_Resource` is held to, spent inside the read that named one. It
        // is a `HostCore` here, for the inline path that runs a body on this
        // thread, and its MODULE is what rides the message to a worker - the
        // same clone-rather-than-recompile the other two get, and an instance
        // of its own on the other side, because a linear memory does not cross
        // a thread.
        this.core = core;

        this.workerUrl = workerUrl || null;

        const held = resources || {};

        this.base = held.base || null;

        // The inline reader, which a host may hand over and otherwise gets
        // built from the directory: `resourceReader` answers null where there
        // is no `XMLHttpRequest`, so a runtime with no browser in it falls back
        // to reading nothing rather than to a broken reader. A page never
        // reaches this at all - it always names a worker - so the default is
        // for a browser-like host without one, and the injection is for a
        // harness with bytes of its own.
        this.read = held.read
            || (this.base ? resourceReader (this.base, held.codecBase) : null);

        // Every worker this session has started and not yet ended, by the id it
        // was started for. One map rather than two, because a worker is one
        // task's: "which bodies are in the air" and "which threads are alive"
        // are the same question now, and a runner that kept them apart could
        // answer them differently.
        this.live = new Map ();
    }

    // Whether a body will leave this thread. Nothing about the output depends
    // on the answer, and nothing may branch on it in a way a replay would see -
    // what does depend on it is whether the page freezes for the length of the
    // body, which is the whole reason the offload exists.
    offloads () {
        return typeof Worker !== "undefined" && this.workerUrl !== null;
    }

    run (id, task, input) {
        if (! this.offloads ()) {
            return Promise.resolve (runTaskBody (this.module, this.trampoline,
                this.core, task, input, this.read));
        }

        const worker = new Worker (this.workerUrl);

        return new Promise (resolve => {
            // The one answer this worker exists to give, however it arrives.
            // The entry is struck BEFORE the thread is ended and before the
            // promise settles, so a second message, or a release racing this
            // one, finds nothing here and does nothing.
            const answer = (value) => {
                if (! this.live.delete (id)) { return; }

                worker.terminate ();

                resolve (value);
            };

            this.live.set (id, worker);

            worker.onmessage = (event) => {
                const { output, note, reads } = event.data;

                answer ({ output, note, reads: reads || [] });
            };

            // A worker that cannot load its script, or that dies, answers
            // nothing for the ONE task it was holding - so that task is failed
            // here rather than left waiting for a message that is not coming,
            // and every task beside it is untouched, because every task beside
            // it is another thread. Everything else in this file treats "the
            // host could not run it" and "the body trapped" as one condition,
            // and the interface is why: `done` with a null `bytes` is all the
            // game is told, and no output is coming under either.
            worker.onerror = (event) => {
                answer ({ output: null, reads: [],
                    note: `the task worker failed: `
                        + `${event.message || event.type}` });
            };

            // Last, so that a worker whose script will not load has both
            // handlers installed before the failure can reach them. The module
            // and the directory ride with the task rather than ahead of it,
            // because this worker will never be sent a second one.
            worker.postMessage ({ id, module: this.module,
                trampoline: this.trampoline, core: this.core.module,
                resources: this.base, task, input });
        });
    }

    // A task the game has released before its answer arrived, which the header
    // makes a cancel - and which is a cancel in fact now rather than only in
    // what the game is told.
    //
    // Two halves. The entry is struck, so an answer already in the air is
    // dropped above: that is the half which has to be true whatever else
    // happens, since a runner's `release` promises the id it took is never
    // answered. And the thread is ENDED, so a body that has
    // not finished never does - which the resident worker could not do, because
    // killing it to stop one body took every body queued behind it. Nothing is
    // queued behind this one.
    //
    // A game observes neither half, and that is the point: the promise it was
    // given is the same promise, kept by stopping the work instead of by
    // discarding it. `console.c` cannot follow it here for a reason that is
    // about its own shape rather than about the rule - it forks and WAITS, so
    // the body has already run to completion by the time a release can name it.
    release (id) {
        const worker = this.live.get (id);

        if (! worker) { return; }

        this.live.delete (id);

        worker.terminate ();
    }

    // Every body still in the air, abandoned. A page calls this when it
    // replaces a session: a thread computing for a game that no longer exists
    // is a core spent on an answer nothing will read, and its message would
    // reach a linear memory nothing is playing out of.
    stop () {
        for (const worker of this.live.values ()) { worker.terminate (); }

        this.live.clear ();
    }
}

// Which arena block a size takes, rounded up to a power of two from sixteen.
//
// The bump allocator has no free, so a released block is kept on a spare list
// and handed to the next answer of the same shape. Keyed by an exact size that
// works perfectly for the shape the header recommends - `output_size` is a
// constant on a static descriptor, so sizes recur by construction and recycling
// is exact - and unboundedly badly for the shape the header calls off idiom: a
// descriptor built on the stack with a computed size, minting a fresh size per
// spawn, grows a spare list per size for ever.
//
// Rounding bounds that at about twenty classes over every size a 240x240
// console can produce, for at most 2x internal waste, and the game can tell by
// nothing: the runner's `bytes` carries no size, the block is written to exactly
// `output_size` and read to exactly `output_size`, and the slack is cleared
// when a block is recycled so two hosts cannot differ about it either.
//
// `Math.pow` rather than `1 <<`, which is not a style choice: JavaScript's
// shift operators coerce to a SIGNED 32-bit integer, so a class at or above
// 2^31 would come back negative and the block would be allocated at a negative
// address. `products/vorbis`'s own `alloc` carries the same note about the same
// hazard one subsystem over.
function sizeClass (size) {
    const least = 16;

    if (size <= least) { return least; }

    return Math.pow (2, 32 - Math.clz32 (size - 1));
}

// ---------------------------------------------------------------------------
// The store: what this host keeps for a game between runs.
//
// `localStorage`, under `arcade:save:<name>` with the module's own declared name,
// and the value is the blob in the one spelling a blob has anywhere it leaves a
// host's memory - lowercase hex, two characters a byte. It is the same text a
// recording's `save` line carries and the same text `inspector save` writes, so
// every round trip between the three is string equality: a store value pasted
// into a replay replays, and a replay's line diffed against a store reads.
//
// EVERY DEFECT IS DISCARDED TO ZEROS, SILENTLY, and that is the whole ladder -
// an absent key, an odd number of digits, a stray character and a byte count
// that is not this module's `save_size` each deliver `save_size` zeros and start
// the run. It is the opposite of what `inspector --save` does with a file it
// was handed, and deliberately so: a path a person typed and got wrong is a
// mistake they can fix, where a store defect is a byte a browser lost with
// nobody to tell. A page a corrupt byte can wedge is worse than a lost score.
//
// A blob is never refused for its CONTENT either, on any path. The host keeps
// the bytes and interprets none of them, so a blob of the right length that
// says nothing this game understands is the game's to discard - which is what
// `games/example`'s version word is for.
//
// `save` is deliberately not a third key this page keeps. Reserving it would
// say the address bar can address the store, and the debate settled that it
// must not: saves are not link-composable, so a pair named `save` is an
// ordinary argument like any other and reaches the game.
//
// WHAT NOTHING HERE PRETENDS. The store is the player's to read and to edit,
// origin `null` is shared on `file://` so any local page can reach the key, and
// a single-player score on the machine that set it is not a threat model.
// ---------------------------------------------------------------------------

const SAVE_KEY_PREFIX = "arcade:save:";

// Ten seconds between backstop writes. It is the BACKSTOP rather than the way
// a page normally saves - the two events below are - so the number is what a
// browser that fires neither of them costs a player rather than what a write
// costs a frame: at most this much play, against one `save` call and one string
// assignment every six hundred frames, which is below anything a 60 Hz loop can
// feel. What it is really for is the one exit no handler sees at all, which is
// the process being killed.
const SAVE_PERIOD = 10000;

const SAVE_HEX = /^[0-9a-f]*$/;

// A blob as it is written down, which is one function because there is one
// spelling. Lowercase, two characters a byte, no separator and no prefix.
function saveHex (blob) {
    return Array.from (blob,
        byte => byte.toString (16).padStart (2, "0")).join ("");
}

class SaveStore {
    // `holder` is anything with `getItem` and `setItem`, which in a browser is
    // `localStorage` and in a test is a table. Handed in rather than reached
    // for, so that nothing here knows where a page keeps things - and so that
    // the ladder below can be driven without one.
    constructor (holder) {
        this.holder = holder;
    }

    key (name) { return SAVE_KEY_PREFIX + name; }

    // `size` bytes for this game, and `size` zero bytes for every way the store
    // can be wrong. Null for a module that persists nothing, which is the one
    // answer here that is not bytes.
    //
    // The read itself is inside the ladder rather than beside it, because a
    // store that is disabled, full or partitioned THROWS on the way in rather
    // than answering nothing - so a page that only checked what came back would
    // refuse to start on the browsers that most need the discard.
    read (name, size) {
        if (! size) { return null; }

        const blob = new Uint8Array (size);

        let written = null;

        try { written = this.holder.getItem (this.key (name)); }
        catch { return blob; }

        // Absent, and then the two shapes at once: a blob is two characters a
        // byte, so one comparison rules out both an odd number of digits and a
        // count that is not this module's. The charset is asked separately
        // because `parseInt` answers `NaN` for a stray character and `NaN`
        // stored into a `Uint8Array` is 0 - a silently different blob rather
        // than a discarded one.
        if (typeof written !== "string") { return blob; }

        if (written.length !== size * 2) { return blob; }

        if (! SAVE_HEX.test (written)) { return blob; }

        for (let at = 0; at < size; at++) {
            blob [at] = parseInt (written.substr (at * 2, 2), 16);
        }

        return blob;
    }

    // And back, which cannot fail loudly either: a store over quota throws on
    // the way out, and a run that stopped because it could not record a score
    // would be the same defect the discard ladder above exists to refuse.
    write (name, blob) {
        try { this.holder.setItem (this.key (name), saveHex (blob)); }
        catch { /* A score this browser would not keep, and no run to end. */ }
    }
}

// The moments a live page writes that store, and the backstop under them.
//
// `save` is a pure function of const state, so WHEN a host calls it is
// unobservable to the run - `interface/game.h` says so, and that is what makes
// the schedule host policy rather than contract. What is left to get right is
// that it happens between frames, and often enough.
//
// BETWEEN FRAMES COMES FREE HERE, and it is worth writing down rather than
// leaving to be noticed. A page runs on one thread, `advance` is synchronous
// from the first line of a `step` to the last of `render_audio`, and an event
// handler and a timer callback are each a task of their own - so none of the
// three writers below can land inside a frame however the browser schedules
// them.
//
// Three of them, none subsuming the others, and MEASURED rather than assumed -
// Chrome 152, headless and headed alike, driven by a page that wrote a mark
// into `localStorage` from each handler and a second launch on the same profile
// that read the marks back:
//
// - Navigating away runs `visibilitychange`, then `pagehide`, then `unload`,
//   and every one of their writes survives. So does quitting the browser.
// - Closing the TAB runs `visibilitychange` and `beforeunload` and their writes
//   survive - and `pagehide` and `unload` never run at all. Three repeats, both
//   modes. That is the one moment `pagehide` alone would have missed, and it is
//   the commonest way a game is left.
// - Killing the process runs nothing, which is what the interval below is for
//   and the only reason it is not decoration.
//
// So the two events are kept for what each covers rather than for tidiness -
// `pagehide` catches the back/forward cache, which a visibility change alone
// does not describe - and neither is trusted to be the last word.
//
// Parameters:
//
// - `frame`: where `pagehide` is dispatched, which in a browser is the window.
// - `page`: where `visibilitychange` is, and whose `hidden` says which way it
//   went.
// - `current`: answers the session playing now, because a reset replaces it.
// - `period`: milliseconds between backstop writes.
//
// Answers the interval's handle, so that a caller which outlives a page can
// stop it.
function watchStore (frame, page, current, period = SAVE_PERIOD) {
    const write = () => {
        const session = current ();

        if (session) { session.writeSave (); }
    };

    frame.addEventListener ("pagehide", write);

    page.addEventListener ("visibilitychange",
        () => { if (page.hidden) { write (); } });

    return setInterval (write, period);
}

// ---------------------------------------------------------------------------
// Session: mirrors what the native player does. Bump allocate above
// __heap_base, call the exported factory, zero fill
// the state block, then step once per frame.
// ---------------------------------------------------------------------------

class Session {
    // `trampoline` is `products/trampoline`'s compiled module, and it is second
    // rather than last because it is not optional and not a preference: a game
    // imports nothing, so without it this host cannot compose a record a game
    // can call through and there is no session to build. It sits beside the
    // game's bytes for that reason - the two halves the plug-in ABI now has,
    // in the order they matter.
    //
    // `workerUrl` is where `task.worker.js` sits, and a host that leaves it out
    // gets a session that runs task bodies on its own thread. That degrades
    // gracefully and is exactly what a browser must not do - a body is seconds
    // of work by design, and on this thread those are seconds the page is
    // frozen - so the page passes it and this comment is the whole of the
    // reason it must. `plays.js` leaves it out on purpose, because node has no
    // `Worker` to offload to anyway.
    //
    // `seed` is the number this run reproduces from, and it is a parameter of
    // its own rather than one of the pairs below for the reason
    // `interface/game.h` gives: it is the one thing every host composes for
    // itself and the one thing no game has to ask for. A run SPELLS it as a
    // pair and `queryArguments` hands back what `host_core_extract_seed` took
    // out, so what arrives here is a number whatever the address said - and a
    // caller composing a list by hand is a caller that already decided, exactly
    // as `console_start` is handed one.
    //
    // `args` is the rest of what the run was told, as `[{ name, value }]` with
    // both members strings, and it is a pass-through: nothing on the module
    // says a word about it in advance, so there is nothing here to match it
    // against. What this constructor owes it is FORMAT and never meaning -
    // `argumentList` below is the whole of that - and then one flat run of
    // `Game_Arg` in linear memory for `construct` to read.
    //
    // `store` is where this host keeps what a game rendered through `save`, and
    // it is LAST because it is the one parameter a session can do without: a
    // caller that leaves it out constructs from zeros, which is what a host
    // holding nothing hands over anyway, and writes nothing back. Every harness
    // in `ctest` but this file's own store cases leaves it out, and so does
    // every replaying host in the tree - only the session producing fresh input
    // writes, which is what keeps a test run from moving anybody's browser.
    constructor (bytes, trampoline, core, seed, args, workerUrl, resources,
        store) {
        // The rulebook this session answers out of, in a linear memory of its
        // own. A `HostCore` rather than a module, because a caller composing
        // one decides how long it lives: a reset is a new game memory and a new
        // core beside it.
        //
        // Everything that used to be a JavaScript table here is in it now - the
        // ids, the slots, the two malformed spawns, the live count a crowded
        // one is decided by, the validity of an id, the staging and both
        // moments of a release - and `docs/host-core-rules.md` names each of
        // those rows.
        this.core = core;

        // Where a session's rules live inside that memory, set once the module
        // has said how many ids it may hold at a time. Zero until then, and
        // nothing below touches the table before it is.
        this.host = 0;

        // THE HALF OF A TASK THAT CANNOT CROSS, keyed by the id the two halves
        // share. The rulebook holds a row of numbers per task and this holds
        // what a row cannot: the bytes a body answered with, the line saying
        // why there are none, the reads it made on the way, and the name its
        // descriptor gave it. Keyed rather than indexed, because the core's
        // rows move whenever its table compacts and an index would name a
        // different task after a release.
        //
        // `running` is this host's own knowledge and no rule at all: WHERE a
        // body executes is the embedder's business, so "is this body still in
        // the air" is a question only the side that started the thread can
        // answer.
        this.work = new Map ();

        // What an answer's bytes cost this arena, by ADDRESS, and the
        // whole of what `reclaimBlocks` reconciles against the table. The core
        // holds the same address as an opaque number beside the id, never
        // dereferences it, and drops it at the moment the bytes must go.
        this.blocks = new Map ();

        // Every read every body made, in the order their answers appeared, with
        // what became of each. This host's own account and no game's: nothing
        // here crosses the interface, and `interface/game.h` says a body's reads
        // are its own world and die with it.
        //
        // It is kept beside the table rather than in it because it has to
        // outlive an entry. A run that ended by drawing its fallback and then
        // released the id would otherwise have nothing left to say about the
        // file it could not read - which is the one thing whoever is watching
        // most wants to know. `resourceLine` is the reader.
        this.readLog = [];

        // What an answer's bytes cost the arena, kept by SIZE CLASS and handed
        // back. The runner's `bytes` points into the GAME's linear memory, and
        // the output was computed in an instance the game cannot reach, so the
        // bytes are copied across that boundary the way they are copied out of a
        // forked child's mapping natively.
        //
        // Reused because the bump allocator has no free and the header has a
        // lifetime: a block is dropped at the frame boundary after the game
        // released its id, so it comes back here and the next answer of that
        // class takes it. `release_task` munmaps at the same moment and for the
        // same reason. Without it a game that spawns once a move would grow its
        // own memory once a move, for the whole run.
        //
        // Rounded to powers of two rather than kept by exact size, which is a
        // backstop rather than the normal case: `output_size` is a constant on
        // a static descriptor, so sizes recur by construction and recycling is
        // exact anyway. What the rounding bounds is the game the header calls
        // off idiom - a descriptor built on the stack with a computed size,
        // minting a fresh size per spawn - which with exact keys would grow a
        // spare list per size for ever. Twenty-odd classes, at most 2x internal
        // waste, and invisible to the game either way.
        this.spare = new Map ();

        this.module = new WebAssembly.Module (bytes);
        this.trampoline = trampoline;

        // Built from the module rather than from the bytes, so that a worker is
        // handed something already compiled. Before the instance, because a
        // spawn can happen inside the very first `step` and there is nothing
        // between construction and that step for a host to fill this in.
        this.runner = new TaskRunner (this.module, trampoline, core, workerUrl,
            resources);

        // AGAINST NOTHING AT ALL, which is the sentence this whole design is
        // for: a game module's import section is empty, so there is no object
        // to build and no name for this host to answer for. What it owes a game
        // arrives the other way, as records this file composes in the module's
        // own linear memory - and the six functions those records point at go
        // into the module's table on the next line.
        this.instance = new WebAssembly.Instance (this.module, {});
        const ex = this.instance.exports;
        this.ex = ex;
        this.memory = ex.memory;
        this.table = ex.__indirect_function_table;

        // Where this module's arena begins, kept beside the bump pointer that
        // is about to leave it behind. It is a CONSTANT OF THE MODULE - the
        // same number in every instance of it, measured on all twelve games in
        // `docs/runs/threaded-host-run.md` (a) - which is what makes a consumer
        // able to lay its own memory out at this session's addresses without
        // being told what this arena did.
        this.heapBase = ex.__heap_base.value ?? ex.__heap_base;
        this.heap = this.heapBase;
        this.seed = seed;

        // Where this session's six functions landed in that table, which is
        // what the records carry in place of addresses.
        this.slots = installTrampoline (trampoline, this.instance,
            this.services ());

        // The loader slot, first, before anything else this arena hands out.
        //
        // A body's loader lives in the BODY's instance and is composed there;
        // what sits here is the same eight bytes at the same address in the
        // game's instance, so that a body which wrote its loader's address into
        // its output leaves a `step` reading a well formed record rather than
        // whatever the arena happened to hold. `runTaskBody` carries the whole
        // argument at its own first allocation. Its `context` is `LOADER`,
        // which is the value this session's `load` exists to refuse.
        this.loaderPtr = this.alloc (LAYOUT.loader.bytes);

        {
            const compose = this.view ();

            compose.setUint32 (this.loaderPtr + LAYOUT.loader.context, LOADER,
                true);
            compose.setUint32 (this.loaderPtr + LAYOUT.loader.load,
                this.slots.load, true);
        }

        // The ring of runner records, one per slot, laid down once and armed
        // a call at a time by `armRunner`. A ring rather than one record
        // because a game stashes the ADDRESS, and one record re-stamped would
        // answer a stale pointer with this frame's context.
        //
        // As many records as the rulebook keeps STAMPS, asked for rather than
        // written down: a ring one slot longer than the stamps behind it would
        // hand two frames one address with nothing able to tell them apart,
        // which is the failure the ring exists to remove.
        //
        // ONE MORE THAN THE RING, for `construct`'s own slot. It runs before
        // frame 0, so a record taken out of the ring would be step 0's - and the
        // one misuse a ring of numbers cannot see is exactly a record stashed by
        // `construct` and spent on step 0.
        this.constructSlot = core.figure (CORE.figure.contextRing);

        this.runnerRing = this.alloc (
            (this.constructSlot + 1) * LAYOUT.runner.stride);

        // And the renderer's record, one rather than a ring. A renderer is
        // never called inside another - `interface/game.h` says so of all three
        // - so there is no second call to tell this one apart from, and one
        // address is the whole of what a consumer has to be told.
        //
        // WHAT IS COMPOSED HERE IS NEVER HANDED TO ANYTHING. This session runs
        // no renderer: the picture is rendered in the render worker's instance
        // and the sound in the worklet's, and each writes its OWN record at this
        // address in its own memory, over its own table's index. So what this
        // allocation really publishes is the address - `layout` below carries it
        // - and what these two words are for is the refusal: a call reaching
        // this record is a game that kept the address and spent it from a
        // `step`, and `read` below answers every one of them the same way.
        this.readerPtr = this.alloc (LAYOUT.reader.stride);

        {
            const compose = this.view ();

            compose.setUint32 (this.readerPtr + LAYOUT.reader.context, READER,
                true);
            compose.setUint32 (this.readerPtr + LAYOUT.reader.bytes,
                this.slots.read, true);
        }

        // One game per module: the factory is a direct export, so there is no
        // enumeration and no table lookup to reach it.
        //
        // Allocated with a GUARD past the end, and that guard is this page's
        // answer to one of three silent skews between a DEPLOYED player and a
        // deployed module - the class
        // `docs/archived/unified-tasks-phase0/findings.md` section 5.2 names
        // and this file owes something to.
        //
        // `LAYOUT.game.bytes` is how much linear memory `factory` is handed. A
        // player one build behind a module hands it a block SHORTER than the
        // struct the module writes: 52 bytes against 56 when `task_max` was
        // added, so four bytes land on whatever the arena put next. That is a
        // heap overwrite, it is the loudest and least predictable of the three,
        // and the `static_assert` that would warn about it fires in the GAME's
        // build rather than at load - which is exactly the half a deployed page
        // never sees.
        //
        // Sixteen poisoned bytes past the end turn it into a refusal naming
        // both numbers. It cannot be fooled by a value: `factory` writes
        // members and never the tail, so an untouched guard is a module that
        // fits and a moved one is a module this mirror is too small for. The
        // block itself is still zero filled, because the header requires it -
        // a member `factory` does not write must read back null rather than
        // whatever was there.
        const guardBytes = 16;
        const poison = 0xa5;

        const gamePtr = this.alloc (LAYOUT.game.bytes + guardBytes);

        // Kept, because a consumer of this session's states calls `factory` in
        // its own instance and has to write the struct SOMEWHERE: at this
        // address it lands on bytes that are host memory in both instances and
        // that its own `factory` fills with the same values, so no region a
        // state can reference is disturbed by it.
        this.gamePtr = gamePtr;

        new Uint8Array (this.memory.buffer, gamePtr,
            LAYOUT.game.bytes + guardBytes).fill (poison);

        new Uint8Array (this.memory.buffer, gamePtr,
            LAYOUT.game.bytes).fill (0);

        ex.factory (gamePtr);

        const spilt = new Uint8Array (this.memory.buffer,
            gamePtr + LAYOUT.game.bytes, guardBytes).findIndex (
                byte => byte !== poison);

        if (spilt >= 0) {
            refuse (`this module's factory wrote ${spilt + 1} byte(s) past the `
                + `${LAYOUT.game.bytes} this page allocates for \`Game\`. The `
                + `LAYOUT block in player.js mirrors interface/game.h by hand, `
                + `so this page is older than the module it was handed - and `
                + `without this guard those bytes would have landed on `
                + `whatever the arena put next.`);
        }

        const view = this.view ();
        const g = LAYOUT.game;
        this.stateSize = view.getUint32 (gamePtr + g.size, true);
        this.namePtr   = view.getUint32 (gamePtr + g.name, true);
        this.version   = [0, 4, 8].map (o => view.getUint32 (gamePtr + g.version + o, true));

        // AND NOT THE PALETTE, which is the one identity field a session has no
        // reader for. Colours are read off a `Consumer` - the page's bare
        // `declaration` for the chrome, the render worker's instance for the
        // pixels - because both of those draw and this one does not.

        // Read through the table, then held to the ARITY the header declares -
        // which is the second of the three deployed skews, and the one that had
        // been priced as unfixable.
        //
        // JavaScript drops extra arguments and passes `undefined` for missing
        // ones, so a call across a version boundary is silent in both
        // directions: a page still handing `step` the eight arguments it took
        // before unified tasks would give a module three pointers in the wrong
        // slots rather than three zeros. In the build tree that is caught by the
        // committed golden compared against three independent implementations;
        // between a deployed page and a deployed module it is caught by
        // nothing.
        //
        // A wasm exported function is a JS function whose `length` is its
        // declared parameter count - measured on the built modules, where
        // `step` reads 3 and `construct` reads 6 - so the check costs a
        // comparison and needs no new machinery at all. It is skipped on an
        // engine that does not report one, because a false alarm here would
        // refuse a working game, and this is a check that can only ever be
        // right about a module it is already about to run.
        const held = (offset, want, what) => {
            const pointer = view.getUint32 (gamePtr + offset, true);

            if (! pointer) { return null; }

            const fn = this.table.get (pointer);

            if (typeof fn.length === "number" && fn.length !== want) {
                refuse (`this module's \`${what}\` takes ${fn.length} `
                    + `argument(s) where this page calls it with ${want}. `
                    + `Arity is silent in both directions in JavaScript, so a `
                    + `page and a module from two different builds would `
                    + `otherwise hand a game plausible values in the wrong `
                    + `slots rather than failing.`);
            }

            return fn;
        };

        // Six where it was two, and the arity is what makes a module built
        // before a run could be told anything visible at all. Nothing on
        // `Game` moved for arguments - a game declares none - so the size
        // guard above cannot see that skew and neither can any offset in
        // `LAYOUT`; save state DID move the struct, so a module older than the
        // two tail members is caught twice over.
        //
        // Which of the stale shapes is dangerous depends on the ORDER, and
        // that is worth writing down because it moved. The call is the state,
        // the seed, the pairs and their count: a module still taking the state
        // and the seed is handed exactly those two, and the pairs it never
        // heard of are dropped. The one that goes wrong is the THREE-parameter
        // shape this tree carried for a week, where the seed was one of the
        // pairs - it reads this call's seed as its argument array's pointer
        // and the array's pointer as its count, which is plausible values in
        // the wrong slots, no crash and no diagnostic. A length cannot tell
        // the two apart, so both are refused. `arg_count` is redundant to a
        // game that reads by name; it is in the call so that this comparison
        // has something to see.
        this.construct = held (g.construct, 6, "construct");
        this.step = held (g.step, 3, "step");

        // NEVER CALLED HERE, and kept for exactly what the sound's twin below
        // is kept for. The picture is rendered in the render worker's own
        // instance of this module, on that instance's own table index, so
        // nothing on this side ever spends this pointer - what it is read for is
        // the presence check and the arity check, which refuse a module that
        // describes no picture, and a deployed module whose `render_video` takes
        // the wrong number of parameters, before a frame is stepped rather than
        // on a thread that can say nothing about it.
        this.renderVideoFn = held (g.renderVideo, 3, "render_video");

        // Optional: a silent game declares none.
        //
        // NEVER CALLED HERE, and kept anyway. The sound is rendered in the
        // worklet's own instance of this module, on that instance's own table
        // index, so nothing on this side ever spends this pointer - what it is
        // read for is the arity check, which refuses a deployed module whose
        // `render_audio` takes the wrong number of parameters before a frame is
        // stepped rather than trapping on the audio thread where a page can say
        // nothing about it, and the two questions below: whether the module's
        // sound triple is whole, and whether a tick has any sound to post.
        this.renderAudioFn = held (g.renderAudio, 3, "render_audio");

        // What the game says it reads of `Game_Input`. A declaration about the
        // module rather than about a frame, so it is read once here rather than
        // per frame, and it is acted on in `advance`: whatever the game did not
        // declare is written as zero for the whole run. `console.c` and
        // `goldenhash.js` implement the identical rule at the identical point,
        // and one committed golden pins all three - so this is not a page
        // policy, it is the contract spelled a third time.
        this.controls = {
            buttons: view.getInt32 (
                gamePtr + g.controls + LAYOUT.controls.buttons, true),
            pointer: view.getInt32 (
                gamePtr + g.controls + LAYOUT.controls.pointer, true),
        };

        // The palette entry the game wants around its screen. Masked as the
        // console masks it, because the interface says this indexes the palette
        // exactly as a framebuffer byte does - so `PALETTE_SIZE - 1` here is
        // the same operation `paint` performs on every pixel, and no value read
        // out of this byte can subscript past the palette.
        //
        // Read here beside `controls` because it is the same kind of thing: a
        // declaration about the module rather than about a frame, so it is read
        // once at load and cannot be made to vary. Nothing about it reaches the
        // game or the simulation - it is the only field in this block the page
        // spends on itself rather than on running the module.
        this.background =
            view.getUint8 (gamePtr + g.background) & (PALETTE_SIZE - 1);

        // How many ids this game may hold at once, and what everything this
        // host keeps about tasks is measured against: it bounds the live ids a
        // spawn answers 0 past, an answered id and a failed one included, and
        // the table below is sized from it. Read here beside `controls`
        // and `background` because it is the same kind of thing - a
        // declaration about the module, read once at load.
        this.taskMax = view.getUint32 (gamePtr + g.taskMax, true);

        // What this game persists, read here beside `taskMax` because it is the
        // same kind of thing: a declaration about the module, read once at
        // load. Zero is a game that keeps nothing between runs, and `construct`
        // is then handed null - which is the spelling `interface/game.h` gives
        // that case and the only one it gives.
        this.saveSize = view.getUint32 (gamePtr + g.saveSize, true);

        // And the renderer that fills those bytes, held to its arity like every
        // other call across this boundary. Read here rather than beside
        // `render_video` above, because the two are one declaration: the size
        // says how many bytes a run keeps and this says who writes them.
        this.saveFn = held (g.save, 2, "save");

        // Both refusals are decidable from the module alone, so both are
        // answered here before a frame runs, in the words `console.c` and
        // `goldenhash.js` answer them in.
        //
        // The load-time family is mostly the CLI's question, and these two are
        // here anyway for a reason particular to this host: it is the one that
        // is POINTED AT a module by URL, so the number below is the only one in
        // this file that arrives from a stranger and is then spent on an
        // allocation. A `save_size` past the roof would reach `alloc` as a
        // request to grow linear memory by whatever the module said, and what a
        // reader would see is a `RangeError` from an arena rather than a module
        // that declared more than a host carries. The pair check beside it
        // costs one comparison and turns a saving game that would silently
        // persist nothing into a page that says which half is missing.
        if (this.saveSize > core.figure (CORE.figure.saveMax)) {
            refuse (`this module declares a save_size of ${this.saveSize}, and `
                + `a host carries at most `
                + `${core.figure (CORE.figure.saveMax)} bytes of save state.`);
        }

        if ((this.saveSize !== 0) !== (this.saveFn !== null)) {
            refuse (`this module's factory left the Game struct incomplete: `
                + `save_size is ${this.saveSize} and \`save\` is `
                + `${this.saveFn ? "set" : "null"}, and the two are declared `
                + `together or not at all.`);
        }

        // What each renderer is handed, read here beside `saveSize` because it
        // is the same kind of thing: a declaration about the module, read once
        // at load.
        this.videoStateSize = view.getUint32 (gamePtr + g.videoStateSize, true);
        this.audioStateSize = view.getUint32 (gamePtr + g.audioStateSize, true);

        // And the two renderers that fill those bytes, held to their arity like
        // every other call across this boundary. The capture is the
        // SIMULATION's and is taken after a step, so this session is where they
        // are called and a consumer never calls either.
        this.captureVideoFn = held (g.captureVideo, 2, "capture_video_state");
        this.captureAudioFn = held (g.captureAudio, 2, "capture_audio_state");

        // The picture's pair refused half-declared, in the words `console.c`
        // and `goldenhash.js` refuse it in, and for the reason the save pair
        // is: bytes nothing renders, or a renderer whose length is zero.
        if ((this.videoStateSize !== 0) !== (this.captureVideoFn !== null)) {
            refuse (`this module's factory left the Game struct incomplete: `
                + `video_state_size is ${this.videoStateSize} and `
                + `\`capture_video_state\` is `
                + `${this.captureVideoFn ? "set" : "null"}, and the two are `
                + `declared together or not at all.`);
        }

        // The SOUND is a triple where the picture is a pair, because
        // `render_audio` is optional and the description it would have read is
        // optional exactly where it is. All three or none, named together for
        // the console's reason: which of them a reader has to go and write is
        // not decidable from here.
        if ((this.renderAudioFn !== null) !== (this.audioStateSize !== 0)
            || (this.audioStateSize !== 0) !== (this.captureAudioFn !== null))
        {
            refuse (`this module's factory left the Game struct incomplete: `
                + `\`render_audio\` is `
                + `${this.renderAudioFn ? "set" : "null"}, audio_state_size is `
                + `${this.audioStateSize} and \`capture_audio_state\` is `
                + `${this.captureAudioFn ? "set" : "null"}, and the three are `
                + `declared together or not at all.`);
        }

        // And the picture's zero, which is a WHOLE declaration and refused all
        // the same: it said *the state block is the description*, and a host
        // reading it carried a second path through every renderer for a
        // spelling nothing says any more. Unconditional where the sound's zero
        // is legal, because `render_video` is required and there is no game
        // with no picture to describe.
        if (! this.videoStateSize) {
            refuse ("this module declares no picture description: "
                + "video_state_size is 0, and a game declares what its "
                + "renderers read.");
        }

        // And the session of rules that declaration sizes, laid out in the
        // core's own memory the moment the number is known - exactly as a host
        // allocates `Game.size` from what a game declared, one memory along.
        this.host = core.begin (this.taskMax);

        // The entries that table holds, which is the rulebook's own answer
        // rather than an arithmetic this file repeats: it derives the figure
        // from the worst moment a conforming game can reach - `task_max` live
        // ids, plus the answered ids released inside one frame - so a page that
        // filled this many rows is playing a game `inspector` could not replay
        // either.
        this.taskSlots = core.slots (this.host);

        // A need outside the enumeration is this mirror reading the wrong four
        // bytes, which is the hazard `LAYOUT` carries and the one failure that
        // is otherwise silent: a garbage need still compares unequal to
        // `NEED.none`, so the game would simply be handed input and nothing
        // would look wrong. Refused by name here instead, which is the only
        // check this page can still make before a game has run: everything
        // about resources is now something a game says by calling in.
        for (const part of ["buttons", "pointer"]) {
            if (NEED_NAMES [this.controls [part]] !== undefined) { continue; }

            refuse (`${this.name} declares ${part} as need `
                + `${this.controls [part]}, which is not one of `
                + `${NEED_NAMES.join (", ")}. That is the LAYOUT block reading `
                + `the wrong offset rather than anything the game did.`);
        }

        // What this run was told, held to the FORMAT every host holds it to and
        // to nothing else, and sorted by name because the header makes delivery
        // order part of the contract. Before the state block is allocated and
        // long before `construct`: a pair this host cannot store, sort or
        // round-trip is a run that cannot be reproduced, so it is refused
        // rather than trimmed into something the run never said.
        //
        // Held here as well as in `queryArguments` deliberately. That function
        // is the URL's reader and this constructor is the console: a harness
        // builds a session from a list it composed itself, and a pair reaching
        // `construct` unchecked would be one host's run and no other's.
        this.supplied = argumentList (args || [], core);
        this.argCount = this.supplied.length;

        this.statePtr = this.alloc (this.stateSize);
        new Uint8Array (this.memory.buffer, this.statePtr, this.stateSize).fill (0);

        // The pairs `construct` is handed, laid down ONCE, here, in a region
        // nothing gives back. The arena is a bump allocator with no free, and
        // the one thing that ever comes back to it is a task's output block
        // through `spare` - which only ever holds blocks `takeOutput`
        // allocated - so a block taken before any task has run is a block no
        // later frame can be handed.
        //
        // That lifetime is the point rather than an implementation detail.
        // `interface/game.h` says the array and the strings its pairs carry are
        // the host's for the WHOLE RUN, so that a game may keep a `value` as a
        // pointer for its own bookkeeping and for a dump to name. Building the
        // lot once is what makes that true here, and `reset` is what keeps it
        // from leaking: a reset is a new session with a new linear memory, and
        // the pairs are laid down again in it.
        this.argsPtr = this.buildArguments ();

        // The store this host keeps for this game, or nothing at all - which is
        // every session but the one a live page plays.
        this.store = store || null;

        // What it held, and `save_size` ZEROS for every other answer: an absent
        // key, a defect the ladder in `SaveStore` discarded, and a caller with
        // no store at all all arrive here the same way. A host holding nothing
        // delivers zeros rather than null, which is what `interface/game.h`
        // means by fresh, so a game needs no absence branch and this needs one
        // branch rather than five.
        //
        // Kept as a copy of its own rather than read back out of linear memory,
        // because it is what the RECORDING carries: the blob a run was handed
        // is the host's and immutable, and a recorder that read it back through
        // the game's own memory would write down whatever a game had scribbled
        // over it.
        this.saved = this.saveSize
            ? (this.store
                ? this.store.read (this.name, this.saveSize)
                : new Uint8Array (this.saveSize))
            : null;

        // The blob `construct` is handed, laid down once beside the pairs and
        // in a region nothing gives back, because the header makes it the
        // host's for the WHOLE RUN - a game may keep a pointer into it exactly
        // as it may keep a `value`. `NOTHING` for a module that declares none,
        // which is the spelling for that case and for no other.
        this.savedPtr = this.saveSize ? this.alloc (this.saveSize) : NOTHING;

        // And where `save` writes, which is a block of its own rather than the
        // one above: `out` is the host's and never read back, and the blob
        // beside it is immutable for the length of the run, so rendering into
        // it would move bytes a game may still be holding a pointer into.
        this.savePtr = this.saveSize ? this.alloc (this.saveSize) : NOTHING;

        // After both allocations rather than between them, because `alloc`
        // grows linear memory when a block does not fit and `memory.grow`
        // detaches every view in the page - so a view built before the last
        // allocation would silently write nothing at all.
        if (this.saveSize) {
            new Uint8Array (this.memory.buffer, this.savedPtr, this.saveSize)
                .set (this.saved);
        }

        this.inputPtr = this.alloc (LAYOUT.inputBytes);

        // The framebuffer and the audio block, and this session writes NEITHER:
        // `render_video` runs in the render worker's own instance and
        // `render_audio` in the worklet's. Both are allocated HERE all the same,
        // and that is the point rather than a leftover - a consumer lays no
        // arena down, so what makes its scratch land somewhere that overlaps no
        // state block and no task block is that this arena chose the address and
        // published it. Two 57,600- and 1,600-byte holes in the simulation's
        // memory buy every consumer a place to render into, and this session
        // never spends either.
        this.videoPtr = this.alloc (FRAME_WIDTH * FRAME_HEIGHT);
        this.samplesPtr = this.alloc (SAMPLES_PER_FRAME * 2);

        // The two descriptions, taken after every step and handed to the
        // renderers in place of the state block. The picture for every module
        // that reaches here, because one describing none was refused above; the
        // sound for every module that has one to render.
        this.videoStatePtr = this.alloc (this.videoStateSize);

        this.audioStatePtr = this.audioStateSize
            ? this.alloc (this.audioStateSize) : NOTHING;

        // The `task` and `taskfail` half of a mark, written on the frame an
        // answer becomes visible and by id, because that is the whole of what
        // the format carries: the spawn re-fires from the same state on the
        // same frame, so a replay regenerates the output bytes rather than
        // reading them out of a file meant to outlive the build that made it.
        // Without this a page that completes tasks writes marks that replay
        // with the answers never arriving, deterministically and wrongly.
        this.taskLog = [];

        // What to tell the host when a body has answered and is waiting for a
        // frame boundary. A host that steps every frame needs nothing here and
        // gets the default; one that can STOP stepping has to be told, because
        // a staged answer is shown by the next `advance` and there may not be
        // one.
        //
        // This is the second half of what ends `game_report_idle`, and the half
        // `interface/game.h` calls easy to forget: a task becomes ready under a
        // game whose state had no other reason to move, so a host asleep on that
        // game's promise would sleep through the one thing it was waiting for.
        // Assigned rather than passed, so a session still knows nothing about
        // why a host might have stopped asking it for frames.
        //
        this.onStaged = () => {};

        // And the runner `construct` is handed, on a slot of its own outside the
        // ring. Boot work is the task system's dominant use and its input is
        // derived from the very pairs beside it, so this is where a game asks
        // for it - and the record is armed, spent and retired exactly as a
        // frame's is, because it is the same record under the same rule.
        this.construct (this.statePtr, seed, this.savedPtr, this.argsPtr,
            this.argCount, this.armConstruct ());

        this.retireConstruct ();

        // Before any frame, so that a host drawing before its first step is
        // handed a description rather than the zeros a fresh hole begins with.
        this.capture ();

        // The replay log records only changes: input is piecewise constant, so
        // an entry means "these buttons from this frame until the next entry".
        // Every entry carries its own frame, so a damaged log corrupts one
        // interval rather than shifting everything after it by a frame.
        this.inputLog = [];
        this.tapLog = [];
        this.lastButtons = 0;

        // The pointer is piecewise constant too, so it records the same way and
        // for the same reason. `lastPointer` begins absent, which is what makes
        // a run that never moved the pointer - every run of every game that
        // declares none - write no `pointer` record at all.
        this.pointerLog = [];
        this.lastPointer = { x: 0, y: 0, present: false };
    }

    view () { return new DataView (this.memory.buffer); }

    alloc (size, alignment = 16) {
        this.heap = (this.heap + alignment - 1) & ~(alignment - 1);
        const need = this.heap + size;
        if (need > this.memory.buffer.byteLength)
            this.memory.grow (Math.ceil ((need - this.memory.buffer.byteLength) / 65536));
        const at = this.heap;
        this.heap += size;
        return at;
    }

    // Every static string the module holds is read this way - the game's name,
    // and both halves of every descriptor it loads from - so there is one
    // decoder rather than one per caller.
    string (at) {
        const bytes = new Uint8Array (this.memory.buffer);
        let s = "";
        for (let i = at; bytes [i]; i++) s += String.fromCharCode (bytes [i]);
        return s;
    }

    get name () { return this.string (this.namePtr); }

    // AND NO `palette` AND NO `frame`. Both were views a caller painted out of
    // and there is no caller: `paint` is spent on a `Consumer`'s framebuffer and
    // a `Consumer`'s palette, one thread out, in the instance that rendered
    // them.

    // ----------------------------------------------------------------------
    // Arguments: the pairs this run was told, laid down as the flat array
    // `construct` is handed.
    //
    // It is the only struct this mirror WRITES, and after the rework it is the
    // only thing here that touches arguments at all. There is no declaration to
    // read off the module, no array to walk out of a module's own linear
    // memory, and no name to scan for a terminator somebody else wrote: a game
    // says nothing about arguments in advance, so what a wrong constant costs
    // here is bytes THIS FILE laid down being read at the wrong stride, which
    // `interface/game.h` pins at 8 on wasm32 and asserts in the game's own
    // build.
    //
    // What is left to get right is therefore small and complete: one contiguous
    // run of pairs at four byte alignment, a NUL terminated `name` and `value`
    // behind each, sorted bytewise by name, and every allocation made before
    // any view is built - because `alloc` grows linear memory and
    // `memory.grow` detaches every view in the page, so a view built before the
    // last allocation would silently write nothing at all.
    // ----------------------------------------------------------------------

    // The block `construct` reads. `NOTHING` for a run that supplied no pairs,
    // which is the null `interface/game.h` names as the spelling for that and
    // as nothing else - so a game written before a run could be told anything
    // is handed exactly what it was handed then.
    buildArguments () {
        // Where the pairs and their strings ended up, as one span, or null for
        // a run that supplied none. A consumer mirrors it once at session
        // start, because `interface/game.h:34-44` makes the argument storage
        // one of the six kinds of memory a state may point into and the header
        // gives it the whole run.
        this.argsRegion = null;

        if (! this.supplied.length) { return NOTHING; }

        // Strings first, at byte alignment, because a string is bytes and the
        // pairs that point at them need the addresses.
        for (const entry of this.supplied) {
            entry.namePtr = this.alloc (entry.name.length + 1, 1);
            entry.valuePtr = this.alloc (entry.value.length + 1, 1);
        }

        const arrayPtr = this.alloc (this.supplied.length * PAIR.bytes, 4);

        const view = this.view ();
        const bytes = new Uint8Array (this.memory.buffer);

        // Printable ASCII by the time it reaches here - `argumentList` refused
        // everything else - so one byte per character, and a length in either
        // unit is the length the native host measures.
        const lay = (at, text) => {
            for (let index = 0; index < text.length; index++) {
                bytes [at + index] = text.charCodeAt (index);
            }

            bytes [at + text.length] = 0;
        };

        this.supplied.forEach ((entry, index) => {
            lay (entry.namePtr, entry.name);
            lay (entry.valuePtr, entry.value);

            const pair = arrayPtr + index * PAIR.bytes;

            view.setUint32 (pair + PAIR.name, entry.namePtr, true);
            view.setUint32 (pair + PAIR.value, entry.valuePtr, true);
        });

        // One span rather than one per string, because the whole lot was laid
        // down by consecutive `alloc` calls with nothing else between them: the
        // first name's bytes to the end of the array is exactly what this
        // method wrote and nothing more.
        this.argsRegion = { address: this.supplied [0].namePtr,
            span: arrayPtr + this.supplied.length * PAIR.bytes
                - this.supplied [0].namePtr };

        return arrayPtr;
    }

    // The `arg` lines a recording carries, one per pair, in the order they are
    // delivered in - which is sorted by name, and is the order every other host
    // writes them in for the same reason.
    //
    // An empty value is the name with NOTHING AFTER IT, which is the format's
    // one spelling for the value that is not absence. Written as its own branch
    // rather than fallen out of a trailing space, because a line ending in a
    // separator is a line whose meaning depends on an editor not stripping it.
    argLines () {
        return this.supplied.map (entry => entry.value === ""
            ? `arg ${entry.name}`
            : `arg ${entry.name} ${entry.value}`);
    }

    // ----------------------------------------------------------------------
    // Save state: the blob this run was handed, and the one it would leave.
    // ----------------------------------------------------------------------

    // The `save` line a recording carries, which is the recorder's rule rather
    // than the store's: a replay carries what was DELIVERED and never a
    // reference to where it came from, so a run recorded here reproduces on a
    // machine whose store holds something else or nothing at all.
    //
    // Written only where the delivered blob had a non-zero byte, and that is
    // what keeps every recording made before this record existed valid
    // unchanged: an absent line means zeros, a host holding nothing delivers
    // zeros, and the two are the same run.
    //
    // SAVE-IN AND NEVER SAVE-OUT, for the reason `argLines` above writes what a
    // run was told rather than what it made of it: `save` is a pure function of
    // a state block a replay already reproduces, so recording its output would
    // record a derivable.
    saveLines () {
        if (! this.saved || ! this.saved.some (byte => byte)) { return []; }

        return [`save ${saveHex (this.saved)}`];
    }

    // What this game would keep if the run ended now: `save_size` bytes out of
    // const state, through the game's own renderer and nobody else's.
    //
    // Called at a frame boundary and never inside one - `watchStore` above says
    // why that comes free on this host - and as many times as a caller likes,
    // because the header makes the schedule unobservable to the run. Null for a
    // game that persists nothing.
    //
    // THE ONLY `save` IN THIS FILE, and the reason a `Consumer` has none: this
    // is the instance that steps, so this is the block where every pointer the
    // game kept resolves. What decides WHEN it is called is `game_report_save`,
    // which the worker reads off a tick and this method knows nothing about -
    // the schedule is the host's and a request only prices it.
    renderSave () {
        if (! this.saveSize || ! this.saveFn) { return null; }

        // Zero filled first, so a renderer that writes less than it declared
        // leaves zeros rather than the last call's bytes - the same sentence a
        // task's output block is handed under.
        new Uint8Array (this.memory.buffer, this.savePtr, this.saveSize)
            .fill (0);

        this.saveFn (this.statePtr, this.savePtr);

        return new Uint8Array (this.memory.buffer, this.savePtr, this.saveSize)
            .slice ();
    }

    // And that into the store, which is the only thing in this file that
    // outlives the run. Nothing at all for a session with no store, which is
    // every headless and every replaying one.
    writeSave () {
        if (! this.store) { return; }

        const blob = this.renderSave ();

        if (! blob) { return; }

        this.store.write (this.name, blob);
    }

    // ----------------------------------------------------------------------
    // Tasks: the host's half of the plug-in ABI, and the answers it becomes.
    //
    // `products/host-core` is where every rule below now lives, once, for the
    // console, the golden and this file alike - so what is left here is a
    // session pointer into another linear memory, the arena the bytes land in,
    // and the sentences a fault earns.
    //
    // They are written out all the same, because a reader of this file has to
    // know what it is being held to before they can see whether the calls below
    // are in the right order:
    //
    // - **An id is live from the spawn until the release**, and is one of the
    //   game's `task_max` slots until the frame boundary that settles the
    //   release. An answered id counts and so does a failed one: polling has no
    //   you-were-told moment, so nothing but the game ends an id.
    // - **A release takes effect at the frame boundary, WHOLE.** The slot and
    //   the bytes are let go of at one moment, cancels included - so the block
    //   a `step` released stays readable for the rest of that frame, because
    //   both renderers run after the step and may not disagree with it about
    //   what is on screen, and a game at its limit that releases and spawns in
    //   its place inside one `step` is answered 0 and spawns next frame.
    // - **`done` flips at a frame boundary and never inside a call**, so what
    //   the runner says about an id is the same throughout one `step`. Nothing
    //   is held back and nothing is ordered - per-id status has no order to pin.
    // - **A spawn with no slot answers 0**, mints nothing and touches nothing,
    //   which is a condition a game acts on. A MALFORMED spawn and an INVALID id
    //   end the run instead, and each of those sentences is byte for byte the
    //   console's and the golden's: `products/host-core` answers the verdict and
    //   the figures, and `docs/host-core-rules.md` carries the templates.
    //
    // Every view below is built where it is used and thrown away again, which
    // is the same rule `frame` and `palette` follow and for the same reason:
    // `alloc` grows linear memory when a block does not fit, and `memory.grow`
    // detaches every ArrayBuffer view in the page.
    //
    // A detached view fails quietly, which is what makes the rule worth
    // stating. Measured on Chrome 151: nothing throws, the view's `length`
    // simply becomes 0 and every read of it is `undefined` - so a cached
    // framebuffer view would paint a blank screen rather than report anything.
    // ----------------------------------------------------------------------

    // The frame this session is on, and the only counter there is.
    //
    // It is the rulebook's, because everything that reads a frame number reads
    // it there: the ring slot a record is stamped with, the frame a stale-runner
    // refusal names, and the frame a mark carries. Two counters that had to
    // agree would be one more thing that can drift, and this one cannot.
    get frameIndex () { return this.core.frame (this.host); }

    // Every row of the rulebook's table, in id order, which is spawn order:
    // ids are monotonic, entries are appended in order, and the compaction a
    // release and a retirement do preserves it.
    rows () {
        const rows = [];

        for (let index = 0; index < this.core.taskCount (this.host); index++) {
            rows.push (this.core.task (this.host, index));
        }

        return rows;
    }

    // Bodies still in the air, which is the one question about a task the
    // rulebook cannot answer and does not try to: a task is `ready` there from
    // the spawn onwards, and whether its body has finished is a fact about the
    // thread this host started for it.
    //
    // The page reads it for nothing; it is here for a host that wants to say
    // whether a game is still waiting on anything, which is what
    // `products/web-player/tests/tasks.js` paces its runs by.
    runningTasks () {
        return [...this.work.values ()].filter (work => work.running);
    }

    // And answers waiting for a frame boundary, which the rulebook does answer.
    stagedTasks () {
        return this.rows ().filter (row => row.staged && ! row.dead);
    }

    // The table as `console_tasks` reports it: everything the game has not
    // released, in id order. An ANSWERED entry stays until the game releases the
    // id, whether it answered with bytes or with nothing: a game that has not
    // polled has not been told, so nothing but the game ends an id.
    //
    // That is what makes it the leak report. A row still `resident` long after
    // its `finished` frame is a block the game is holding and nothing warns.
    //
    // The two halves are joined here and only here: the numbers off the
    // rulebook's row, the name off this host's own record of the spawn, and
    // `running` from the thread rather than from either.
    taskTable () {
        return this.rows ().filter (row => ! row.dead).map (row => {
            const work = this.work.get (row.id);

            return {
                id: row.id,
                name: work ? work.name : "",
                spawned: row.spawned,
                finished: row.finished,
                state: work && work.running
                    ? "running" : CORE.state [row.state],
            };
        });
    }

    // The six functions this session's records point at, as the closures the
    // trampoline forwards to - and `load` is not one of the services. It is
    // answered here to REFUSE, because a parameter list names what its callee
    // can do: a body reads files and cannot spawn, a `step` spawns and releases
    // and cannot read a file, a renderer names a task's bytes and can do
    // nothing else, and the copy that serves a read is the one `runTaskBody`
    // binds against the instance the body runs in.
    //
    // All six are installed whether the game spends any of them or not, and
    // the reason is no longer about import sections: the six wrappers land at
    // fixed table indices in every instance of one module, so a session that
    // installed five and a body's instance that installed six would disagree
    // about what a number in a record means. The console's `hermit` fixture
    // calls no member of the runner it is handed and gets the table's slots
    // exactly as `borrower` does, which is what "permission is not provision"
    // became when the imports went.
    services () {
        // Whether the runner's context is this frame's. A game passes back what
        // the record it was handed carries, so a wrong one is a game that
        // stashed the record and used it a step later - which `game.h` says is
        // refused naming the frame. A null one is not a stale one and is not
        // reported: the console answers a game that passes null by doing
        // nothing at all, and the two hosts have to answer that the same way.
        const armed = (context) => {
            if (! context) { return false; }

            const slot = (context - RUNNER) >>> 0;
            const held = this.core.checkRunner (this.host, slot);

            if (held.verdict === CORE.context.live) { return true; }

            // Two sentences, because `construct` has no frame to name. The slot
            // is what tells them apart, which is the reason the rulebook keeps
            // `construct`'s outside the ring at all.
            if (slot === this.constructSlot) {
                refuse (`the runner handed to construct was used after that `
                    + `call returned; it is valid for one call and no longer`);
            }

            // `armed` is the frame the slot WAS armed for, which is what makes
            // the refusal name the call the record belonged to rather than only
            // the call that misused it. A context that is not one of this
            // host's at all names a slot outside the ring and arrives here as
            // well - a non-null record naming nothing is a record from
            // somewhere, and doing nothing about it would be worse than saying
            // so about frame 0.
            refuse (`the runner handed to frame ${held.armed} `
                + `was used after that step returned; it is valid for one call `
                + `and no longer.`);
        };

        // And the id, held to the one thing every host must agree about it. The
        // VERDICT and the figure are the rulebook's - the table is the oracle,
        // and past the counter, absent below it and 0 are its three answers -
        // and the three sentences are this file's, byte for byte the console's
        // and the golden's. `docs/host-core-rules.md` carries the templates.
        const live = (id, called) => {
            const verdict = this.core.checkId (this.host, id);

            if (verdict === CORE.id.live) { return true; }

            if (verdict === CORE.id.none) {
                refuse (`${called} was called with id 0, which is *no task* `
                    + `rather than a task; a polling site guards on the id it `
                    + `kept`);
            }

            if (verdict === CORE.id.unissued) {
                refuse (`${called} was called with id ${id}, which this run has `
                    + `never issued; ${this.core.issued (this.host)} id(s) have `
                    + `been issued so far`);
            }

            refuse (`${called} was called with id ${id}, which the game has `
                + `already released; a released id names nothing, and release `
                + `pairs with clearing the id it took`);
        };

        return {
            // The loader's `load`, answered here as well as in `runTaskBody`
            // because both instances of one module carry the same three slots.
            // What reaches THIS copy is never a body: bodies run in an instance
            // of their own against the other one. It is the record rule broken
            // the only way a game can break it - a body wrote its loader's
            // address into its output, and a `step` read it back and called
            // through it, which is a call this host arranged to land here
            // rather than on a trap.
            //
            // `console.c` raises a fault in the same position and can name the
            // task, because a native loader's context is a struct carrying one;
            // here it is an opaque number that names nothing, so the refusal
            // says what happened rather than which task it happened to.
            //
            // A null context is not a stale one and is not reported: the
            // console answers a game that passes null by doing nothing at all,
            // and the two hosts have to answer that the same way.
            load: (context) => {
                if (! context) { return 0; }

                refuse (`${this.name} read a resource through a loader from `
                    + `outside the body it was handed to. A loader is valid for `
                    + `one body call and no longer, and a body's own instance `
                    + `is gone by the time its answer reaches a step.`);
            },

            spawn: (context, descriptor, input) => {
                if (! armed (context)) { return 0; }

                // Copied during the call and never retained, which the header
                // requires of the descriptor as well as the input: a game may
                // point at a `Game_Task` in its own state block, and a retained
                // pointer would let it move the sizes under a running task.
                // Read here rather than after the verdict, because the verdict
                // is decided FROM it - and the twenty bytes then cross into the
                // core's memory as a blob, which is the same copy again in the
                // one direction that could not be avoided.
                const task = descriptor ? this.readTask (descriptor) : null;

                // Every rule a spawn is held to, in one call: the two malformed
                // shapes, the game's own live count, and the table this host
                // cannot outgrow. Each is decided from the module and the call
                // alone, which is what lets a condition be a 0 the game acts on
                // and a bug be a fault on the same frame everywhere.
                const answer = this.core.spawn (this.host, task, !! input);

                // A BUG rather than a condition, three ways. A descriptor with
                // nothing to run and a descriptor that disagrees with its call
                // about input are neither of them shapes a correct game reaches,
                // and both were `failed` results only because a result was the
                // one vocabulary a spawn had.
                //
                // A fault stops the run here where `console_fault` records it
                // and lets `inspector` decide, which is the same difference
                // every other fault in this file already has: the page has no
                // caller to hand a fault to and a run it cannot honour is a run
                // it must not draw. These sentences are byte for byte the
                // console's and the golden's, out of one template per verdict.
                if (answer.verdict === CORE.verdict.bodyless) {
                    refuse (`spawn was handed a descriptor with no body, so `
                        + `there is nothing to run and nothing to answer with`);
                }

                if (answer.verdict === CORE.verdict.unfed) {
                    refuse (`spawn was handed a descriptor declaring `
                        + `input_size ${answer.inputSize} and no input to copy; `
                        + `a descriptor and its call agree about input or `
                        + `neither knows what the body reads`);
                }

                if (answer.verdict === CORE.verdict.overfed) {
                    refuse (`spawn was handed an input and a descriptor `
                        + `declaring input_size 0; a descriptor and its call `
                        + `agree about input or neither knows what the body `
                        + `reads`);
                }

                // Derived to be unreachable by a conforming game and kept
                // anyway: a host with no entry left cannot record the spawn at
                // all, and saying so beats inventing a limit the other host does
                // not have. It is one table sizing now rather than two that
                // agree - `host_core_size` derives the figure and
                // `console_task_slots` restates it.
                if (answer.verdict === CORE.verdict.full) {
                    refuse (`spawn is past the ${this.taskSlots} entries a `
                        + `host's table holds at once, which is derived from `
                        + `task_max and is unreachable by a conforming game`);
                }

                // And the one CONDITION, which is not a message at all: the game
                // already holds every id it declared, so no id is minted, no
                // slot is touched, and the 0 it is handed back is the whole of
                // what it is told. A game at its limit retries next frame for
                // free.
                if (answer.verdict === CORE.verdict.crowded) { return 0; }

                const id = answer.id;

                // This host's own half of the entry the core just appended.
                this.work.set (id, { id, name: task ? task.name : "",
                    note: null, reads: [], running: true });

                const bytes = task.inputSize
                    ? new Uint8Array (this.memory.buffer, input,
                        task.inputSize).slice ()
                    : new Uint8Array (0);

                this.runner.run (id, task, bytes).then (answered => {
                    const work = this.work.get (id);

                    // Released while the body was in the air, which a
                    // runner's `release` makes a cancel: the id it took is
                    // never answered, and this is where that promise is kept
                    // against an answer that arrived anyway. A release struck
                    // this host's half of the entry as it struck the rulebook's,
                    // so there being nothing here is the whole of the test.
                    if (! work || ! work.running) { return; }

                    work.running = false;
                    work.note = answered.note;
                    work.reads = answered.reads || [];

                    // THE BLOCK IS TAKEN HERE rather than at the boundary, and
                    // that is what the two memories cost: the address is what
                    // the rulebook stores beside the id and hands back through
                    // `bytes`, so it has to exist by the time the answer is
                    // recorded. Nothing a game can see moves -
                    // the bytes are the same bytes at the same alignment, and
                    // an id released before its answer has its block dropped by
                    // the cancel rather than never taken.
                    let at = 0, span = 0;

                    if (answered.output) {
                        const block = this.takeOutput (answered.output,
                            task.outputSize);

                        at = block.at;
                        span = block.span;

                        this.blocks.set (at, span);
                    }

                    // A body that did not finish and a body whose READ was
                    // refused are one condition here, and the rulebook is told
                    // the same thing about both: `runTaskBody` throws out of
                    // the read, catches it as the body ending without an
                    // output, and answers a null - so `finished` is false and
                    // the staged answer will carry no bytes. `abandoned` is for
                    // a host giving up on work that would otherwise have
                    // arrived, which is `inspector`'s schedule and never a
                    // page's.
                    this.core.answer (this.host, id, !! answered.output, at,
                        span);
                    this.core.stage (this.host, id, false);

                    this.onStaged ();
                });

                return id;
            },

            // The two questions a game asks about an id, which are the whole of
            // what polling is: a level sampled per frame rather than an edge
            // handed over once.
            //
            // Both ask the same two guards and in the same order - is this
            // record this call's, and is this id one the run issued and has not
            // released - because a game reaching into a session between frames
            // and a game asking about a task it let go are two bugs, and each is
            // loud on every host or on none.
            done: (context, id) => {
                if (! armed (context)) { return 0; }
                if (! live (id, "done")) { return 0; }

                return this.core.done (this.host, id) ? 1 : 0;
            },

            bytes: (context, id) => {
                if (! armed (context)) { return 0; }
                if (! live (id, "bytes")) { return 0; }

                // The address the arena handed out, in the GAME's own memory:
                // the rulebook stored it as an opaque number and never
                // dereferenced it, and this is where it goes back to being a
                // pointer the game reads.
                return this.core.bytes (this.host, id);
            },

            // The reader's `bytes`, which is the whole of what a RENDERER may
            // ask this host for. The same sample `bytes` above answers, with
            // the length written beside it: a renderer holds no descriptor, so
            // `output_size` travels with the block rather than being
            // remembered.
            //
            // `size` is written before anything else, so every path out of here
            // leaves a caller a length it can read without first branching on
            // the pointer. A null `size` is a game passing something that is
            // not the out-parameter the header declares, and is left alone
            // rather than written through.
            read: (context, id, size) => {
                const put = (span) => {
                    if (! size) { return; }

                    this.view ().setUint32 (size, span >>> 0, true);
                };

                put (0);

                // A null context is not a stale one and is not reported, for
                // the reason a null runner's is not: there is no session behind
                // one to write a fault into.
                if (! context) { return 0; }

                // ALWAYS, because this session runs no renderer: the picture
                // is drawn in the render worker's instance and the sound in the
                // worklet's, and each answers its own reader out of the blocks
                // it was handed. So a call that reaches here is a game that kept
                // the address and spent it from a `step`, which is the one thing
                // this record can still be used for and is refused rather than
                // served.
                refuse (`${this.name} named a task's bytes through a `
                    + `reader from outside the renderer it was handed to. A `
                    + `reader is valid for one call and no longer, and the `
                    + `instance that steps is handed none at all.`);
            },

            release: (context, id) => {
                if (! armed (context)) { return; }
                if (! live (id, "release")) { return; }

                // What a release MEANS is the rulebook's, and it is ONE
                // MOMENT: the entry is marked here and settles at the next
                // frame boundary, slot and bytes together, a cancel included.
                // So the block stays readable for the rest of this frame -
                // both renderers run after the step and `game.h` promises they
                // cannot disagree with it about what is on screen - and the id
                // stops being one the game may ask about from this call, which
                // is the mark rather than the sweep.
                this.core.release (this.host, id);

                // Unconditional, and it can be. A worker is one task's, and
                // `TaskRunner.release` finds nothing for a task that has
                // already answered, for a refusal that never had a thread, and
                // for an id that was never issued. Asking the table which of
                // those it was would be this file deciding what a release
                // means, which is the sentence that just moved.
                this.runner.release (id);

                this.work.delete (id);

                // No `reclaimBlocks` here, and that is the rule showing
                // through rather than an omission: no row loses its block at a
                // release any more, so the reconciliation would find nothing.
                // `retireFrame` is the one moment this arena takes anything
                // back.
            },
        };
    }

    // This frame's runner record, composed and armed, and the address `step` is
    // handed.
    //
    // `console_step`'s own order, statement for statement: take this frame's
    // slot out of the ring, arm the context for this frame, then point the
    // record at it and at the two functions that spend it. A `step` therefore
    // either gets a runner that is right or gets nothing - which is the
    // composition risk `docs/archived/capability-records-plan.md` says the hosts own now
    // that a binding error can no longer be a link error.
    //
    // Composed WHOLE every frame rather than re-stamped, for the same reason
    // the console composes its whole: two of the three words never move, and
    // writing them anyway is what keeps a half-written record from being a
    // shape this file can produce.
    armRunner () {
        // Which slot of the ring this frame is, and the stamp on it, are the
        // rulebook's. What is composed here is the RECORD over that slot, which
        // is per-target and cannot be shared: a native record holds addresses
        // and this one holds table indices.
        return this.composeRunner (this.core.armRunner (this.host));
    }

    // And `construct`'s own, on a slot outside the ring. One writer for both,
    // because a record composed in two places is two places a half-written one
    // can come from.
    armConstruct () {
        return this.composeRunner (this.core.armConstruct (this.host));
    }

    composeRunner (slot) {
        const at = this.runnerRing + slot * LAYOUT.runner.stride;

        const compose = this.view ();

        // The slot, tagged so that it is never 0 and never a loader's - a null
        // `context` is not a stale one and is answered by doing nothing, so the
        // two have to be tellable apart before anything is asked about them.
        compose.setUint32 (at + LAYOUT.runner.context, (RUNNER + slot) >>> 0,
            true);
        compose.setUint32 (at + LAYOUT.runner.spawn, this.slots.spawn, true);
        compose.setUint32 (at + LAYOUT.runner.done, this.slots.done, true);
        compose.setUint32 (at + LAYOUT.runner.bytes, this.slots.bytes, true);
        compose.setUint32 (at + LAYOUT.runner.release, this.slots.release,
            true);

        return at;
    }

    // And retired the moment the call returns, which is `context->live = false`
    // natively and one stamp here. The record's bytes are left where they are
    // on purpose: a game that kept the address gets a well formed record naming
    // a call that has gone, which is a refusal rather than a wild read.
    retireRunner () { this.core.retireRunner (this.host); }

    retireConstruct () { this.core.retireConstruct (this.host); }

    // The step has returned and the frame is over. Its own method because it is
    // the one thing `advance` does that a harness driving a session by hand -
    // `products/web-player/tests/arena.js` - has to do too, and a counter it
    // incremented itself would be a second one.
    countFrame () { this.core.advance (this.host); }

    // The descriptor, read through the pointer the spawn handed over and copied
    // out of it in one go, because the header says the host copies it during
    // the call and retains neither pointer. Plain data, so that it survives the
    // structured clone into a worker unchanged.
    readTask (at) {
        const view = this.view ();
        const layout = LAYOUT.task;
        const namePtr = view.getUint32 (at + layout.name, true);

        return {
            name: namePtr ? this.string (namePtr) : "",
            body: view.getUint32 (at + layout.body, true),
            inputSize: view.getUint32 (at + layout.inputSize, true),
            scratchSize: view.getUint32 (at + layout.scratchSize, true),
            outputSize: view.getUint32 (at + layout.outputSize, true),
        };
    }

    // A block of the arena for one answer's bytes, reused across answers of the
    // same size class. The view is made after the allocation rather than before
    // it, because that allocation is exactly what may have detached the last
    // one.
    //
    // A RECYCLED block is cleared past `size`, and that is a divergence closed
    // rather than tidiness: natively a block is a fresh `mmap` every time and
    // the kernel zero fills it, so a page handing back the last answer's tail
    // would let two hosts differ about bytes a game is not supposed to read but
    // can. A freshly allocated block needs no clearing, because the bump
    // pointer only ever moves forward and linear memory begins zero.
    takeOutput (bytes, size) {
        const span = sizeClass (size || 1);
        const free = this.spare.get (span);
        const recycled = !! (free && free.length);
        const at = recycled ? free.pop () : this.alloc (span);

        const block = new Uint8Array (this.memory.buffer, at, span);

        if (recycled) { block.fill (0, size); }
        if (size) { block.set (bytes); }

        return { at, span };
    }

    releaseOutput (at, span) {
        const free = this.spare.get (span);

        if (free) { free.push (at); }
        else { this.spare.set (span, [at]); }
    }

    // The arena, reconciled against the table the rulebook left behind.
    //
    // `Host_Core_Blocks` is how a host gives a task's bytes back and this one
    // cannot fill one in - `HostCore.release` says why - so what is freed here
    // is every address this arena is holding that no row of the table names any
    // more. It decides NOTHING: which entries end, and when, is read off the
    // table rather than recomputed, so the rule stays in one place and this
    // stays bookkeeping. There is ONE moment now - a release marks the entry
    // and the frame boundary takes its slot and its bytes together - so
    // `retireFrame` is the one caller, where there used to be two. What it
    // finds is both kinds of address the table has stopped naming: a released
    // entry the sweep has just dropped, and the block behind an answer of
    // nothing, which `host_core_show` drops a frame earlier. `munmap` is what
    // the console does at exactly those moments.
    reclaimBlocks () {
        if (! this.blocks.size) { return; }

        const held = new Set ();

        for (const row of this.rows ()) {
            if (row.block) { held.add (row.block); }
        }

        for (const [at, span] of [...this.blocks]) {
            if (held.has (at)) { continue; }

            this.blocks.delete (at);
            this.releaseOutput (at, span);
        }
    }

    // Last frame's edges, retired before this frame's are published.
    //
    // A released block goes at the end of the frame its release happened on,
    // and nothing else does: an answered id is the game's until it releases it,
    // whether it answered with bytes or with nothing. The rule is
    // `host_core_retire` and what is left here is the arena and this host's own
    // half of an entry the rulebook has finished with.
    retireFrame () {
        this.core.retire (this.host);

        this.reclaimBlocks ();

        const live = new Set (this.rows ().map (row => row.id));

        for (const id of [...this.work.keys ()]) {
            if (live.has (id)) { continue; }

            this.work.delete (id);
        }
    }

    // What a body answered before this step, made visible to it.
    //
    // `done` flips here and nowhere else, which is the whole of what
    // `host_core_show` is for: a task answered between two steps is answered for
    // the whole of the second, so nothing a game asks inside one call can
    // disagree with itself. Nothing is held back and nothing is ordered - per-id
    // status has no order to pin, so the array's whole rule family is gone with
    // the array.
    //
    // WHAT IS LEFT HERE IS THE LOG. The blob copy went with the array;
    // what this walks is the rows that flipped, stamping the frame on the marks
    // and the reads because those are the page's account of a run rather than
    // anything a game is told.
    showAnswers () {
        const frame = this.frameIndex;

        // Read BEFORE the flip, because a row that has already flipped is
        // indistinguishable from one that flipped three frames ago: `done` is a
        // level, and what a mark records is the edge.
        const flipping = this.stagedTasks ();

        this.core.show (this.host);

        for (const row of flipping) {
            const id = row.id;

            // Read back off the table rather than off the row above, which is a
            // copy taken before the flip. A null block is the whole of what a
            // failure is, here as at every other reader of it.
            const block = this.core.bytes (this.host, id);

            const work = this.work.get (id)
                || { name: "", note: null, reads: [] };

            // The id, not a name, because that is what the replay format
            // carries: a task's descriptor names it for a human and nothing
            // resolves through that name. `products/mark` and `goldenhash.js`
            // both read it back this way.
            this.taskLog.push (
                { frame, id, kind: block ? "task" : "taskfail" });

            // Every read the body made, stamped with the frame its answer
            // became visible on rather than the instant it happened. A read is
            // off the frame by design, so the frame it can be attributed to is
            // the one the game could first see it on.
            for (const read of work.reads) {
                this.readLog.push ({
                    frame,
                    id,
                    name: read.name,
                    format: read.format,
                    size: read.size,
                    failed: read.failed || ! block,
                    reason: read.reason,
                });
            }

            // Where a host may say which of the six inabilities it was, and the
            // header fixes where: a line on the frame the answer becomes
            // visible on. Never a failed RUN - the run continues and exits 0 -
            // so this is the page's `warning:`, and `console.error` is the only
            // stream a page has for one.
            if (work.note) {
                console.error (`player: task ${id} (${work.name}) did not `
                    + `finish: ${work.note}. The id answers \`done\` with no `
                    + `bytes, so the game takes whatever it does without one.`);
            }
        }
    }

    // What the game is handed this frame, which is the queue's state with
    // everything it did not declare removed. Computed before anything is
    // written or recorded, so the struct and the replay are two spellings of
    // one answer - a replay that carried a press the game was never given would
    // reproduce a run that never happened.
    deliver (buttons, edges, pointer) {
        const padded = this.controls.buttons !== NEED.none;

        // Absent unless the game reads one, and absent is where `x` and `y`
        // stop meaning anything - so the position is dropped with the flag
        // rather than left to be ignored.
        const seen = pointer || { x: 0, y: 0, present: false, hovers: true };
        const present = this.controls.pointer !== NEED.none && seen.present;

        const delivered = {
            buttons: {},
            edges: {},
            pointer: present
                ? { x: seen.x, y: seen.y, present: true,
                    hovers: seen.hovers !== false }
                : { x: 0, y: 0, present: false, hovers: true },
        };

        for (const name of BUTTONS) {
            delivered.buttons [name] = padded && !! buttons [name];
            delivered.edges [name] = padded && !! edges [name];
        }

        // Written only while the pointer is on the screen, which is what makes
        // "a press implies a position" structural rather than a rule. It costs
        // nothing, because a press captures: from the press to the release the
        // pointer is present by construction, so there is no press here to
        // lose.
        for (const name of POINTER_BUTTONS) {
            delivered.buttons [name] = present && !! buttons [name];
            delivered.edges [name] = present && !! edges [name];
        }

        // The one place a device reaches a button that is not its own, and the
        // reason a game reading no pointer is still playable on a phone: a tap
        // stands in for a press of `a`. Decided from what the module declared
        // rather than from what hardware is attached - so it is the same on
        // every machine - and recorded below as an ordinary `a`, so a run
        // marked on a phone replays on a desktop with nothing in the file about
        // how the button was pressed.
        if (padded && this.controls.pointer === NEED.none) {
            delivered.buttons.a = delivered.buttons.a || !! buttons.primary;
            delivered.edges.a = delivered.edges.a || !! edges.primary;
        }

        return delivered;
    }

    // One frame, and what the game said about it.
    //
    // The return is the step's own `Game_Report`, which is the only value that
    // travels back out of a game and the only thing it says about itself that a
    // host may act on within a frame rather than at load. It cannot reach the
    // simulation on this frame or any later one, so what a host does with it -
    // including nothing, which is what `inspector` does - moves no pixel and no
    // sample.
    advance (buttons, edges, pointer) {
        // Before anything else this frame, and never again inside it: from here
        // to the next `advance` a task is either answered or not, which is what
        // makes the flip attributable to one frame number. Retire then show, in
        // that order and for `console_step`'s reason - last frame's blocks go
        // before this frame's answers appear, so a released block stayed
        // readable for the whole of the frame its release happened on.
        this.retireFrame ();
        this.showAnswers ();

        const delivered = this.deliver (buttons, edges, pointer);

        const input = new Uint8Array (this.memory.buffer, this.inputPtr, LAYOUT.inputBytes);

        // Cleared whole rather than member by member, so that everything the
        // game did not declare is zero because nothing wrote it, rather than
        // because a branch remembered to.
        input.fill (0);

        BUTTONS.forEach ((name, b) => {
            input [b * 2] = delivered.buttons [name] ? 1 : 0;
            input [b * 2 + 1] = delivered.edges [name] ? 1 : 0;
        });

        const at = LAYOUT.pointer;

        if (delivered.pointer.present) {
            input [at.x] = delivered.pointer.x;
            input [at.y] = delivered.pointer.y;
            input [at.present] = 1;
            input [at.hovers] = delivered.pointer.hovers ? 1 : 0;

            for (const name of POINTER_BUTTONS) {
                input [at [name]] = delivered.buttons [name] ? 1 : 0;
                input [at [name] + 1] = delivered.edges [name] ? 1 : 0;
            }
        }

        let bits = 0, edgeBits = 0;

        RECORDED_BUTTONS.forEach ((name, b) => {
            if (delivered.buttons [name]) bits |= 1 << b;
            if (delivered.edges [name]) edgeBits |= 1 << b;
        });

        if (bits !== this.lastButtons) {
            this.inputLog.push ({
                frame: this.frameIndex,
                buttons: RECORDED_BUTTONS.filter ((_, b) => (bits >> b) & 1),
            });
            this.lastButtons = bits;
        }

        // Only the edges the held log cannot express need recording: a press
        // that sets a held bit is already implied by the `input` line above,
        // and both readers derive it. What is left is a button pressed and
        // released inside one frame, which leaves the held state untouched and
        // would otherwise vanish from the recording entirely.
        const taps = RECORDED_BUTTONS.filter (
            (_, b) => ((edgeBits & ~bits) >> b) & 1);

        if (taps.length) {
            this.tapLog.push ({ frame: this.frameIndex, buttons: taps });
        }

        // A change record like `input`, and for the same reason: a position is
        // piecewise constant, so an entry means "here from this frame until the
        // next entry". Absence is a change like any other and is written as
        // `away`, because a pointer that left has to be reproducible - a
        // recording that simply stopped mentioning it would replay with it
        // still on screen.
        const moved = delivered.pointer, last = this.lastPointer;

        if (moved.present !== last.present
            || (moved.present && (moved.x !== last.x || moved.y !== last.y))) {
            this.pointerLog.push ({ frame: this.frameIndex, ...moved });
            this.lastPointer = { ...moved };
        }

        // `| 0` is doing two jobs, and the first is the one the header is
        // written around: it is what turns the `undefined` a module built
        // before `step` returned anything hands back into `game_report_none` -
        // see `REPORT` above, where that coercion is measured rather than
        // assumed. The second is that every reader tests bits, and a bitwise
        // operator on a value that is not a number reads every flag as clear,
        // which would be the same claim arrived at by accident.
        // The runner is armed for this frame alone and retired the moment the
        // step returns, which is `console_step`'s own order: a game that
        // stashed it and used it later is refused naming the frame it was armed
        // for. Null is the count-zero spelling for the array.
        //
        // Three arguments, and they are the header's three in the header's
        // order. Arity is silent in BOTH directions here - JavaScript drops
        // extras and passes `undefined` for what is missing - so a page still
        // handing a module the five this call used to take would give it
        // `runner` = the old results pointer, a plausible non-null value in the
        // wrong slot. What catches that in the build tree is the committed
        // golden compared against three independent implementations; what
        // catches it between a DEPLOYED page and a deployed module is the arity
        // check at load, which is the whole of what is left now that there is no
        // import whose rename could carry a meaning change.
        const runnerPtr = this.armRunner ();

        const report = this.step (this.statePtr, this.inputPtr, runnerPtr) | 0;

        this.retireRunner ();

        this.capture ();

        this.countFrame ();

        return report;
    }

    // The two descriptions, taken on the LIVE block at the one moment every
    // pointer in it resolves: after `construct` returns and after every `step`
    // returns, never inside a call and never inside a renderer. What this
    // writes is what crosses to wherever the picture is drawn and wherever the
    // sound is rendered.
    capture () {
        this.captureVideoFn (this.statePtr, this.videoStatePtr);

        if (this.captureAudioFn) {
            this.captureAudioFn (this.statePtr, this.audioStatePtr);
        }
    }

    // Whether this module has a sound to render at all, which is what decides
    // whether a tick owes the speaker bytes or silence. A read of the RENDERER
    // rather than of a declared size: the two agree by the refusal at load, and
    // this is the one of them that says what the far side would do with them.
    get sounds () { return this.renderAudioFn !== null; }

    // AND NO DRAWING PATH HERE, which is
    // `docs/archived/render-worker-plan.md`'s third question answered: the
    // instance that steps never renders a picture.
    //
    // This class used to hold one beside `Consumer.renderVideo` and it was
    // deliberately not the same code - a consumer renders out of a layout it was
    // HANDED where a session owns the arena and reaches its own pointers. There
    // is one of them left, and it is the consumer's, because one path is what
    // lets this tree say what a frame is and a fallback nothing exercises is a
    // fallback that rots. What the session still owes a renderer is `layout`
    // below and the two description holes it publishes there.

    // ----------------------------------------------------------------------
    // What this session PUBLISHES, for a `Consumer` that renders somewhere
    // else.
    //
    // Three things and no more: the addresses a consumer has to know, the
    // bytes at an address, and the blocks a delivery has put there. Nothing
    // here decides where a consumer is or how the bytes reach it - the worker
    // posts them across a thread and `goldenhash.js --mirror` writes them
    // straight into a second instance in the same process, and both spend
    // exactly these three.
    // ----------------------------------------------------------------------

    // Every address a consumer has to be told, because it lays no arena of its
    // own down. `heapBase` is the assertion rather than an instruction: a
    // consumer built from another module would agree about nothing else here.
    //
    // THE STATE BLOCK IS NOT AMONG THEM AND NEITHER IS THE SAVE BLOB. A
    // consumer renders a picture or a sound out of a description, and `save` is
    // rendered by the instance that steps and by nothing else - so an address
    // for either would be a hole published for a reader that does not exist.
    // `stateSize` stays, as the figure rather than the region: two instances of
    // one module declare one state size, so it is what refuses a consumer built
    // from another build below.
    layout () {
        return {
            heapBase: this.heapBase,
            game: this.gamePtr,
            stateSize: this.stateSize,
            video: this.videoPtr,
            samples: this.samplesPtr,

            // And where the two descriptions land, which is what a consumer
            // renders out of: a hole this arena chose and published, not one of
            // its own.
            videoState: this.videoStatePtr,
            videoStateSize: this.videoStateSize,
            audioState: this.audioStatePtr,
            audioStateSize: this.audioStateSize,

            // And the eight bytes a reader record occupies. A consumer composes
            // its OWN record there, over its own table's index for `read` -
            // this is the address rather than the record, exactly as `game`
            // above is the address of a descriptor each instance writes for
            // itself.
            reader: this.readerPtr,
        };
    }

    // A copy of a span of this memory, with a buffer of its own so that a host
    // may transfer it to another thread rather than copy it a second time.
    bytesAt (at, span) {
        return new Uint8Array (this.memory.buffer, at, span).slice ();
    }

    // The two descriptions, which are what a consumer is handed every tick.
    // Null for the sound of a silent game, which has none and is posted none.
    videoStateBytes () {
        return this.bytesAt (this.videoStatePtr, this.videoStateSize);
    }

    audioStateBytes () {
        return this.audioStateSize
            ? this.bytesAt (this.audioStatePtr, this.audioStateSize) : null;
    }

    // The regions laid down once and never written again: the argument storage
    // and the save blob `construct` was handed. Both are the host's for the
    // whole run by `interface/game.h:34-44`, so a game may hold a pointer into
    // either and a consumer needs both before the first state can be rendered.
    residentRegions () {
        const regions = [];

        if (this.argsRegion) {
            regions.push ({ address: this.argsRegion.address,
                bytes: this.bytesAt (this.argsRegion.address,
                    this.argsRegion.span) });
        }

        if (this.saveSize) {
            regions.push ({ address: this.savedPtr,
                bytes: this.bytesAt (this.savedPtr, this.saveSize) });
        }

        return regions;
    }
}

// The task blocks a consumer has not been handed, and the record of what it
// has, brought up to date.
//
// BY ID RATHER THAN BY ADDRESS, and that is the whole of the care this needs.
// The arena recycles a block the moment the frame boundary settles its release
// (`reclaimBlocks` above), so one address carries one task's answer and then
// another's; a record kept by address would take the second for the first and
// leave a consumer rendering bytes that are two tasks old. An id is minted once
// per run and names one block for its whole life, so an address arriving under
// a new id is a delivery and an address arriving under the same one is not.
//
// `held` is the caller's own Map from id to address, mutated here: one consumer
// holds one of them, which is what makes release per consumer and local -
// nothing here asks what any other consumer has, and the session waits on none
// of them.
function freshDeliveries (session, held) {
    const fresh = [];
    const live = new Set ();

    for (const row of session.rows ()) {
        if (! row.block) { continue; }

        live.add (row.id);

        if (held.get (row.id) === row.block) { continue; }

        const span = session.blocks.get (row.block);

        // A row naming a block this arena is not holding is not a delivery this
        // host can serve, and there is no such row: `blocks` is written where
        // the bytes are taken and cleared where the table stops naming them.
        // Skipped rather than refused, because a consumer rendering last
        // frame's picture is recoverable and a refused page is not.
        if (! span) { continue; }

        held.set (row.id, row.block);

        // THE ID TRAVELS WITH THE BYTES, which is what a description needs and
        // an address is not: a capture names a task by id, and the consumer
        // resolving one has no table to look it up in. Nothing else about the
        // record changed - a caller that only writes the bytes at their address
        // reads the same two fields it always did.
        fresh.push ({ id: row.id, address: row.block, span,
            bytes: session.bytesAt (row.block, span) });
    }

    for (const id of [...held.keys ()]) {
        if (live.has (id)) { continue; }

        held.delete (id);
    }

    return fresh;
}

// ---------------------------------------------------------------------------
// Consumer: a second instance of the game's own module, handed bytes and asked
// to render them.
//
// PUBLISH BY MIRRORING, NOT BY SHARING. A state block holds absolute addresses
// - into its own tail, into a task block, into the argument storage and into
// the save blob, which is `interface/game.h:34-44`'s list - so a copy of it is
// complete only where every one of those addresses still means what it meant.
// A copy at another address in the same memory does not: eleven of the twelve
// games in this tree keep pointers in their state, measured in
// `docs/archived/threaded-host-plan.md`, and a copy beside the live block
// points back at the live block. A copy at the SAME address in ANOTHER memory
// resolves every one of them, and that is all this class is.
//
// It never calls `construct` and never calls `step`. What it holds is bytes it
// was given plus whatever the module's own data segments put there, and what it
// runs on them is the game's own `render_video`, `render_audio` and `save` -
// so a game cannot tell that a renderer ran here rather than in the instance
// that stepped, and could only tell by reading a mutable byte outside the state
// block, which `cmake/CheckStatics.cmake` already refuses.
//
// IT TAKES NO IMPORTS AND HOLDS NO HOST, and it installs a trampoline only
// where a description can name a task. A renderer calls no host function of its
// own accord - the runner and the loader are `step`'s and a body's - but a
// capture carries an ID where a state block carried a pointer, so a renderer
// handed a description has one question left and `Game_Task_Reader` is it.
// Measured in `docs/runs/threaded-host-run.md` (a) over all forty-four
// recordings and (c) inside an `AudioWorkletGlobalScope`; what has changed
// since is the one wasm function this instance now needs in its own table, and
// a `Consumer` built without a trampoline still renders - it answers every id
// with nothing, which is what a game that names none never notices.
//
// IT LAYS NO ARENA DOWN. Every address it uses arrives in the `layout` its
// session published, so there is no second copy of the prologue here that could
// drift from the one in `Session` above. What it does for itself is grow its
// memory to cover an address it is handed, which is the one thing a bump
// allocator's absence still leaves it owing.
// ---------------------------------------------------------------------------

class Consumer {
    // `module` is the game's own compiled module - the same one the simulation
    // instantiated, or another compilation of the same bytes.
    //
    // `layout` is what `Session.layout` answered, or NULL for an instance built
    // only to read the module's declaration. A host has one question it must
    // answer before a session exists and cannot answer without a module - what
    // this game is called and how many bytes it persists, which is what a save
    // store is keyed and sized by - and a bare instance is the honest way to
    // ask it: `factory` writes host memory, this instance is discarded, and no
    // second reader of `LAYOUT` is invented for it. Such a consumer renders
    // nothing, because it has nowhere to render from or to.
    constructor (module, layout, trampoline) {
        this.instance = new WebAssembly.Instance (module, {});

        const ex = this.instance.exports;

        this.ex = ex;
        this.memory = ex.memory;
        this.table = ex.__indirect_function_table;
        this.layout = layout;

        const heapBase = ex.__heap_base.value ?? ex.__heap_base;

        this.heapBase = heapBase;

        // The one assumption this whole design rests on, asserted rather than
        // assumed on every session: the module lays its own data out
        // identically in every instance, so everything the host put above
        // `__heap_base` can be put at the same address again. A consumer built
        // from a different module is the failure this catches, and it would
        // otherwise show as a picture that is wrong rather than as a page that
        // says why.
        if (layout && heapBase !== layout.heapBase) {
            refuse (`this consumer's module begins its heap at ${heapBase} `
                + `and the simulation's begins at ${layout.heapBase}, so the `
                + `two are not the same module and no address the simulation `
                + `publishes means anything here.`);
        }

        // The descriptor, read off THIS instance rather than taken from the
        // simulation's, because the function pointers on it are indices into
        // this instance's own table. `factory` writes host memory at an address
        // the simulation also spent on host memory, so nothing a state can
        // reference is touched; a declaration-only instance puts it at the foot
        // of its own arena, where this instance will never put anything else.
        const gamePtr = layout ? layout.game : heapBase;

        this.room (gamePtr, LAYOUT.game.bytes);

        new Uint8Array (this.memory.buffer, gamePtr, LAYOUT.game.bytes)
            .fill (0);

        ex.factory (gamePtr);

        const view = new DataView (this.memory.buffer);
        const g = LAYOUT.game;

        const held = (offset) => {
            const pointer = view.getUint32 (gamePtr + offset, true);

            return pointer ? this.table.get (pointer) : null;
        };

        this.stateSize = view.getUint32 (gamePtr + g.size, true);
        this.namePtr = view.getUint32 (gamePtr + g.name, true);
        this.version = [0, 4, 8].map (
            o => view.getUint32 (gamePtr + g.version + o, true));
        this.palettePtr = view.getUint32 (gamePtr + g.palette, true);

        // The renderers and nothing else: `save` is not among them, because it
        // is rendered by the instance that steps and this one is never handed a
        // state block to render it from.
        this.renderVideoFn = held (g.renderVideo);
        this.renderAudioFn = held (g.renderAudio);

        this.controls = {
            buttons: view.getInt32 (
                gamePtr + g.controls + LAYOUT.controls.buttons, true),
            pointer: view.getInt32 (
                gamePtr + g.controls + LAYOUT.controls.pointer, true),
        };

        this.background =
            view.getUint8 (gamePtr + g.background) & (PALETTE_SIZE - 1);

        this.taskMax = view.getUint32 (gamePtr + g.taskMax, true);
        this.saveSize = view.getUint32 (gamePtr + g.saveSize, true);

        // What each renderer expects to be handed, read for the reason
        // `saveSize` is: a declaration about the module, and the same in every
        // instance of it. The picture's is never zero, which the SIMULATION's
        // own load refused before this instance was built, and the sound's is
        // zero exactly for a silent game - this one reads the figures to size
        // the holes it is told to mirror into.
        this.videoStateSize = view.getUint32 (gamePtr + g.videoStateSize, true);
        this.audioStateSize = view.getUint32 (gamePtr + g.audioStateSize, true);

        // The task blocks this instance holds, by the id that names them - the
        // consumer's own half of what a session keeps in the rulebook's table.
        // An id rather than an address for `freshDeliveries`'s own reason: the
        // arena recycles a block the moment a release settles, so one address
        // carries one task's answer and then another's.
        this.blocks = new Map ();

        // Whether a description has arrived yet, one question per renderer, and
        // the answer every renderer here waits on: the hole is zeros until the
        // first mirror, and a game rendered out of zeros where its own capture
        // would have written is a game drawing a state no run ever held.
        //
        // The same question about a STATE BLOCK is gone with the block: nothing
        // posts one to a consumer, so there is no `stated` to wait on and no
        // `save` to render off it.
        //
        // Two rather than one because a tick may carry either - the speaker is
        // posted the sound and the picture goes elsewhere - so the two are
        // answered apart.
        this.videoStated = false;
        this.audioStated = false;

        if (! layout) { return; }

        // The one wasm function this instance needs of its own, and the record
        // that names it. A description carries an ID where a state block
        // carried a pointer, so a renderer here has to be able to ask - and a
        // closure is not a wasm function, exactly as it is not one in the
        // simulation's instance.
        //
        // The RECORD's address is the session's, published in the layout beside
        // the framebuffer's, because this instance lays no arena down. What
        // goes in it is this instance's own table index, which is why the
        // record is composed here rather than mirrored across.
        this.readerPtr = NO_READER;
        this.readerArmed = false;

        if (trampoline && layout.reader) {
            this.slots = installTrampoline (trampoline, this.instance,
                this.services ());

            this.room (layout.reader, LAYOUT.reader.stride);

            const compose = new DataView (this.memory.buffer);

            compose.setUint32 (layout.reader + LAYOUT.reader.context, READER,
                true);
            compose.setUint32 (layout.reader + LAYOUT.reader.bytes,
                this.slots.read, true);

            this.readerPtr = layout.reader;
        }

        // The second half of the same assertion, and the one a reader of a
        // failing page can act on: two instances of one module declare one
        // state size, so a disagreement here is a consumer holding a module
        // from another build.
        if (this.stateSize !== layout.stateSize) {
            refuse (`this consumer's factory declares ${this.stateSize} bytes `
                + `of state and the simulation's declares ${layout.stateSize}, `
                + `so the two are not the same module.`);
        }

        // Room for everything the simulation laid down that this instance
        // renders into or out of, taken in one go so that the growth cannot
        // land between a view being built and being read. `render_video` writes
        // the framebuffer and `render_audio` the samples, so both have to exist
        // here even though nothing is ever mirrored into them.
        //
        // The state block and the save blob are not on the list and no longer
        // reach this instance at all; the resident regions accepted after this
        // sit above both, so nothing here has shrunk the memory a renderer is
        // handed.
        this.room (layout.samples, SAMPLES_PER_FRAME * 2);
        this.room (layout.video, FRAME_WIDTH * FRAME_HEIGHT);

        // And the two description holes, at the addresses the simulation chose
        // for them. The picture always, because a module describing none did
        // not load; the sound for every module that has one.
        this.room (layout.videoState, layout.videoStateSize);

        if (layout.audioStateSize) {
            this.room (layout.audioState, layout.audioStateSize);
        }
    }

    // The one service a consumer answers, which is the whole of what a RENDERER
    // may ask a host for.
    //
    // It answers out of `blocks` rather than out of a rulebook, and that is the
    // difference between this and a session's `read`: a consumer holds copies
    // of the blocks it was handed, at the addresses they were handed at, and
    // the id it was handed them under is the whole of its table. What it cannot
    // do is tell an id nobody ever spawned from one whose block it never
    // received, so both arrive here as the same sentence.
    services () {
        const put = (size, span) => {
            if (! size) { return; }

            new DataView (this.memory.buffer).setUint32 (size, span >>> 0,
                true);
        };

        // The five a body's instance is given, inert here for the reason they
        // are inert there: the six wrappers land at fixed table indices in
        // every instance of one module, so an instance that installed one and
        // one that installed six would disagree about what a number in a record
        // means.
        return {
            spawn: () => 0,
            done: () => 0,
            bytes: () => 0,
            release: () => {},
            load: () => 0,

            read: (context, id, size) => {
                put (size, 0);

                if (! context) { return 0; }

                if (context !== READER || ! this.readerArmed) {
                    refuse (`${this.name} named a task's bytes through a `
                        + `reader from outside the renderer it was handed to. `
                        + `A reader is valid for one call and no longer.`);
                }

                const block = this.blocks.get (id);

                if (! block) {
                    refuse (`${this.name} was handed a description naming task `
                        + `id ${id}, whose block this consumer does not hold. `
                        + `A description names only an id the game held on the `
                        + `frame it was captured on.`);
                }

                put (size, block.span);

                return block.address;
            },
        };
    }

    // Enough linear memory for `span` bytes at `at`, which is the whole of what
    // this class does for itself. `memory.grow` detaches every view over the
    // buffer - `docs/decisions.md:523` - so every view below is built after the
    // last growth rather than kept.
    room (at, span) {
        const need = at + span;
        const have = this.memory.buffer.byteLength;

        if (need <= have) { return; }

        this.memory.grow (Math.ceil ((need - have) / 65536));
    }

    // One region of the simulation's memory, written at its own address. The
    // state block every tick; the argument storage, the save blob and each task
    // block once each.
    accept (address, bytes) {
        if (! bytes || ! bytes.length) { return; }

        this.room (address, bytes.length);

        new Uint8Array (this.memory.buffer, address, bytes.length).set (bytes);
    }

    // A task's output, at its own address AND under its own id. The bytes go
    // where `accept` would put them; what this adds is the row a description
    // naming that id is answered out of.
    acceptTask (id, address, bytes) {
        if (! bytes || ! bytes.length) { return; }

        this.accept (address, bytes);

        this.blocks.set (id, { address, span: bytes.length });
    }

    // And what the simulation still holds, which is what this instance may go
    // on answering for.
    //
    // THE RETENTION RULE, from the consumer's side. A release is marked and
    // settles at the next frame boundary, so a row released on frame N is still
    // in the table when this is called on frame N and is gone when it is called
    // on frame N + 1 - which is one capture of grace and exactly what
    // `interface/game.h` promises a description: the block is held until a
    // description captured after the release has been rendered.
    //
    // `held` is `freshDeliveries`'s own map, mutated by it and read here, so
    // the two ends of the same tick agree about the same set without either
    // asking the other.
    retainTasks (held) {
        for (const id of [...this.blocks.keys ()]) {
            if (held.has (id)) { continue; }

            this.blocks.delete (id);
        }
    }

    // One tick's worth of what this instance renders from: the two descriptions
    // the simulation captured after the step being shown.
    acceptDescriptions ({ videoState, audioState }) {
        if (videoState) {
            this.accept (this.layout.videoState, videoState);

            this.videoStated = true;
        }

        if (audioState) {
            this.accept (this.layout.audioState, audioState);

            this.audioStated = true;
        }
    }

    // Whether there is anything to render from yet, per channel.
    get videoReady () { return this.videoStated; }

    get audioReady () { return this.audioStated; }

    string (at) {
        const bytes = new Uint8Array (this.memory.buffer);
        let s = "";
        for (let i = at; bytes [i]; i++) s += String.fromCharCode (bytes [i]);
        return s;
    }

    get name () { return this.string (this.namePtr); }

    get palette () {
        return new Uint8Array (this.memory.buffer, this.palettePtr,
            PALETTE_SIZE * 3);
    }

    get frame () {
        return new Uint8Array (this.memory.buffer, this.layout.video,
            FRAME_WIDTH * FRAME_HEIGHT);
    }

    // The game's own renderer, on the bytes it was handed. `false` for a
    // consumer that has been given no state yet, so a caller that paints on the
    // answer paints nothing rather than the zeros a fresh instance begins with.
    renderVideo () {
        if (! this.layout || ! this.videoReady) { return false; }

        this.readerArmed = true;

        this.renderVideoFn (this.layout.videoState, this.readerPtr,
            this.layout.video);

        this.readerArmed = false;

        return true;
    }

    // One frame of sound, out of the same bytes. Silence for a game that
    // declares no `render_audio` and for a consumer with no state, which is the
    // frame of zeros a speaker needs either way.
    renderSamples () {
        if (! this.layout || ! this.audioReady || ! this.renderAudioFn) {
            return new Int16Array (SAMPLES_PER_FRAME);
        }

        this.readerArmed = true;

        this.renderAudioFn (this.layout.audioState, this.readerPtr,
            this.layout.samples);

        this.readerArmed = false;

        return new Int16Array (new Int16Array (this.memory.buffer,
            this.layout.samples, SAMPLES_PER_FRAME));
    }

    // AND NO `renderSave` HERE, which is the whole of what this class is not.
    //
    // A consumer draws or sounds, out of a description that is plain values;
    // `save` reads the state block, where every pointer a game kept resolves,
    // and it is therefore rendered by the instance that steps and by no other.
    // `Session.renderSave` above is that instance's, and the worker calls it on
    // the frames the game asks with `game_report_save` - so the one save a
    // message could not make in time is made before it is needed rather than
    // out of a mirror. `interface/game.h`'s `Game` block is where the rule is
    // stated; there is no second half of it here any more.
}

// ---------------------------------------------------------------------------
// Where a resource directory is: the one question about resources this half of
// the player still answers.
//
// `<name>.<format>` in ONE directory, read by a task body when it wants the
// bytes. The same file `inspector` reads, byte for byte, rather than a twin of
// it in some encoding the page understands and the CLI does not - so both hosts
// read one layout and one file, and a sprite edited on disk is a sprite both
// have read.
//
// WHICH directory is decided once, here, and the answer is handed to the
// session, which posts it to the worker a body runs in. By default it is
// `resources/` beside the MODULE and not beside the page: there is one page and
// many games, so resolved against the page every read of every game would look
// in the player's own directory, find nothing, and fail the task - a game
// drawing its fallback for ever with nothing on screen to say why. That failure
// is silent by construction, which is why `web_player_plays_example` exists.
//
// The directory is passed in rather than read from the page, because this is
// the seam that check exists to hold: the page resolves its query string
// against itself and hands the result over, and a host with no page at all
// composes the same directory the same way.
// ---------------------------------------------------------------------------

// Which directory a game's resources are in, resolved once so that a value this
// page cannot make sense of is a refusal naming it rather than a 404 per load.
//
// `player.html?module=<url>&resources=<directory>`. Absent - which is every URL
// the menu writes, and the whole of what this page did before - the answer is
// `resources/` beside the module, and nothing else here runs. Present, it is
// the directory named, and one module then plays against content that was never
// built beside it: many sets of bytes, no rebuild, and no directory per variant
// holding its own copy of the module.
//
// A DIRECTORY rather than a template or a base with a hole in it, and the same
// directory `inspector --resources D` names - the one holding
// `<name>.<format>`, not a parent with a `resources/` inside it. That is what
// lets one string move between the two hosts, so a run recorded here is
// reproducible there; the CLI has had the flag since before this page did, so
// the parity cost nothing.
//
// Resolved against the PAGE and not against the module, which is the one
// decision here that could have gone the other way. Against the module it would
// share a base with the default, and the literal `resources` would spell that
// default exactly - but `?module=games/pong/pong.wasm&resources=boards/set07`
// would then mean `games/pong/boards/set07`, so two parameters written side by
// side in one query string would resolve against two different bases. Against
// the page they resolve against the one URL they are a query of. It is also
// what keeps the deployable portable: `location.href` already carries whatever
// prefix a host mounted the site at, so a relative value works from a root and
// from a subdirectory of one, exactly as every other URL in the site does.
//
// Five refusals, and the last four are each a URL this page would otherwise
// fetch:
//
// - The parameter written with nothing after it. Naming no directory is not
//   the same as leaving the parameter off, so it is not answered as though it
//   were: the caller meant to say something and said nothing.
// - Another origin. A cross-origin resource directory is a different feature -
//   it has a CORS story and a trust story - and this is not it.
// - A path separator that arrived percent-encoded. See below; without it the
//   next rule is decorative.
// - Above the site. `player.html` sits at the root of the deployable, so the
//   directory the page is in IS the site, and a value climbing out of it is
//   refused by name rather than fetched from somewhere else on the host.
// - A query or a fragment. A filename is composed onto this directory, which
//   drops both silently, so a caller who wrote one would be served out of a
//   directory they did not name.
//
// What is NOT refused is a directory inside the site holding nothing. That is a
// 404 per load, `failed` to the game, and the fallback it already draws - and
// no host can tell it apart from a set of bytes nobody has built yet.

// `moduleUrl` rather than `module`, which is the one name in this file that
// cannot be reused: the node door at the foot of it reads a CommonJS `module`
// out of the enclosing scope, and a parameter wearing that name would shadow it
// for anything written here later.
//
// Both bases are whatever `new URL` takes for one - the page hands over its own
// `location.href` as the string it is, and a host without a page hands over the
// URL object it already built. `named` is the query parameter exactly as it was
// read: null when it is absent, a string when it is there, and the empty string
// when it was written with nothing after it, which is the one of the three that
// is refused.
//
// Returns a URL ending in a slash, always, so its one caller composes a
// filename onto it and nothing else.

function resourceBase (moduleUrl, page, named) {
    if (named === null || named === undefined) {
        return new URL ("resources/", moduleUrl);
    }

    // The directory this page is served out of, which is the site: one trailing
    // slash, so the prefix test below cannot match half a name.
    const site = new URL (".", page);

    // Stripped the way the URL parser strips, which is every code point up to
    // and including a space and not just the ones `trim` knows. Done here
    // rather than left to the parser so that a value of nothing but whitespace
    // is the SAME refusal as a value of nothing: `?resources=%20` otherwise
    // parses to the page itself, and the page's own URL with a slash on the end
    // is a directory nobody named.
    const wanted = named.replace (/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");

    if (! wanted) {
        refuse (`resources= names no directory. Leave it off for resources/ `
            + `beside the module, or name a directory under ${site.href}.`);
    }

    let base;

    try {
        base = new URL (wanted, page);
    } catch {
        refuse (`resources=${named} is not a URL this page can resolve `
            + `against ${page}.`);
    }

    // The origin, spelled as the two fields it is made of rather than compared
    // through `origin`. A `data:` or `blob:` URL has an opaque origin, which
    // serialises to the string "null" and compares EQUAL to another opaque one
    // - so a page that ever had one would admit every such value. The protocol
    // and the host are what a fetch actually goes to, and `host` carries the
    // port.
    if (base.protocol !== site.protocol || base.host !== site.host) {
        refuse (`resources=${named} resolves to ${base.href}, which is not on `
            + `${site.protocol}//${site.host}. A resource directory is served `
            + `beside this page; another origin is a different feature.`);
    }

    if (base.search || base.hash) {
        refuse (`resources=${named} resolves to ${base.href}, which carries a `
            + `query or a fragment. This names a directory and a filename is `
            + `composed onto it, which would drop both without saying so.`);
    }

    // A separator that arrived percent-encoded, which is the one way a value
    // can pass the test below and still leave the site. The URL parser decodes
    // `%2e` to a dot, so `%2e%2e/x` really is `../x` here and is refused - but
    // it leaves `%2f` alone, so `..%2fx` stays ONE segment and the prefix test
    // sees a directory under the site. A server then decodes the path before it
    // resolves it, which puts the separator back and folds the `..` away:
    // measured against this tree's own `products/server`, with the site mounted
    // at `/artifacts/`, where `..%2fsource/card.html.in` answered 200. Its own
    // guard bounds the directory it was told to serve, not the site inside it,
    // and those differ in exactly the subdirectory arrangement this parameter
    // has to support. No directory name has an encoded separator in it, so this
    // costs nothing and the rule below stops being decorative.
    if (/%2f|%5c/i.test (base.pathname)) {
        refuse (`resources=${named} resolves to ${base.href}, which spells a `
            + `path separator as a percent escape. A server decodes that back `
            + `into a separator, so what it names is not the directory this `
            + `page can see.`);
    }

    // The one normalisation, and it is what makes the CLI's spelling work here.
    // `new URL ("block.bin", ".../set07")` drops the last segment and answers
    // `.../block.bin`, so a directory written without a trailing slash - which
    // is how `--resources` is written, and how anyone names a directory - would
    // silently mean its parent.
    if (! base.pathname.endsWith ("/")) { base.pathname += "/"; }

    if (! base.pathname.startsWith (site.pathname)) {
        refuse (`resources=${named} resolves to ${base.href}, which is above `
            + `${site.href}. This page is at the root of the site it is served `
            + `from, and that is as far out as a resource directory goes.`);
    }

    return base;
}

// ---------------------------------------------------------------------------
// The run this page is about to play, composed into the address that shows it.
//
// Two things enter a run that nobody types - entropy and the calendar - and
// both enter here, by one rule and at one moment: a key the query already
// carries is used verbatim, and a key it does not carry is composed and merged
// into the query. So a bare link is a fresh game, and the moment it loads it
// stops being bare - what a reader copies out of the address bar is the run
// they were looking at rather than an instruction to roll another one.
//
// ABSENCE IS THE SPELLING FOR A FRESH SEED, and it replaced a sentinel.
// `random` was one value of this key that was not a number, so it was the one
// thing a run could say that no other grammar would carry - legal here and
// refused under `inspector`, with nothing able to compare the two runs because
// a run that will not start records nothing. Absence says the same thing for no
// rule at all, and it is what a menu card can be written as: a card that named
// a seed would hand every reader one constant run for ever.
//
// MERGED RATHER THAN REPLACED, which is measured rather than reasoned. The
// probe behind `replaceState` - Chrome 152, over `http` from a subdirectory,
// path preserved, no reload and no history entry - also measured a whole-query
// replacement DROPPING the keys already there. What goes back is the segments
// this page was handed, in the order it was handed them, with the composed ones
// appended.
//
// Spliced out of the raw segments rather than composed through a
// `URLSearchParams`, whose serializer re-encodes what it never had to:
// `module=games/pong/pong.wasm` comes back as
// `module=games%2Fpong%2Fpong.wasm`, and a link that changed shape while the
// reader was looking at it is not one they recognise as the one they opened.
//
// EVERYTHING NONDETERMINISTIC IS A PARAMETER - the roll, the clock, and the
// browser's own `History` - so this file still reaches for no global at all and
// a caller that hands over none composes nothing and publishes nothing. A page
// hands over all three; a harness hands over stubs and can count the calls.
//
// It runs FIRST, before a byte of the module is fetched, because it is the only
// reader that can change the address. `queryArguments` below then reads the run
// out of the query this answers, so a page cannot play one run while displaying
// another, and a recording written later carries what was rolled by
// construction rather than by a rule somebody has to remember.
// ---------------------------------------------------------------------------

// `search` is a query string as `location.search` hands one over - a leading
// `?`, or nothing at all where there is no query. `roll` answers a fraction in
// [0, 1) the way `Math.random` does, `now` is a moment the way `new Date ()`
// is, and `history` is the browser's own, whose `replaceState` rewrites the
// address with no navigation and no history entry.
//
// Answers the query the run is read out of, which is the query the address bar
// carries once this returns.

function composeRun (search, roll, now, history) {
    const segments = `${search}`.replace (/^\?/, "").split ("&")
        .filter (segment => segment !== "");

    // A key written with nothing after it NAMES it, and `queryArguments` below
    // refuses it there. Composed over here it would be a value invented for a
    // URL a reader got wrong, answered before they were told they wrote it
    // badly - so a bare `seed` rolls nothing and a bare `day` composes nothing.
    const wears = (key) => segments.some (segment =>
        segment === key || segment.startsWith (`${key}=`));

    const composed = [];

    // Scaled to what the parameter it becomes can hold, and it is the one
    // number this page invents. A run wanting to reproduce it copies the
    // address, which is what the write below is for.
    if (roll && ! wears (SEED_KEY)) {
        composed.push (`${SEED_KEY}=${(roll () * 0xffffffff) >>> 0}`);
    }

    // The page's own `day`, composed on the same terms one key along - see
    // `dayNumber` below for what the number is and why it is this page's
    // convention rather than anybody's contract. `?day=20700` still wins, which
    // is what keeps it usable as the streak-testing hook.
    if (now && ! wears (DAY_KEY)) {
        composed.push (`${DAY_KEY}=${dayNumber (now)}`);
    }

    // Nothing composed is nothing to publish, and the query goes back exactly
    // as it arrived rather than as this function would have spelled it: an
    // address a reader already wrote the whole run into is one they can pass on
    // unchanged.
    if (! composed.length) { return `${search}`; }

    const query = `?${segments.concat (composed).join ("&")}`;

    if (history) { history.replaceState (null, "", query); }

    return query;
}

// ---------------------------------------------------------------------------
// What the run was told: the query string, read as the list of pairs the game
// is handed.
//
// This is the URL half and it knows nothing about any game - and after the
// arguments rework there is nothing about a game for it to know. There is no
// declaration to match a key against, so EVERY key that is not one of this
// host's own becomes a pair and reaches `construct`: a key this game has never
// heard of is a key for a harness, for a menu or for the next version of it,
// and the run starts regardless. What is left to check is FORMAT, which
// `argumentList` below owns and this function ends by spending.
//
// Split by hand rather than through `URLSearchParams`, for the reason
// `composeRun` splits by hand: that class is a serializer as well as a parser
// and re-encodes what it never had to, and here it is worse than cosmetic - it
// hands out a MULTIMAP with `get` answering the first of two, which is exactly
// the silent preference between two things a reader wrote that this refuses.
// Its DECODING is what a browser does and is reproduced: `+` is a space and
// `%NN` is a byte, both applied to the key and to the value.
//
// The two keys this page keeps are dropped here and never reach a game:
// `module` says which game this is and `resources` says which bytes it plays
// against, and neither is an argument any more than a filename typed at a shell
// is. TWO and not three: a pair named `save` is passed through like any other,
// because reserving it would say the address bar can address the store and
// saves are deliberately not link-composable.
//
// `seed` GOES IN WITH THE PAIRS AND COMES BACK OUT THROUGH THE RULEBOOK, which
// is what this function gained when the key stopped being held back here.
// `host_core_extract_seed` finds it, holds it to its own grammar and takes it
// out of the list - so a run spells it the way it spells everything else, the
// number reaches `construct` as that call's own parameter, and the array a game
// walks cannot carry it whatever the query said. Absence is REPORTED rather
// than filled: what to construct with when a query names none is the caller's
// policy, and this page's is `composeRun` above, which wrote a number into the
// query before this ever ran.
// ---------------------------------------------------------------------------

// Answers `{ seed, args }` - the number the query named, or `null` where it
// named none, and the pairs that are left, held to their format and sorted.

function queryArguments (search, core) {
    const segments = `${search}`.replace (/^\?/, "").split ("&")
        .filter (segment => segment !== "");

    // Decoded the way a browser decodes, and a value that is not decodable is
    // refused naming the segment rather than delivered as the escape a reader
    // typed. `decodeURIComponent` throws a `URIError` on a lone `%`, which is
    // the one failure here that is neither a duplicate nor a bare key.
    const decode = (text, segment) => {
        try { return decodeURIComponent (text.replace (/\+/g, " ")); }
        catch {
            refuse (`\`${segment}\` is not a query parameter this page can `
                + `decode: a \`%\` in a URL introduces two hexadecimal digits, `
                + `and a value carrying one that does not is a value no host `
                + `can agree with another about.`);
        }
    };

    const supplied = [];

    for (const segment of segments) {
        const cut = segment.indexOf ("=");

        // No `=` at all, refused rather than read as presence: bare presence
        // and an explicit empty value would otherwise be two spellings of one
        // thing, and an empty value is LEGAL and is not absence - which is what
        // makes them two different facts a game gets to tell apart.
        if (cut < 0) {
            refuse (`\`${decode (segment, segment)}\` is written with nothing `
                + `after it. Every argument carries a value, and a value may `
                + `be empty - which is written `
                + `\`${decode (segment, segment)}=\` and is not the same as `
                + `leaving the key off.`);
        }

        const name = decode (segment.slice (0, cut), segment);
        const value = decode (segment.slice (cut + 1), segment);

        const already = supplied.find (entry => entry.name === name);

        // Twice is a question rather than an answer, whatever the two values
        // are and whether or not the key is one this page owns. Naming both is
        // the whole of the report: a refusal saying only the key leaves a
        // reader looking for a second spelling they may have written in the
        // menu rather than in the address bar.
        //
        // Asked here, over the WHOLE query, rather than left to
        // `argumentList`: `?module=a&module=b` is two sources for one value
        // exactly as `?level=3&level=4` is, and this is the last point at which
        // a reserved key is still in the list to be counted.
        if (already) {
            refuse (`\`${name}\` is supplied twice, as \`${already.value}\` and `
                + `as \`${value}\`, and a name is supplied at most once. Two `
                + `sources for one value is a question rather than an answer, `
                + `so neither is preferred.`);
        }

        supplied.push ({ name, value });
    }

    const carried = supplied.filter (entry =>
        ! PAGE_KEYS.includes (entry.name));

    // The seed, out of the list before there is a list to hand over. It runs
    // BEFORE the settling `argumentList` spends, which is the order every host
    // runs the two in: the roof is counted over what is left, so a query naming
    // this host's fill of pairs AND a seed is a run rather than one pair too
    // many.
    const found = core.extractSeed (carried);

    if (! found.taken) {
        const wrote = carried [found.at] || { value: "" };

        // Unreachable through this reader and answered anyway. The duplicate
        // check above runs over the WHOLE query, this page's own keys included,
        // so `?seed=1&seed=2` is refused there naming both values. The rulebook
        // can still reach this verdict for a caller with no such rule, and a
        // verdict nobody answers is a wrong sentence waiting for the day the
        // order changes.
        if (found.verdict === CORE.argument.repeated) {
            const already = carried [found.earlier] || { value: "" };

            refuse (`\`${SEED_KEY}\` is supplied twice, as `
                + `\`${already.value}\` and as \`${wrote.value}\`, and a `
                + `name is supplied at most once. Two sources for one value is `
                + `a question rather than an answer, so neither is preferred.`);
        }

        refuse (`\`${SEED_KEY}=${wrote.value}\` is not a seed. A seed is an `
            + `unsigned decimal number a \`uint32_t\` holds and nothing else, `
            + `and an empty value is not one of them - so no word rolls one. A `
            + `run that wants a fresh seed NAMES NONE: this page rolls one and `
            + `writes what it rolled into the address, so the link you copy `
            + `reproduces what you played.`);
    }

    return {
        seed: found.named ? found.seed : null,
        args: argumentList (found.pairs, core),
    };
}

// ---------------------------------------------------------------------------
// The day: the one thing this page tells a game that nobody typed.
//
// Streaks need wall-clock time, the blob cannot carry it - a blob is last run's
// data - and time is nondeterministic, so it enters exactly the way a rolled
// seed does and beside it: composed by `composeRun` above where the query names
// none, merged into the address so the run can be quoted, delivered as an
// ordinary pair, and written into the recording, so a replay reproduces the day
// it was played on rather than the day it is read on.
//
// LOCAL rather than UTC, because a streak is "I played yesterday" by the
// player's own clock and no calendar rolls over at somebody else's midnight. An
// INTEGER rather than a date, because a game has no libc: a count of days is
// two numbers to subtract where a date string would be a calendar to parse.
//
// IT IS A PAGE CONVENTION AND NOT CONTRACT, and every part of that is
// deliberate. Nothing on a module declares it, no host is held to it,
// `inspector` composes none and passes `--arg day=N` by hand where a test wants
// one, and a game that never heard of the key walks past it exactly as it walks
// past any other. What lets a game read it with no absence branch is the same
// sentence that makes a fresh blob zeros: a stored `last_day` of 0 against a
// real count near 20,000 is no streak, by the arithmetic that was going to run
// anyway.
// ---------------------------------------------------------------------------

const DAY_KEY = "day";

const DAY_MS = 86400000;

// Whole days between 1970-01-01 and `now`, in the LOCAL calendar.
//
// The local year, month and day are read off the clock and then read back as
// UTC, and that is what makes this a count of CALENDAR days rather than of
// elapsed milliseconds: `Date.UTC` of a local midnight is an exact multiple of
// a day, so the division is exact and no zone offset, leap second or
// daylight-saving hour can leave the answer half a day out. Two moments on one
// local day are one number, and midnight is where it changes.
function dayNumber (now) {
    return Date.UTC (now.getFullYear (), now.getMonth (), now.getDate ())
        / DAY_MS;
}

// The run's pairs, held to the FORMAT every host holds them to and to nothing
// else, and answered in the order they are DELIVERED in.
//
// **A host validates format and never meaning**, which is the whole of the
// contract this spends. What a value means, whether it is a number at all, and
// what to do with one that makes no sense are the game's business entirely - so
// there is no kind here, no range, and no key this page has an opinion about.
// A twelve-level game handed `level=99` starts at 11, which is a smaller
// failure than refusing to start.
//
// The rules that survive are not a host wanting an opinion: they are what a
// RECORDING and a SESSION need in order to do their jobs. A replay writes one
// `arg` line per pair and reads it back, so a name that cannot be told from a
// value and a value that cannot be written on one line are both runs that
// cannot be reproduced; and a session stores the pairs for the life of the run,
// so a value it cannot hold is refused rather than truncated into something the
// run never said.
//
// It runs on what a URL said and on what a caller composed alike, which is why
// it is a function beside `queryArguments` rather than the tail of it: `Session`
// spends it again on the list it is handed, because a harness that built its own
// pairs is a run like any other and a pair reaching `construct` unchecked would
// be one host's run and no other's.
//
// The SORT is the last thing it does and is a determinism rule rather than a
// taste. `interface/game.h` guarantees the delivered array is sorted bytewise by
// name: a game that reads by name cannot tell and does not care, but two hosts
// free to choose an order would hand one recording two arrays, and one that
// applied its pairs in order would reach two states. It costs nothing, because
// bytewise by name is the order a recording already writes its `arg` lines in.

function argumentList (args, core) {
    // EVERY ONE OF THE RULES IS IN `products/host-core` NOW - the charset, the
    // two lengths, the reserved key, the duplicate, the count and the sort -
    // and what is left here is the seven sentences. `core.settleArguments`
    // checks in the order the caller wrote and lays the list down bytewise by
    // name, and answers with a verdict, the index in the CALLER's list of the
    // pair that was refused, the index of an earlier pair carrying the same
    // name, and the length or count that was too large.
    //
    // The ORDER the rules are asked in is the core's rather than this file's,
    // and that is a real change to which refusal a doubly-bad pair earns: a
    // repeated name is now caught before its value is looked at, where this
    // file used to check the value first. It is the same set of rules and the
    // same set of sentences, decided in the order both hosts decide them.
    const settled = core.settleArguments (args);

    if (settled.taken) { return settled.pairs; }

    // What the caller typed, at the index the refusal named - so a message
    // quotes the pair as it was written rather than as it sorted.
    const wrote = (index) => {
        const entry = args [index] || { name: "", value: "" };

        return { name: `${entry.name}`, value: `${entry.value}` };
    };

    const { name, value } = wrote (settled.at);

    if (settled.verdict === CORE.argument.crowded) {
        refuse (`this run carries ${args.length} arguments, and this host `
            + `carries at most ${core.figure (CORE.figure.argumentMax)}. `
            + `It is a bound on what a CALLER may `
            + `say rather than on anything a game wants: one address, one `
            + `command line and one recording have to be one run, so a `
            + `capacity each host picked for itself would make this legal `
            + `here and refused under inspector.`);
    }

    if (settled.verdict === CORE.argument.unnamed) {
        refuse (`\`${name}\` is not an argument name, which is [a-z0-9_]+ `
            + `with at least one character. A recording writes one `
            + `\`arg <name> <value>\` line per pair and splits it on the `
            + `first run of whitespace, so a name outside that charset is a `
            + `pair no host could write down and read back.`);
    }

    if (settled.verdict === CORE.argument.longName) {
        refuse (`\`${name}\` is ${name.length + 1} bytes with its `
            + `terminator, and this host holds a name of `
            + `${core.figure (CORE.figure.argumentNameMax)}. `
            + `It is mirrored rather than agreed so that the slot a `
            + `session keeps a name in and the slot a recording writes it `
            + `under cannot be two different sizes.`);
    }

    // ONE VERDICT, TWO SENTENCES, which is the one place a host composing its
    // own words needs to know more than the rulebook told it. A value is
    // printable ASCII `0x20` to `0x7E` with no outer space, and this page has
    // always said two different things about the two ways of breaking that, so
    // `PRINTABLE` picks which. It refuses nothing: the pair is already refused.
    if (settled.verdict === CORE.argument.unvalued) {
        if (! PRINTABLE.test (value)) {
            refuse (`\`${name}=${value}\` is not a value this console carries. `
                + `A value is printable ASCII, 0x20 to 0x7E, with no newline: a `
                + `recording is one line per argument, so a value that cannot `
                + `be written on one is a run that cannot be reproduced.`);
        }

        refuse (`\`${name}=${value}\` begins or ends with a space. A `
            + `recording separates a name from its value by whitespace and `
            + `reads the rest verbatim, so an outer space is a byte no `
            + `reader could tell from the separator. Interior spaces are `
            + `fine.`);
    }

    if (settled.verdict === CORE.argument.longValue) {
        refuse (`\`${name}\` carries ${value.length} bytes, and a host `
            + `holds ${core.figure (CORE.figure.argumentTextMax)} `
            + `with the terminator. A run's values live `
            + `in the session's own fixed size storage, so a value past `
            + `that is refused rather than truncated into something the run `
            + `never said.`);
    }

    // Two sources for one value, refused rather than resolved by a last-wins
    // rule: the collision a caller actually makes is a sugar option beside the
    // key it is sugar for, and quietly serving one of the two is how a run ends
    // up reproducing something nobody asked for. Both spellings are named,
    // which is why the core answers with the earlier index as well.
    const already = wrote (settled.earlier);

    refuse (`\`${name}\` is supplied twice, as \`${already.value}\` and `
        + `as \`${value}\`. A name is supplied at most once, whatever `
        + `it was written in.`);
}

// ---------------------------------------------------------------------------
// Input, queued rather than applied where it arrives, because the page's loop
// can run several steps in one animation frame. Folding a key straight into
// `buttons` gives every one of those steps the same final state: a press late
// in the window is back-dated onto steps that simulate time before it happened,
// and a tap that began and ended inside the window cancels itself out and is
// never seen at all.
//
// So each event carries the instant it arrived, and a step consumes only those
// at or before its own boundary. `event.timeStamp` shares a clock with the
// timestamp `requestAnimationFrame` is passed - measured - but that timestamp
// is the frame's nominal start and can predate an event already in hand, so the
// boundary is a clock the caller advances in fixed steps, never one re-derived
// from the animation frame.
//
// Input is still sampled once per step, but a press that arrives and departs
// between two boundaries is no longer lost: draining records it in `edges`,
// which the step reports as `Game_Button_State.edge` with `held` clear.
//
// The pointer goes through the same queue, and has to: a move is as much an
// instant as a press, and a position folded straight in would be back-dated
// onto every step in the window exactly as a key would. What it does not have
// is an edge, because a position is where something is rather than something
// that happened - what it borrows instead is the latch, for the reason
// `interface/game.h` gives at `Game_Pointer`.
// ---------------------------------------------------------------------------

class Input {
    constructor () {
        this.buttons = {};
        this.edges = {};

        for (const button of RECORDED_BUTTONS) {
            this.buttons [button] = false;
            this.edges [button] = false;
        }

        // Where the pointer is, as of the last event applied. A level like
        // `held` rather than an event: a browser reports a pointer only when it
        // moves, so between two reports it is still exactly where it was.
        this.live = { x: 0, y: 0, present: false };

        // What the frame reports, which is `live` except that presence is the
        // union over the interval and the position is the last one held while
        // present, or the one below when a press was made. A pointer that
        // arrived and left between two boundaries would otherwise report a
        // press with nowhere to put it.
        this.pointer = { x: 0, y: 0, present: false };
        this.latched = null;

        // Where the first press of the interval landed, which outranks both of
        // those when it is set. `applyUpTo` says why the position a button went
        // down at is not the position the interval ended at.
        this.pressedAt = null;

        // The console has one pointer, so the first to press owns it until it
        // releases and every other is ignored outright. A second finger would
        // otherwise teleport the position - and because that is recorded, it
        // would replay as what looks like a defect in the game.
        this.owner = null;

        this.pending = [];

        // What to tell the host when something has been queued. A host that
        // steps every frame needs nothing here and gets the default; one that
        // can STOP stepping has to be told, because the queue is drained by a
        // boundary and a boundary is a step.
        //
        // This is what ends `game_report_idle` for input, as `Session.onStaged`
        // is what ends it for a result, and it is deliberately on the QUEUE
        // rather than on the listeners: a host that woke from a list of event
        // names would have to be edited every time this console learned about
        // one more, and the failure of forgetting is a player pressing a key
        // that never arrives.
        this.onQueued = () => {};
    }

    // The one writer of the queue, so a host waiting to be woken is told once
    // per event however that event reached here.
    accept (event) {
        this.pending.push (event);

        this.onQueued ();

        return true;
    }

    // Whether anything is still waiting for a boundary to reach it.
    //
    // Read at one place: a host does not act on `game_report_idle` while this
    // is true. The flag says no further change is coming until input arrives,
    // and input that has ALREADY arrived and is queued behind the boundary the
    // step stood at is the one case where that is true of the game and wrong
    // about what happens next - the step never saw the event. A host that
    // stopped there would strand the press in this queue with nothing left
    // running to drain it.
    waiting () { return this.pending.length !== 0; }

    // Whether the key was one of the console's six, so the caller knows whether
    // to take the event away from the browser. A key this console does not have
    // belongs to the page.
    queue (time, code, down) {
        const button = KEYS [code];

        if (! button) { return false; }

        return this.accept ({ time, button, down });
    }

    // Where the pointer is, in console pixels: the caller has already mapped
    // them with `pointerPixel`, because a bounding rectangle is the browser's
    // and a column and a row are not.
    queuePointer (time, id, x, y, present, hovers) {
        if (this.owner !== null && id !== this.owner) { return false; }

        // A caller that says nothing is a hovering pointer, which is what the
        // header calls the answer for a host that cannot tell.
        return this.accept (
            { time, pointer: { x, y, present, hovers: hovers !== false } });
    }

    // Its buttons. Ownership is decided here rather than at the boundary
    // because it is a filter on what arrives, the way `KEYS` is: an event from
    // a pointer this console is not following never becomes input at all.
    queuePointerButton (time, id, button, down) {
        if (! button) { return false; }

        if (down) {
            if (this.owner !== null && id !== this.owner) { return false; }

            this.owner = id;
        } else {
            if (this.owner !== null && id !== this.owner) { return false; }

            this.owner = null;
        }

        return this.accept ({ time, button, down });
    }

    applyUpTo (boundary) {
        while (this.pending.length && this.pending [0].time <= boundary) {
            const event = this.pending.shift ();

            if (event.pointer) {
                this.live = event.pointer;

                if (this.live.present) { this.latched = { ...this.live }; }

                continue;
            }

            this.buttons [event.button] = event.down;

            // Latched rather than assigned, so a press and its release inside
            // one step still leave the edge standing when `held` has gone back
            // down.
            if (event.down) { this.edges [event.button] = true; }

            // And where it was pressed, which is not where the interval ends. A
            // hand drifts during a click - a pixel 16 ms later is ordinary hand
            // movement, not a second intention - and to a game that maps a
            // position to a cell that pixel is the next cell along, so the mark
            // lands beside the square that was aimed at, intermittently and
            // only near an edge. That is the worst shape a defect can have: the
            // player sees it, the recording reproduces it, and nothing in the
            // game is wrong.
            //
            // The FIRST press wins, because one interval reports one position
            // and the earliest press is the one nothing has yet had a chance to
            // drift away from. The drift is kept rather than dropped: it is
            // what the NEXT interval reports, which has decided nothing yet.
            //
            // Pointer buttons only. A key going down says nothing about where
            // the pointer is, and pinning the position for a frame because the
            // player pressed a direction would be this rule reaching a gesture
            // it was never written about.
            //
            // And only while the pointer is present, which is why this reads
            // `live` rather than pinning unconditionally: `Session.advance`
            // writes no pointer button at all for an absent pointer, so a press
            // pinned to a position that is not there would delete itself.

            if (event.down && this.pressedAt === null
                && this.live.present
                && POINTER_BUTTONS.includes (event.button))
            {
                this.pressedAt = { ...this.live };
            }
        }

        this.pointer = this.pressedAt || this.latched || { ...this.live };
    }

    // The pointer leaves, now rather than at a queued instant.
    //
    // The queue is for what the browser reported, and this is not that: it is
    // the page deciding the pointer is gone because the player has stopped
    // playing - a pause, or the page going behind something. Neither arrives as
    // a `pointerleave`, so presence would otherwise stay exactly as it was at
    // the moment the player stopped looking, and the game would keep drawing a
    // cursor for a pointer that is no longer aimed at it.
    //
    // The buttons go down with it, for the reason `pointercancel` releases
    // them: a press whose end this page will never see is a press held for the
    // rest of the run.
    //
    // Call it on a drained queue - `applyUpTo` first - because anything still
    // pending is applied on top of this and would put the pointer straight
    // back.
    releasePointer () {
        for (const button of POINTER_BUTTONS) { this.buttons [button] = false; }

        this.owner = null;
        this.live = { x: 0, y: 0, present: false };
        this.latched = null;

        // The press position goes with the presence latch and for the same
        // reason: this method is the pointer leaving, and a press it made on
        // the way out is a statement about an interval that has been thrown
        // away. Left standing, the next `applyUpTo` would recompute `pointer`
        // from it and put the pointer straight back where it pressed.
        this.pressedAt = null;

        this.pointer = { x: 0, y: 0, present: false };
    }

    // Every button goes down, whatever the browser last said about it.
    //
    // A release this page will never be told about is a button held for the
    // rest of the run, and there are two ways to acquire one. The window loses
    // focus and the `keyup` is delivered to whatever took it; or the page goes
    // behind something and stops being sent events at all. Neither arrives
    // here as an event, so neither can be waited for - which is the same
    // sentence `releasePointer` above is written around, one input away.
    //
    // Presence is deliberately untouched. Losing focus does not move the
    // mouse, so a window clicked out of still has a pointer over the canvas
    // and saying otherwise would be inventing a `pointerleave` nothing
    // reported. What it does not have is a press whose end will be seen.
    //
    // The pointer's ownership goes with the buttons: a press that ended
    // somewhere this page cannot see has ended, so the next pointer to press
    // may have the console.
    releaseButtons () {
        for (const button of RECORDED_BUTTONS) { this.buttons [button] = false; }

        this.owner = null;
    }

    // Everything the interval reported, which the frame that ran has now
    // consumed. The presence latch and the press position go with the edges
    // rather than after them: all three are statements about a window between
    // two boundaries, and all three would be a lie repeated if they survived
    // into the next one - a press position most of all, since carrying it would
    // hold the pointer at the click for as long as the button stayed down.
    clearEdges () {
        for (const button of RECORDED_BUTTONS) { this.edges [button] = false; }

        this.latched = null;
        this.pressedAt = null;
    }
}

// ---------------------------------------------------------------------------
// Why the loop is not stepping, which is three independent things.
//
// `paused` is the PLAYER's. `Enter` sets it, it is sticky, and nothing but
// `Enter` clears it: a run that unpaused itself because a tab came back would
// be overturning a decision the player had already made. It was Escape until
// the page grew a fullscreen mode, which the browser also spends Escape on and
// does not let the page keep.
//
// `hidden` is the HOST's. It follows page visibility in both directions and the
// player never sees it happen, because by definition they were not looking. A
// game left running and audible behind the menu it was navigated away from was
// the reported bug; a game that then demanded a keypress before playing again
// was the same bug pointing the other way, and conflating the two is what made
// the second the only available fix for the first.
//
// `idle` is the GAME's, and it is the third reason the pair above was written
// to expect: "any host that grows one gets a flag rather than a rewrite" is
// that sentence, spent. `game_report_idle` says no further state change is
// coming until input arrives or a task result does, and `step` is a pure
// function of state, input and results - so the claim propagates itself for as
// long as both hold still, and a host may simply stop calling it. The wake list
// SHRANK with the events array: residency now changes only by a delivery or by
// the game's own release, and a release is something a `step` did.
//
// It differs from the other two in the direction that matters, and the
// difference is who is expected to notice. `paused` is undone by the player and
// `hidden` by the page; `idle` has to undo ITSELF, because from the player's
// side nothing ever happened - the game did not stop, it ran out of things to
// do, and pressing a key is the whole of getting it back. So everything that
// can move a game clears this flag: every event the input queue accepts, every
// task result that lands, and every move of the two flags above. The loop sets it
// again one step later if the game says so again, and one step of a game that
// was about to be stepped anyway is the whole price of being wrong in that
// direction. Being wrong in the other direction is a game that never comes
// back, which is why nothing here waits to be sure.
//
// The truth table is three booleans now rather than two, and it is still here
// rather than in the page for the reason it always was: this half of the player
// runs under node, and a state machine spelled in event handlers is one no
// check without a browser could ever read.
// ---------------------------------------------------------------------------

// Whether the loop should be stepping at all.
function halted (halt) { return halt.paused || halt.hidden || halt.idle; }

// What a change to those three flags asks of the page.
//
// `shed` is what the page throws away, in the three spellings it has, and they
// are the whole reason this is a function rather than a pile of conditions at
// the call site. `stepped` is the pointer leaving as one real frame, because a
// paused game goes on drawing the crosshair its own state holds and the player
// is looking straight at it. `quiet` is the same departure with no frame spent
// on it, because there is nothing on screen to look at: the first step after
// the page comes back reports whatever is true then. `backlog` is the other
// direction - everything queued while the player was not playing belongs to no
// frame, because no frame ran, so it is applied and its edges dropped before
// the loop starts again. A game resting is not one of the three: nothing was
// taken from the player, so nothing is owed back.
//
// `run` is the loop alone. It used to be the sound as well, and that is exactly
// what the third flag parts: the loop stops the instant a game rests, and the
// sound does not.
//
// `sound` is why. `stop` is the sound ending now, because the player paused or
// looked away and under the worklet's model emitting nothing means SUSTAIN, so
// a game stopped mid-note would drone on. `rest` is a game that has merely gone
// quiet by itself, where suspending on the instant would cycle the audio
// hardware once per move for the whole of a game that thinks between moves - so
// the page waits it out, and how long is the page's business rather than this
// function's. `start` is either of those undone.
function haltChange (before, after) {
    // The page itself having stopped being played, which is the player's flag
    // and the host's but never the game's: both mean somebody stopped
    // listening this instant, where a game with nothing to do is still being
    // watched.
    const silenced = (halt) => halt.paused || halt.hidden;

    // A game resting with the page still in front of the player, which is the
    // one halt the sound leaves slowly.
    const resting = (halt) => halted (halt) && ! silenced (halt);

    const shed = after.paused && ! before.paused ? "stepped"
        : after.hidden && ! before.hidden ? "quiet"
        : silenced (before) && ! silenced (after) ? "backlog"
        : null;

    const run = halted (after) === halted (before)
        ? null
        : halted (after) ? "stop" : "start";

    const sound = silenced (after) ? (silenced (before) ? null : "stop")
        : resting (after) ? (resting (before) ? null : "rest")
        : halted (before) ? "start" : null;

    return { shed, run, sound };
}

// ---------------------------------------------------------------------------
// What a wall clock instant owes a game: the accumulator, the boundary the
// input queue is drained to, the cap on a catch-up and the decision that a run
// may stop.
//
// All of it used to live inside the page's animation-frame callback, and all of
// it is on this side of the line the two files are split along - a timestamp
// arrives from the browser and pixels and samples leave for it, but between
// those two the arithmetic is a fixed-timestep loop that has never needed a
// browser to be right or wrong. Being unreachable without one is what left it
// checked by nothing: the page's scheduling is executed by no case in the suite,
// so the clamp, the cap and the drop were three rules stated only in comments.
// `web_player_steps_on_the_accumulators_clock` is what reads them now.
//
// A CLOCK rather than a loop, because the loop is the caller's: something arms
// an animation frame, hands what it is given to `advance` below, and does what
// the answer says. What this owns is the BOUNDARY - the instant the next step
// stands at - and `Input` above says why that is the whole job: the queue is
// drained by a boundary and a boundary is a step, so a clock that advances
// boundaries is a clock that steps the game.
//
// The session is reached through a function rather than held, which is
// `watchStore`'s move for `watchStore`'s reason: a reset builds a new session
// under a page that goes on running, and a clock closed over the retired one
// would step a game nobody is playing and render samples out of a linear memory
// nothing is listening to. What deliberately does NOT come back new across that
// swap is the accumulator - a reset is not a stall, and nothing was owed to it.
// ---------------------------------------------------------------------------

// WHOSE ANIMATION FRAME DRIVES THIS, which used to be a constant with two
// values and is now a fact about where the game is stepped.
//
// The page used to post every animation-frame timestamp to the worker, take the
// state back and paint it on its NEXT callback - postback, which cost a whole
// display frame because the answer arrived after the callback that asked had
// returned. Beside it stood a phase-locked shape: a timer in the worker, aimed
// a few milliseconds before where the next vsync was estimated to fall. It was
// never shipped, because the estimate is a model and a model that aimed low
// missed the callback by a whole frame - `docs/runs/threaded-host-run.md` (e)
// measured press to next vsync at p50 23.5 ms on the single-threaded loop, 39.9
// posting the timestamps, and 27.8 phase-locked with a p90 of 48.5 against
// postback's 47.6.
//
// The worker asks the display for its own frames now, so there is nothing left
// to estimate: a `requestAnimationFrame` callback inside the worker IS the
// vsync. `sim.worker.js` runs this clock on that timestamp and publishes what
// the tick produced, and the page's animation frame is left reading a heartbeat
// for the watchdog below. The picture is drawn a thread further out, on receipt
// rather than on a frame of its own, which is
// `docs/archived/render-worker-plan.md`'s one display frame of latency and the
// only clock in this player that is not the display's.
//
// `docs/runs/drawing-worker-run.md` is what measured that a worker may have one:
// a worker's animation frame ran at p50 16.7 ms over 301 samples in Chrome 152
// and p50 17 over 288 in Safari 26.6.2, both with zero intervals over a frame
// and a half, and both are the display's own cadence rather than a timer's. The
// same log records the two things that follow. The display is NOT the
// simulation's rate - it read 120 Hz in one reading and 60 Hz in another on one
// panel - so a frame callback owes whatever `advance` below says it owes and
// often nothing. And a hidden tab stops a worker's animation frame dead in
// Chrome while leaving its timer unthrottled, which is why the halt that stops
// the worker asking is load bearing rather than tidy.

class Clock {
    // `session` is a function answering with the session that is playing NOW,
    // for the reason above. `audio` is handed one step's `Game_Report` from
    // inside the burst rather than a list to walk afterwards, and it has to be:
    // a frame of samples is rendered out of the state the step it belongs to
    // left behind, and the next step overwrites that state.
    //
    // The rate is a parameter because it is the one number here that is not
    // this clock's own. It is `game_frame_rate` - the contract's, sized into
    // `Game_Audio_Block` and hashed into every golden - so a host that passed a
    // different one would be running a game the recording cannot reproduce.
    constructor (session, input, audio, rate = FRAME_RATE) {
        this.session = session;
        this.input = input;
        this.audio = audio;
        this.rate = rate;

        this.accumulator = 0;
        this.last = 0;

        // The wall clock instant this step's boundary stands at. It advances in
        // whole frames and is never reset to `now`, so it stays behind the wall
        // clock by at most the accumulator's remainder - the one exception is
        // the backlog drop below, which is where a machine that cannot keep up
        // gives up the lag rather than carrying it.
        this.simTime = 0;
    }

    // Forget the interval that has not been lived through, so the next
    // `advance` takes its own timestamp as the origin and owes nothing for the
    // gap before it. Two callers have a reason to, and the page holds both.
    prime () {
        this.last = 0;
        this.accumulator = 0;
    }

    // One animation frame's worth of simulation, and what the page owes the
    // screen and the halt table because of it.
    //
    // `stepped` is how many steps ran, `held` is whether every one of them
    // claimed `game_report_still`, `idle` is whether the run may now stop, and
    // `asked` is whether any one of them asked for its save with
    // `game_report_save`. Nothing here paints, nothing here saves and nothing
    // here halts: all three are the page's or the worker's, because all three
    // are the browser's.
    //
    // `asked` is an OR over the burst where `held` is an AND over it, and the
    // asymmetry is the two flags' own: a run of still frames is broken by one
    // step that moved a pixel, and a request is made by one step that moved a
    // byte. A tick that ran eight steps renders ONE blob for all of them, which
    // is what `save` being a pure function of the state block allows - the
    // bytes at the end of the burst are the bytes every request in it was about.
    advance (now) {
        const session = this.session ();

        // The first frame after a prime, which is a timestamp and no interval.
        if (! this.last) {
            this.last = now;
            this.simTime = now;

            return { stepped: 0, held: true, idle: false, asked: false };
        }

        let delta = (now - this.last) / 1000;
        this.last = now;

        if (delta > 0.25) delta = 0.25;         // never spiral after a tab switch
        this.accumulator += delta;

        // `held` is every step so far having reported `game_report_still`, which
        // is what the screen path can be skipped on: the canvas holds the last
        // frame painted, and a run of still frames is what connects it to the
        // state now. One step in the burst that moved a pixel breaks the run,
        // whatever the steps after it claim, because the frame finally drawn is
        // the last state rather than the last claim.

        let stepped = 0, held = true, asked = false, rested = false;

        while (this.accumulator >= 1 / this.rate && stepped < 8) {
            this.input.applyUpTo (this.simTime);

            const report = session.advance (this.input.buttons,
                this.input.edges, this.input.pointer);

            this.input.clearEdges ();

            held = held && (report & REPORT.still) !== 0;
            asked = asked || (report & REPORT.save) !== 0;

            // Every step renders its own frame of samples, so this belongs
            // inside the loop rather than after it: a catch-up of eight steps
            // owes the audio thread eight frames of sound, and taking only the
            // last would drop seven - the same mistake the input queue exists to
            // avoid. A frame reported silent owes it a frame of silence, which
            // is the one that costs no `render_audio` call and no buffer.
            this.audio (report);

            this.simTime += 1000 / this.rate;
            this.accumulator -= 1 / this.rate;
            stepped++;

            // The rest of this catch-up would be steps that change nothing, so
            // it is not run. `game_report_idle` is self propagating - `step` is
            // a pure function of state, input and what the runner answers - and
            // the input the remaining steps would advance their boundary onto is
            // exactly what `waiting` below refuses to sleep through.
            if (report & REPORT.idle) { rested = true; break; }
        }

        // The step cap was reached with work still owed, so this machine cannot
        // keep up. Drop the backlog rather than carry it: left to accumulate,
        // simulated time falls permanently behind the wall clock, and every
        // queued key then has to wait out that lag before a step will take it.
        // Dropping costs some skipped frames, which is what a machine this far
        // behind was going to show anyway.
        //
        // Not when the break above was a game resting: the owed time is forgiven
        // on the way back out of rest instead, and applying input up to now here
        // would latch an edge into a queue that is about to have nothing
        // draining it.

        if (! rested && this.accumulator >= 1 / this.rate) {
            this.accumulator = 0;
            this.simTime = now;
            this.input.applyUpTo (this.simTime);
        }

        // The game says nothing more is coming until something happens to it,
        // and nothing has.
        //
        // Two things can already have happened by the time this is read, and
        // both are the same shape: something arrived that the step which made
        // the claim could not have seen. An input event queued behind that
        // step's boundary is one - `waiting` is what asks. A task's answer,
        // staged on its own message between animation frames rather than on this
        // frame's work, is the other. Both are shown or drained by a step, so
        // sleeping through either would strand it with nothing running.
        const idle = rested && ! this.input.waiting ()
            && ! session.stagedTasks ().length;

        return { stepped, held, idle, asked };
    }
}

// ---------------------------------------------------------------------------
// The watchdog: a simulation that has stopped answering, named and stopped.
//
// `docs/decisions.md` pending item 10, and the cost it names was paid one
// milestone ago: "A watchdog for the web player. The mechanism is measured; the
// cost is moving the frame loop into a worker. It need not exfiltrate state - a
// hung page can report the frame and the input log it already records for Mark,
// and `inspector dump --replay ... --budget` reconstructs everything natively."
//
// A `step` that never returns used to wedge the page with nothing able to say
// so: the loop, the listeners, the canvas and the game were one thread, and the
// thread that would have to notice was the thread that was gone. The simulation
// is a worker now, so the page is awake while the game is not - and a worker is
// a thing the page can end.
//
// WHAT IT WATCHES is a HEARTBEAT read on the page's own clock. The worker asks
// the display for its own frames and posts one frame message per callback,
// whether or not that instant owed a step, and the page runs an animation frame
// of its own that posts nothing at all: it stamps each callback as the oldest
// instant nothing has been heard since, and a frame message clears it. So the
// question "is the simulation still there" is "has anything come back since the
// oldest frame I read", which needs no clock but the page's own animation frame
// and asks the worker for nothing it was not already going to say.
//
// IT WAS A ROUND TRIP, and the two shapes are the same arithmetic under
// different words: the page posted a timestamp per frame and the worker answered
// each one. What changed is only who owns the clock - a page that no longer
// steps the simulation has nothing to post, and a heartbeat the worker sends
// anyway is the same evidence for free.
//
// ARMED BY THE FIRST ANSWER, never before it. A worker that has not answered
// yet is a worker still compiling the module, laying down an arena and running
// `construct`, or - under node, where the shim fetches `player.js` over HTTP
// before the file even evaluates - not yet running at all. None of that is a
// hang and all of it is unbounded, so the budget below would be a guess about a
// network rather than a reading of a game. What that costs is stated rather
// than hidden: a `construct` that never returns is OUTSIDE this watchdog, and
// it is the only thing left that is.
//
// A `render_video` THAT NEVER RETURNS IS NOT THIS WATCHDOG'S ANY MORE, and
// that is the whole of what moving the picture onto a thread of its own did to
// this file. It was outside the watchdog while the page drew, for a structural
// reason rather than an omission - the thread that would have had to report the
// hang was the thread it wedged - and inside it for as long as the simulation
// drew. The renderer is a third thread now with a heartbeat of its own, so a
// picture that never comes back stops THAT heartbeat and this one goes on
// arriving. `RenderWatch` below is the rule that reads it, and the difference
// between the two is what each one means: a simulation that stops answering is
// the run ending, and a renderer that stops answering is a renderer replaced.
//
// DISARMED BY EVERY HALT, and that is a reading rather than a courtesy.
// `docs/runs/threaded-host-run.md` (b) measured a worker's timer in a
// BACKGROUND tab at p99.9 766 ms between ticks and a worst gap of 1,584 ms,
// against 25.6 ms at p99.9 with the tab in front. A watchdog left armed through
// `hidden` would report a hang every few seconds on a tab nobody is looking at,
// terminate the run and lose it. A halt tells the worker to stop asking the
// display for frames, so a halted run posts no heartbeat and owes no answer -
// and the page's own frame loop stops with it, which is what forgets the
// pending instant. `docs/runs/drawing-worker-run.md` (b) is the reading that
// makes the first half load bearing: Chrome stops a hidden tab's worker
// animation frame outright and Safari throttles it to about nine ticks a
// second, so a watchdog left armed would be reading the browser rather than the
// game.
// ---------------------------------------------------------------------------

// How long the page waits for an answer before it decides there will not be
// one. Fixed, and not adaptive: a watchdog whose budget follows the machine is a
// watchdog that grows one on the machine it is meant to report.
//
// WHAT IT TOLERATES. A frame is 16.667 ms and one animation frame owes at most
// eight steps, so an ordinary tick is one to eight steps, one picture and a
// message out. `docs/decisions.md` measures the whole of a game natively at
// under ~72 µs a frame - `step` ~2.2 µs, `render_audio` ~20, `render_video` 5 to
// 50 - so eight steps is well under a millisecond of arithmetic, and this budget
// is about fourteen thousand times the worst frame anybody here has measured.
// The picture is on this path too now, and deliberately inside the budget rather
// than beside it: `render_video`, the palette conversion and the `putImageData`
// all run on the thread that steps, so what this reports is a frame rather than
// half of one. It is also
// sixty display frames, and `docs/runs/threaded-host-run.md` (b) puts a visible
// worker's worst gap at 26.1 ms over 3,598 samples on a machine at a one-minute
// load of 24. A body spawning is not on this path either: six `new Worker` calls
// on the simulation's own thread are 22-23 µs each in a browser, measured in
// `docs/decisions.md`, and the body runs somewhere else.
//
// WHAT IT DOES NOT TOLERATE is a step that legitimately takes over a second, and
// nothing in this tree writes one. `games/drop-four` is the game that came
// closest and is the reason the sentence is worth writing down: it thinks with a
// minimax search, and it spends a bounded number of nodes per frame and carries
// its stack in the state block precisely so that the frame rate is safe on every
// machine. A game that wanted a second of arithmetic per step would have to be
// resumable in that same way, because a 60 Hz console cannot show it anyway.
//
// It is `inspector --budget`'s own number, deliberately: the report below names
// the command that reproduces the hang natively, and a page that reported a
// stall the native watchdog then declined to see would be two watchdogs
// disagreeing about one game.
const WATCHDOG_MS = 1000;

class Watchdog {
    constructor (budget = WATCHDOG_MS) {
        this.budget = budget;

        // Nothing is watched until something has come back. See above.
        this.armed = false;

        // The page's own timestamp on the oldest posted tick nothing has
        // answered, or null while the simulation is up to date.
        this.pending = null;

        // Frames the worker has reported completing. It is a COUNT, so it is
        // also the zero-based index of the frame it is running now, and one
        // less than the `frame` line a recording needs to reach it.
        //
        // ONE NUMBER RATHER THAN TWO, and that is what moving the picture off
        // this worker's thread simplified. A frame used to be a step and then a
        // picture, so a heartbeat missing could mean either and the count was
        // one short when it was the picture; the thread this watches only steps
        // now, so a heartbeat that stops is a `step` that never returned and
        // `stallLine` below has one frame to name.
        this.completed = 0;
    }

    // A frame message: the worker is alive, and this is where it has got to.
    answered (completed) {
        this.armed = true;
        this.pending = null;
        this.completed = completed;
    }

    // The page read its own animation frame and nothing had come back. Only the
    // oldest such instant is kept, so an answer that belongs to some other
    // message - the frame a pause costs is the one that exists - clears the wait
    // rather than confusing the count.
    posted (now) {
        if (this.armed && this.pending === null) { this.pending = now; }
    }

    // A pause, a hidden tab, a resting game, a reset: nothing is owed.
    disarm () { this.pending = null; }

    // Null while the simulation is answering, and what to report when it is not.
    overdue (now) {
        if (this.pending === null) { return null; }

        const waited = now - this.pending;

        if (waited < this.budget) { return null; }

        return { frame: this.completed, waited };
    }
}

// What the page says about it, in one sentence, because the page has one line
// to say it on and a person reading it has a `.replay` file in their downloads.
//
// Here rather than in the page for the reason the refusal text is: what a host
// SHOWS is the browser's and what it says is not. The command beside it is the
// whole of pending item 10's second half.
//
// `shot` RATHER THAN `dump`, and one frame rather than two. What this watchdog
// reports is a `step` that never returned, because the thread it watches is the
// thread that steps and nothing else - a `render_video` that never returns
// wedges the render worker, which is a different thread with a heartbeat of its
// own. So there is one number to name, and `inspector dump` would reproduce it:
// `shot` is named anyway because it steps to the frame AND renders, so the
// person who runs it gets the picture of the frame that stopped for free and
// gets told if the render is wedged too.
// `products/web-player/tests/watchdog.js` runs it.
function stallLine (stall, budget = WATCHDOG_MS) {
    return `the simulation stopped answering while it was running frame `
        + `${stall.frame}. Nothing came back for ${Math.round (stall.waited)} `
        + `ms, so its worker was terminated and the recording beside this was `
        + `written. \`inspector shot --replay <that file> --budget ${budget} `
        + `--out <a png>\` on the native plug-in reproduces it, at frame `
        + `${stall.frame}.`;
}

// ---------------------------------------------------------------------------
// The renderer's own watchdog: a picture that never came back.
//
// THE SAME ARITHMETIC AND A DIFFERENT VERDICT, which is the whole reason this
// is a class beside `Watchdog` rather than a second instance of it. A
// simulation that stops answering is the run ending and there is nothing else
// to do about it; a renderer that stops answering is a thread holding a canvas
// and an instance of a module, and the page can end it and build another while
// the game plays on. That is what `docs/archived/render-worker-plan.md` bought
// with a display frame of latency, and this is the half of it the page owns.
//
// IT COUNTS ONLY WHILE A PICTURE IS OWED, and that is the one rule `Watchdog`
// does not have. The simulation publishes on a tick that stepped and did not
// claim `game_report_still`, so a resting game, a game whose pixels have not
// moved and a halted page all publish nothing - and a renderer that has drawn
// nothing because nothing was posted to it is idle rather than wedged. So the
// question this asks is not "has anything come back" but "is the newest picture
// the simulation published still undrawn", which is two frame numbers and their
// difference. A renderer merely BEHIND is not wedged either: every draw clears
// the wait, so what has to happen for this to fire is a whole budget in which a
// published picture went undrawn and no heartbeat arrived at all.
//
// ARMED BY THE RENDERER SAYING IT IS OPEN, which is `render.worker.js`'s
// `ready` and the one place this differs from the watchdog above. That one arms
// on its first ANSWER, because a simulation answers every display frame whether
// or not it stepped; a renderer answers only when it has drawn, and the subject
// this exists to catch is a renderer that never draws once - so an arming rule
// that waited for a draw would be a rule that never fires on the only case that
// matters. `ready` is posted when the instance is compiled and the canvas is in
// hand, so everything before it - the worker's own fetch, its `importScripts`,
// the compile - is outside this exactly as a `construct` is outside the other.
//
// ONE REPLACEMENT PER SESSION, and `replaced` is where that is remembered
// rather than in the page, because it is a fact about the run and the page
// already throws this away on a reset. A renderer that hangs twice is a game
// that hangs, and an unbounded loop would hide it; the second stall ends the
// run through the same `seize` a simulation's does, saying
// `renderStallLine` instead.
// ---------------------------------------------------------------------------

class RenderWatch {
    constructor (budget = WATCHDOG_MS) {
        this.budget = budget;

        // Nothing is watched until the renderer has said it is open. See above.
        this.armed = false;

        // The page's own timestamp on the oldest instant at which a published
        // picture was undrawn, or null while the renderer is up to date.
        this.pending = null;

        // The newest frame the simulation published a picture for, and the
        // newest frame the renderer said it drew. Both are the frame COUNT the
        // simulation stamped the description with, so they are comparable, and
        // the second can only trail the first.
        this.shown = 0;
        this.drawn = 0;

        // Whether this session has already spent its one replacement.
        this.replaced = false;
    }

    // The renderer has compiled its instance and holds the canvas.
    opened () { this.armed = true; }

    // The simulation published a picture for this frame. Read off the frame
    // message's own `stepped` and `held`, which is `present`'s rule one thread
    // over: the page recomputes it rather than being told, because the two
    // skips are already on every frame message and a third field would be the
    // same fact twice.
    published (frame) { this.shown = frame; }

    // And the renderer drew one, which is its heartbeat. What it clears is the
    // wait rather than the debt: a renderer running a frame behind is alive,
    // and the next callback stamps a new instant if it is still behind.
    drew (frame) {
        this.drawn = frame;
        this.pending = null;
    }

    // The page read its own animation frame. Only the oldest instant at which
    // something was owed is kept, exactly as the watchdog above keeps it.
    posted (now) {
        if (! this.armed || this.drawn >= this.shown) { return; }

        if (this.pending === null) { this.pending = now; }
    }

    // A pause, a hidden tab, a resting game, a reset: nothing is owed.
    disarm () { this.pending = null; }

    // Null while the renderer is keeping up, and what to report when it is not.
    // The frame named is the one the picture was owed FOR, because that is the
    // description the wedged instance was rendering and therefore the frame a
    // recording has to reach to reproduce it.
    overdue (now) {
        if (this.pending === null) { return null; }

        const waited = now - this.pending;

        if (waited < this.budget) { return null; }

        return { frame: this.shown, drawn: this.drawn, waited };
    }

    // The page has ended that thread and built another. The picture the dead
    // renderer never drew is not owed by the one that replaced it - a fresh
    // instance is handed the NEXT description the simulation publishes and
    // draws that - so the debt is cleared here rather than carried into a
    // worker that was never asked for it.
    replace () {
        this.replaced = true;
        this.armed = false;
        this.pending = null;
        this.drawn = this.shown;
    }
}

// What the page says when a renderer has stopped twice, which is the one render
// stall that ends a run.
//
// It names the frame the picture was owed for rather than the frame the
// simulation had reached, and the two are not the same number: the simulation
// goes on stepping for the whole budget while the renderer is silent, so by the
// time this is composed it is a second ahead. A recording that reaches the
// later frame would reproduce the wrong render, so `frame` here is the
// description that wedged and the count `seize` writes is the same number.
//
// `shot` for `stallLine`'s own reason, and more plainly: the command has to
// RENDER to reproduce this at all, and `inspector dump` renders nothing.
// `products/web-player/tests/watchdog.js` runs it.
function renderStallLine (stall, budget = WATCHDOG_MS) {
    return `the picture stopped for the second time in this session, while the `
        + `renderer was drawing frame ${stall.frame}. Nothing came back for `
        + `${Math.round (stall.waited)} ms, and a renderer that hangs twice is `
        + `a game that hangs - so the run was ended and the recording beside `
        + `this was written. \`inspector shot --replay <that file> --budget `
        + `${budget} --out <a png>\` on the native plug-in reproduces it, at `
        + `frame ${stall.frame}.`;
}

// ---------------------------------------------------------------------------
// A recording, as the file a person reads.
//
// Space separated lines rather than JSON: the readers are C and this file, and
// a line format costs six lines here while saving a hand written JSON parser on
// the other side - the code standing between a corrupt replay and a silently
// wrong one. Readers split on the first run of whitespace, so a value may
// contain spaces and no quoting rule is needed. `products/mark/source/mark.h`
// is the format, whole.
//
// BELOW THE BROWSER LINE because the page is no longer the only caller. Mark is
// one and the watchdog is the other, and the watchdog's recording is the half of
// pending item 10 a person actually uses - so it is composed where a case can
// read it rather than inside a `Blob` and an anchor click. What is left in the
// page is the two browser calls that put the text in a file.
//
// WHAT IT IS GIVEN is a record the page has been ACCUMULATING rather than one it
// asked for. A hung worker answers no message, so a page that asked would get
// nothing at exactly the moment it needed everything; and the same move is what
// already lets a closing tab write its save with no round trip left to take.
// The simulation posts the new log entries with every frame and the page keeps
// them, so the record is complete at every instant, including the last one
// before a thread stopped existing.
// ---------------------------------------------------------------------------

function markText (name, version, record) {
    // The `seed` line is the number this run really used: the address bar
    // carries it by the time a frame has been drawn, whether a reader wrote it
    // or `composeRun` rolled it, so a recording reproduces a run rather than
    // re-rolling it - by construction rather than by a rule somebody has to
    // remember.
    //
    // Then one `arg <name> <value>` line per pair this run passed through,
    // sorted by name, which is the order they were delivered in - a recording
    // and a delivery are one list, so a reader on another machine produces the
    // same bytes and the same array. An EMPTY value is the name with nothing
    // after it, which is the format's own spelling for the one value that is
    // not absence, and a bare run writes no `arg` line at all - a reader that
    // finds none supplies none.
    //
    // The `save` line between them carries the blob this run was CONSTRUCTED
    // from, and only where that blob had a non-zero byte. It is what was
    // delivered rather than a reference to the store it came out of, so a mark
    // taken here reproduces on a machine whose `localStorage` holds something
    // else or nothing at all - and a run handed nothing writes no line, which
    // is why every replay in this tree older than the record is still valid
    // unchanged. `Session.saveLines` holds both halves of that rule.
    const lines = [
        `game ${name}`,
        `version ${version.join (".")}`,
        `seed ${record.seed}`,
        ...record.saveLines,
        ...record.argLines,
        `frame ${record.frameIndex}`,
    ];

    // Merged by frame rather than one log after the other. Both readers keep a
    // cursor per record kind, so either order parses - but a file read by a
    // person should run forwards in time.
    //
    // A task's answer is recorded beside the buttons because it is the same
    // kind of thing: an edge at a frame boundary that the game branches on. The
    // game SAMPLES a level rather than catching that edge, but the frame the
    // level changes on is still the host's decision, so a replay that left it
    // out would reproduce the run with the answers never arriving,
    // deterministically and wrongly. A failure is recorded for the stronger
    // version of that reason - an absence cannot be pinned at all, so a run
    // where a task never answered is replayable only as a record.
    //
    // By ID rather than by name, and nothing else about a task goes in: a
    // descriptor carries a name nothing resolves through, and the spawn
    // re-fires from the same state on the same frame - so a replay runs the
    // body again and regenerates the output rather than carrying a
    // computation's answer in a file meant to outlive the build that made it.
    //
    // A RESOURCE has no record of its own here and never will: a body reads a
    // file off the frame and a replay re-runs the body, so there is no schedule
    // to reproduce. What pins the bytes is the identity a completion carries -
    // the filename the host handed the body, its length and a fold of it.
    //
    // Every record this page writes says `none` there, which is the format's
    // spelling for "this record pins no delivery", and it is honest rather than
    // lazy: the page FETCHES over HTTP and holds decoded bytes rather than
    // files it read, so it has nothing to fold and no filename to fold it
    // under. A reader cannot tell that from a body that was handed no file, and
    // is not meant to - both mean there is nothing here to check against. So a
    // recording taken here replays and verifies nothing about its resources,
    // which is exactly what the page could say about them before.
    //
    // The pointer is here for the first reason and is written as a change, like
    // `input`: a position is piecewise constant, so a record means "here from
    // this frame until the next one". Leaving the screen is written as `away`
    // rather than as a position nobody is at, because absence is a thing the
    // reader has to reproduce and every coordinate on the screen is a legal one.
    const records = [
        ...record.inputLog.map (e =>
            ({ frame: e.frame, kind: "input", text: e.buttons.join (" ") })),
        ...record.tapLog.map (e =>
            ({ frame: e.frame, kind: "tap", text: e.buttons.join (" ") })),
        ...record.taskLog.map (e =>
            ({ frame: e.frame, kind: e.kind, text: `${e.id} none` })),
        ...record.pointerLog.map (e => ({ frame: e.frame, kind: "pointer",
            text: e.present ? `${e.x} ${e.y}` : "away" })),
    ].sort ((x, y) => x.frame - y.frame);

    for (const entry of records) {
        lines.push (`${entry.kind} ${entry.frame}`
            + (entry.text ? ` ${entry.text}` : ""));
    }

    return lines.join ("\n") + "\n";
}

// The four logs, empty, beside what a run was told before frame 0. One page-side
// record per session, filled by `openRecord` when the simulation answers with
// what it was constructed from and grown by `growRecord` on every frame after.

function openRecord (opened) {
    return {
        seed: opened.seed,
        saveLines: opened.saveLines,
        argLines: opened.argLines,
        frameIndex: 0,
        inputLog: [],
        tapLog: [],
        taskLog: [],
        pointerLog: [],
    };
}

// What one frame message adds. The simulation sends only the entries its logs
// grew by, which is what keeps this O(1) a frame rather than O(n): a pointer
// game moved for ten minutes appends 36,000 entries, and a page told the whole
// log every frame would be copying all of them 36,000 times.

function growRecord (record, frame, fresh) {
    record.frameIndex = frame;

    for (const entry of fresh.input) { record.inputLog.push (entry); }
    for (const entry of fresh.tap) { record.tapLog.push (entry); }
    for (const entry of fresh.task) { record.taskLog.push (entry); }
    for (const entry of fresh.pointer) { record.pointerLog.push (entry); }

    return record;
}

// The smallest scale there is. One device pixel per console pixel is already
// unreadable on any modern display, and below it a console pixel would be a
// fraction of a screen pixel, which is the smearing whole multiples exist to
// avoid - so this is a floor rather than a preference.
const MIN_SCALE = 1;

// How big the canvas should be, as a whole number of DEVICE pixels per console
// pixel, and the CSS box that produces it.
//
// The unit is the whole point. This used to be counted in CSS pixels - floor
// `innerWidth / 240` - and CSS pixels are what page zoom moves, so zooming out
// handed the page more of them and the refit quantised UPWARD. The arithmetic,
// which is how the defect was found: 700 CSS px of room at 100% gives scale 2
// and a 480 px canvas, and the same window at 50% reports 1400 CSS px, takes
// scale 5, and draws a 1200 px canvas half again as large again. Zooming out
// made the game bigger, in irregular jumps, because a floor moves in steps.
//
// Counting device pixels is strictly sharper, and that half is not in doubt:
// whole CSS pixels restricted the count to multiples of `devicePixelRatio` for
// no reason at all, so a 390 CSS px phone at 3 dppx took 1, three device pixels
// to a console pixel, where 4 fits and 320 CSS px is both larger and crisper
// than the 240 it was drawing.
//
// It did NOT fix the zoom, and that is measured rather than argued: Safari at
// 1.5 dppx, zoomed out, still grew the canvas and still reported the same
// ratio. No unit could have fixed it, because the defect is the refit and not
// the arithmetic - `layoutChange` below is what keeps a zoom from reaching this
// function at all.
//
// AND KEEPING THE ZOOM OUT OF HERE WAS NOT ENOUGH EITHER, which is the third
// pass over this and the one the numbers finally explain. Declining to refit is
// what lets a zoom shrink the game; it does nothing about the fit that DOES
// run, and a reload runs one. Measured in the browser, on one window at two
// zooms - the reading is in `tests/layout.js` as the fixture:
//
//     100%      inner 1268x1320   dpr 2   outer 1268x1410
//     zoomed out  inner 2536x2640   dpr 1   outer 1268x1410
//
// `inner` doubles and `dpr` halves, so `inner * dpr` - the device pixels this
// function counts - is IDENTICAL at both. The fit was already zoom-invariant,
// which sounds like the goal and is the defect: it means the canvas comes out
// the same PHYSICAL size at every zoom and fills the window at every zoom. A
// player who zooms out and reloads is back where they started, and one who is
// zoomed out as far as the browser goes has nothing left to try.
//
// So the zoom is divided back out, and `outer` is what measures it: it is the
// window in screen coordinates and page zoom does not move it, so `outer /
// inner` is exactly the zoom factor - 1268/1268 = 1 at 100%, 1268/2536 = 0.5
// zoomed out. Folding it in makes the CSS BOX invariant instead of the physical
// size, which is what browser zoom does to everything else on a page: the box
// above stays 1200 css px at both zooms, and the zoomed-out one renders at 1200
// device pixels where the other renders at 2400.
//
// The whole-multiple guarantee survives it, which is the thing that could not
// be given up: the scale is still a whole number and the box is still `240 *
// scale` device pixels. It is a SMALLER whole number when zoomed out - 5 where
// 100% takes 10 - and that is the game being drawn smaller, not less sharply.
//
// What a whole multiple guarantees is therefore worth stating exactly, because
// it is less than it sounds. At rest it is exact: the CSS box times the ratio
// is `240 * scale` device pixels, so every console pixel is a square block of
// them. While the page is zoomed it is approximate, because a CSS pixel then
// covers a number of device pixels this file cannot read. And on a fractional
// ratio it was never exact BEFORE this work either - whole multiples in CSS
// space are not whole multiples on the grid that exists, so at the 1.5 dppx the
// probe was run on, the old code's CSS scale 3 was 4.5 device pixels to a
// console pixel and some columns were already a device pixel wider than their
// neighbours. The rule reads as inviolable and has been approximate on that
// display for as long as it has been written down.
//
// AND IT IS NO LONGER UNCONDITIONAL, which is the fourth pass and the one that
// gave something up on purpose. What a whole multiple costs is the remainder,
// and on a phone the remainder is most of what a phone has: the window is 240
// times four-and-a-fraction, so the fraction is a big share of a small screen
// and there is no second window to move to. The readings that decided it, each
// device's own viewport through this function - waste is what the whole
// multiple leaves unused, uneven is how much wider a console pixel is than its
// neighbour once the remainder is spent instead:
//
//     iPhone SE          375 css   whole 360    waste  4%   uneven 33%
//     iPhone 15 / 16     393 css   whole 320    waste 19%   uneven 25%
//     iPhone 15 Pro Max  430 css   whole 400    waste  7%   uneven 20%
//     iPad mini          744 css   whole 720    waste  3%   uneven 17%
//     iPad 10.9          820 css   whole 720    waste 12%   uneven 17%
//     1x desktop        1000 css   whole 480    waste 27%   uneven 50%
//
// So the fit fills the span exactly - a fractional scale, and console pixels a
// device pixel apart in width - unless a device pixel is one somebody can see,
// where it takes the whole multiple under it as it always did. That is the
// whole rule, and the threshold in it is a physical claim rather than a taste:
// at 2x and 3x the odd column is a twentieth of a millimetre wider than the one
// beside it, and at 1x it is a whole monitor pixel, which is the 50% row above
// and is the ordinary way to visit a site.
//
// `ratio / zoom` rather than the ratio alone, because `devicePixelRatio` counts
// the browser's zoom into itself: a 1x monitor at 200% reports 2 and is still a
// 1x monitor.
//
// TWO REJECTED SHAPES, because both are the obvious one from somewhere.
//
// A threshold on DENSITY IN CONSOLE PIXELS - fill where there are enough device
// pixels per console pixel to hide the difference - is exactly backwards, and
// it is the intuitive rule: that density is LOWEST on the small screens, 4.9 on
// an iPhone against 8.5 on an iPad Pro, so it would have filled the screens
// with room to spare and snapped the ones without.
//
// And a SECOND CONDITION ON THE WASTE, filling only where the whole multiple
// leaves at least a twentieth of the span, was written and then taken out. It
// is defensible - it spares the iPhone SE a trade of the worst unevenness on
// the list for 15 css px - but it buys that on two devices at the price of a
// threshold, a constant and a branch in every case that reads this, and the
// rule stops being a sentence.
const FILL_DENSITY = 2;

function canvasScale (available, ratio, zoom) {
    const dpr = ratio > 0 ? ratio : 1;

    // A page that cannot say what its zoom is gets the old answer rather than
    // a broken one. `outerWidth` is recorded as unmeasured outside this
    // machine in `docs/decisions.md` item 21, so a browser reporting nothing
    // useful for it lands here and fits exactly as it did before.
    const page = Number.isFinite (zoom) && zoom > 0 ? zoom : 1;

    // A window with no room in it is not an error and must not become one: the
    // page measures its own chrome, so a narrow window can report a negative
    // span, and layout before the first paint can report none at all.
    const fits = (span, limit) =>
        Number.isFinite (span) ? span * dpr * page / limit : 0;

    // The fit the span would take if it could be fractional, and the whole
    // multiple under it. The floor comes after the minimum rather than inside
    // `fits` because it is the CHOSEN dimension that has to be floored - the
    // other one has room to spare by definition.
    const exact = Math.max (MIN_SCALE, Math.min (
        fits (available.width, FRAME_WIDTH),
        fits (available.height, FRAME_HEIGHT)));

    const whole = Math.max (MIN_SCALE, Math.floor (exact));

    const scale = dpr / page >= FILL_DENSITY ? exact : whole;

    // Exact by construction WHERE THE SCALE IS WHOLE: the CSS box times the
    // ratio is `240 * scale`, a whole number of device pixels, so every console
    // pixel is a square block of them. The division can still be fractional in
    // CSS - a ratio of 2.25 makes it 106.67px - and a box of whole device
    // pixels is only on the grid it was sized for if it also STARTS on one,
    // which is what `gridSnap` below reads back and corrects. This function has
    // no way to know: where the page puts the box is the page's arithmetic and
    // not this one's.
    //
    // Where the scale is fractional the box is the span itself and the grid is
    // what was traded away, so `gridSnap` has nothing left to correct there -
    // it still runs, and moves the box by under half a device pixel, which is
    // smaller than the difference it is no longer able to remove.
    return {
        scale,
        width: FRAME_WIDTH * scale / dpr,
        height: FRAME_HEIGHT * scale / dpr,
    };
}

// How far to move a box, in CSS pixels, to put an edge now at `position` onto
// the device pixel grid.
//
// The fraction this cancels is real and has a name. The page centres its
// column, so the free space above the canvas is HALVED - and the row `I`
// reveals is 29.5px tall, because a button is a 19.5px line box in 4px of
// padding inside a 1px border. Half of a fractional leftover is a quarter of a
// CSS pixel, which at a ratio of 2 is half a device pixel, so the canvas lands
// straddling a row of the grid. The browser resolves that by blending the top
// row of the game with what is behind the canvas, which is the canvas's own
// black background, and the result is a dark line along the top edge that
// arrives with the information row and leaves with it.
//
// A reading rather than an even number of pixels of chrome, which was the other
// way to fix it. Rounding the row to 30px puts the artefact away at a ratio of
// 2 and leaves it at 1.5, where a leftover of half a CSS pixel is three
// quarters of a device one however the chrome is sized; and it would put the
// arithmetic in the hands of every future edit to a button's padding. This is
// the same correction whatever the ratio, the window and the row add up to.
//
// Rounding to the nearest whole device pixel rather than flooring, because the
// correction is then at most half a device pixel either way. Flooring moves the
// box by up to a whole one, and always in the same direction, which can push it
// out of a window `canvasScale` had just fitted it to exactly.
function gridSnap (position, ratio) {
    const dpr = ratio > 0 ? ratio : 1;

    // Layout before the first paint reports nothing at all, and a correction
    // computed from it would reach `style.transform` as NaN - which a browser
    // drops in silence, leaving no correction and no complaint either.
    if (! Number.isFinite (position)) { return 0; }

    const device = position * dpr;

    return (Math.round (device) - device) / dpr;
}

// How far the page is zoomed, as the factor that turns a CSS pixel back into
// the one it would be at 100%, given one reading of the window.
//
// `outerWidth` is the window in screen coordinates and page zoom does not move
// it, where `innerWidth` is CSS pixels and does - so the two divide to exactly
// the zoom. Width rather than height because the browser's own chrome is above
// the page rather than beside it: `outerHeight` carries a tab strip and an
// address bar that `outerWidth` does not, and a docked console takes
// `innerHeight` without touching outer at all.
//
// ALL OF WHICH ASSUMES THE OUTER PAIR IS A WINDOW, and on a phone it is the
// SCREEN. Measured on an iPhone, through this page, by rotating it:
//
//     portrait    inner 390x699    outer 390x844
//     landscape   inner 750x284    outer 390x844
//
// The outer pair does not turn over, because the device has one screen and it
// has one size. Portrait survives that by luck - 390/390 is 1, which is the
// right answer - and landscape reads 390/750 = 0.52, so the page concluded the
// player had zoomed the browser out to half and divided it back out of the fit,
// drawing a 125 css px canvas where 240 fits. That is the whole of the "the
// zoom is weird after rotating" report.
//
// So the reading is refused when the two pairs disagree about which way up the
// window is, because a window's chrome adds to it and cannot turn it over: a
// portrait outer around a landscape inner is not this window at all, and a
// phone that has no page zoom in the first place is right to answer 1.
//
// The failure mode, which is a narrow band rather than a class: a desktop
// window whose inner box is barely wider than it is tall has an outer box that
// chrome makes taller than it is wide, so the pairs disagree and a zoom there
// reads as 1. What that costs is a fit performed WHILE zoomed in such a window
// - a reload or a resize - which fills rather than dividing the zoom out. It
// cannot be told apart from the phone by these four numbers, and the phone is
// the case that is wrong on every rotation rather than in a band.
function pageZoom (view) {
    if (! (view.innerWidth > 0)) { return 1; }

    const crossways = (view.outerWidth > view.outerHeight)
        !== (view.innerWidth > view.innerHeight);

    return crossways ? 1 : view.outerWidth / view.innerWidth;
}

// What just happened to the window, given two readings of it: `window`, a real
// resize OR a rotation; `display`, the same window on glass of a different
// density; `zoom`, the player working the browser's own control; or `none`.
//
// This exists because the page had no way to tell those apart and refitted on
// all of them, which is the whole of the defect above. A zoom is the player
// SAYING how large they want the game, and a refit is the page overruling them
// half a frame later - so zooming out handed the page more CSS pixels, the fit
// took a bigger multiple, and the game grew. Answering "the player has no
// control" turns out to need no control at all: it needs the page to stop
// taking it away, and then Cmd-minus does what it does on every other page.
//
// `outerWidth` and `outerHeight` are the discriminator. They are the window in
// screen coordinates and page zoom does not move them, where `innerWidth` and
// `innerHeight` are CSS pixels and it does. So inner moving alone is a zoom,
// and that is the case that must NOT refit.
//
// `display` is separate from `window` because it is the one ratio change that
// still has to refit. A window dragged to a monitor of another density keeps
// its CSS size, so the inner dimensions hold still while the ratio moves - and
// the CSS box that was a whole number of device pixels on the old screen is not
// one on the new. Zoom is excluded from it by the same test read the other way:
// Chrome moves the ratio when zooming AND moves the inner dimensions with it,
// so requiring the inner dimensions to hold still keeps a Chrome zoom out of
// here. Safari does not move the ratio at all - measured, `10x at 1.5 dppx`
// unchanged across a zoom - so there it never fires either way.
//
// The failure mode is worth knowing before trusting it: if some browser moves
// the outer dimensions under zoom, that zoom reads as a resize and refits, and
// the behaviour there is exactly what this replaced rather than something new
// and worse.
function layoutChange (before, after) {
    // Nothing to compare against yet, so the caller has to fit rather than
    // decide. A first paint that skipped the fit would leave the canvas at
    // whatever the markup said.
    if (! before) { return "window"; }

    // A rotation is a window change whatever the device reports about it, and
    // it has to be asked first because on a phone it can wear a zoom's exact
    // signature: the inner box turns over and the outer pair, which is the
    // screen, may not move at all. Declined as a zoom it leaves a portrait
    // canvas in a landscape window, which the whole multiple used to hide -
    // the box was a step smaller than the room and usually still fitted - and
    // which filling the span cannot, since a box that exactly fills one
    // orientation overflows the other.
    //
    // Reading the turn off the inner box rather than off `screen.orientation`
    // keeps this function what it is, four numbers in and a verdict out, with
    // no browser in it. Nothing else here can produce the flip: a zoom scales
    // both dimensions by one factor and cannot reorder them, and a display
    // change moves neither.
    const turned = (before.innerWidth > before.innerHeight)
        !== (after.innerWidth > after.innerHeight);

    if (turned) { return "window"; }

    if (before.outerWidth !== after.outerWidth
        || before.outerHeight !== after.outerHeight)
    {
        return "window";
    }

    const inner = before.innerWidth !== after.innerWidth
        || before.innerHeight !== after.innerHeight;

    const ratio = before.ratio !== after.ratio;

    if (ratio && ! inner) { return "display"; }

    return inner || ratio ? "zoom" : "none";
}

// A client position, as a console pixel.
//
// The whole of what a pointer event means to this console, and it needs no
// browser: what arrives is two numbers and the box the canvas occupies. The
// page owns the listeners and the capture; this owns what they mean, exactly as
// `KEYS` does for the keyboard - which is what lets
// `cmake/WebPlayerPlays.cmake` exercise it under node.
//
// Divided by the RECT rather than by the whole-number scale `fitCanvas` chose,
// because browser zoom scales the CSS box without changing that number, and the
// box is what a client coordinate is measured in.
//
// Clamped rather than merely floored, because `interface/game.h` promises a
// game that `x` is below `game_frame_width` and `y` below `game_frame_height`
// so that either may index a row or a column directly. A press captures, so
// this is the live case rather than a guard against one: a drag off the canvas
// keeps arriving here and reports the edge it left through.
function pointerPixel (clientX, clientY, rect) {
    // A canvas with no box has not been laid out, and there is no position to
    // report; the alternative is a division by zero reaching a game as NaN.
    if (! rect.width || ! rect.height) { return { x: 0, y: 0 }; }

    const pixel = (offset, span, limit) =>
        Math.max (0, Math.min (limit - 1, Math.floor (offset * limit / span)));

    return {
        x: pixel (clientX - rect.left, rect.width, FRAME_WIDTH),
        y: pixel (clientY - rect.top, rect.height, FRAME_HEIGHT),
    };
}

// ---------------------------------------------------------------------------
// The screen, up to the last step: a framebuffer of palette indices becomes
// RGBA, and what is done with those bytes is the host's business - a canvas in
// the page, an array in a test.
//
// `seen` accumulates which palette entries this run has actually put on screen,
// as a bit per entry. It is the cheapest form of the framebuffer histogram
// `docs/decisions.md` asks for, and it answers the question a fantasy console
// leaves an author with no other way to ask: did that ever reach the screen at
// all. An entry that only a loaded resource can produce is the clearest case -
// `games/example` draws 0, 1 and 2 itself and its sprite draws 6 and 12 - so
// this says whether the bytes arrived AND were drawn, which no status line can.
//
// Over the run rather than over a frame, and that is the whole of why it is
// worth carrying: a frame is one instant, and on any game with a blinking title
// screen the instant is a coin flip. Measured on `games/example`, whose title
// bar blinks on a 24 frame period: 146 of 301 sampled frames are a single
// colour.
//
// Alpha is never written. The caller fills it once with 255 and it stays there,
// which is one pass over a quarter of a megabyte saved on every frame.
// ---------------------------------------------------------------------------

function paint (frame, palette, rgba, seen) {
    for (let index = 0, at = 0; index < frame.length; index++, at += 4) {
        const entry = frame [index] & (PALETTE_SIZE - 1);

        seen |= 1 << entry;

        const channel = entry * 3;

        rgba [at]     = palette [channel];
        rgba [at + 1] = palette [channel + 1];
        rgba [at + 2] = palette [channel + 2];
    }

    return seen;
}

// The entries `paint` has seen, as the numbers a reader reads.
function paletteEntries (seen) {
    const entries = [];

    for (let index = 0; index < PALETTE_SIZE; index++) {
        if (seen & (1 << index)) { entries.push (index); }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// The page's own colours, derived from the one palette entry the game declares
// for them.
//
// `Game.background` names an entry and stops there, which leaves the host every
// other colour on the page. Deriving them rather than pinning them is not
// decoration: the chrome used to be nine hard-coded greys chosen against one
// dark background, and a game declaring a pale surround would have left the HUD
// reading light grey on cream - unreadable, on a page whose whole job is to say
// what the module is.
//
// So there is one formula and it takes one decision: which direction contrast
// lies in. Every other colour is the surround mixed that far toward black or
// toward white, which keeps the page one family with the game rather than a
// dark frame around it, and keeps every pair legible by construction rather
// than by a table someone has to re-check when a game is added.
//
// Here rather than in the stylesheet, though `color-mix()` would express it in
// CSS, because this half of the player runs under node with no browser at all -
// so the derivation is a function `plays.js` can call and a check can compare
// against `inspector info`, rather than a computed style only a person can see.
// It also means the page depends on no CSS feature this tree has not measured.
// ---------------------------------------------------------------------------

// Relative luminance, sRGB, as WCAG defines it: linearize each channel, then
// weight them by the eye's sensitivity. Worth the exponent over the cheap
// `(299r + 587g + 114b) / 1000` because the threshold below is only meaningful
// on this scale.
function luminance (red, green, blue) {
    const linear = (value) => {
        const unit = value / 255;

        return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * linear (red) + 0.7152 * linear (green)
        + 0.0722 * linear (blue);
}

// Where black text overtakes white text against a background, on the scale
// above. Not a taste: it is the luminance at which the WCAG contrast ratio
// against white equals the one against black, so on either side of it the
// choice this makes is the higher-contrast one.
const LIGHT_THRESHOLD = 0.179;

const mix = (from, to, amount) =>
    from.map ((channel, index) =>
        Math.round (channel + (to [index] - channel) * amount));

const css = ([red, green, blue]) => `rgb(${red}, ${green}, ${blue})`;

// WCAG's contrast ratio between two colours, which is what the fixed mixes
// below are checked against rather than trusted.
function contrast (one, other) {
    const first = luminance (...one), second = luminance (...other);
    const high = Math.max (first, second), low = Math.min (first, second);

    return (high + 0.05) / (low + 0.05);
}

// AA for body text. Every colour on the page that is TEXT clears this against
// the surround, and the ones that are not - the panels, and the hairline round
// the canvas - deliberately do not: a border at 4.5 is a frame.
const READABLE = 4.5;

// A fixed fraction of the way toward contrast is not enough on its own, and a
// mid-tone surround is where it breaks: measured, a 50% mix on `rgb(128, 128,
// 128)` gives a ratio of 2.63 and the yellow accent gives 1.21, which is a
// pause indicator nobody can see. The reason is that contrast against a
// mid-tone is bounded - about 5.3 either way - so a fraction that is generous
// against near-black is nowhere near enough there.
//
// So a text colour is pushed further until it clears the bar, in twentieths,
// and takes full contrast if even that will not do. The step from `base` is
// what keeps the ordinary case looking as it did: on the dark surrounds every
// game in this tree declares, the first candidate already passes and this
// returns `base` unchanged.
//
// A base on the far side of the surround dips before it climbs - a pale yellow
// pushed toward black passes through the surround's own luminance on the way -
// and the loop is right through that dip anyway, because it takes the FIRST
// candidate that clears the bar rather than assuming the ratio only grows.
//
// What a mid-tone surround still costs is the HUD's hierarchy, and it is a real
// limit rather than an oversight: measured on `rgb(128, 128, 128)`, `ink`,
// `dim` and both accents all end up within a few points of black, because there
// is not room for four distinguishable colours that each clear 4.5 against a
// ground with 5.3 of headroom in either direction. The page stays readable and
// stops being layered. A game wanting both should declare a surround nearer one
// end than the middle, which is what all six here do.
function legible (base, surround, contrasting, target) {
    const steps = 20;

    for (let step = 0; step <= steps; step++) {
        const candidate = mix (base, contrasting, step / steps);

        if (contrast (candidate, surround) >= target) { return candidate; }
    }

    return contrasting;
}

// The one accent, which is a hue rather than a mix: a refusal that took the
// page's own colour would stop reading as a refusal. `legible` darkens or
// lightens it as far as it has to, which on a pale surround is a long way, and
// hue is what gives way - a message that cannot be read is worth less than one
// that has drifted toward brown.
//
// There were two until the pause indicator moved onto the button that causes
// it. The yellow had no other reader, and a colour derived for nobody is a
// colour that goes wrong unnoticed.
const ALARM = [224, 108, 108];

// The page's palette, from the game's. Every field is a CSS colour except
// `light`, which is the verdict the rest were derived from and which the page
// also hands to `color-scheme` so the browser's own scrollbars follow.
function theme (palette, background) {
    const at = (background & (PALETTE_SIZE - 1)) * 3;
    const surround = [palette [at], palette [at + 1], palette [at + 2]];
    const light = luminance (...surround) > LIGHT_THRESHOLD;

    // Which way contrast lies, and the only decision this function makes.
    // Named `contrasting` rather than `contrast` because `contrast` above is
    // the ratio between two colours, and one of these shadowing the other
    // inside `legible` would be a bug nothing here could see.
    const contrasting = light ? [0, 0, 0] : [255, 255, 255];
    const toward = (amount) => css (mix (surround, contrasting, amount));

    const readable = (base) =>
        css (legible (base, surround, contrasting, READABLE));

    return {
        light,

        surround: css (surround),

        // Text, at two weights. 0.86 rather than 1.0 because pure contrast on a
        // coloured ground reads as a different material; keeping a trace of the
        // surround in it keeps the page one surface. Measured, that fraction
        // clears the bar unaided at every luminance, mid-tone included, so only
        // the dimmer of the two is ever pushed.
        ink: readable (mix (surround, contrasting, 0.86)),
        dim: readable (mix (surround, contrasting, 0.5)),

        // The raised things - buttons and keycaps - and the lines around them.
        // Not text, so not held to `READABLE`: these are surfaces a millimetre
        // off the page and a legible one would be a box drawn round everything.
        //
        // `edge` is what stops the canvas dissolving into the page now that the
        // page can be the game's own background colour: it is the only thing
        // drawing the screen's boundary when the two colours agree exactly.
        panel: toward (0.1),
        hover: toward (0.16),
        edge: toward (0.2),

        alarm: readable (ALARM),
    };
}

// The resource line: one row per READ a body made, in the order the results
// carrying them reached the game.
//
// It reads the COMPLETION LOG rather than a cache of what is resident, and the
// difference is the design rather than a preference. Nothing is delivered any
// more: a resource is bytes a body read and threw away, and what survives one
// is the block the body wrote. So the question a watcher can be answered is
// "what did this run's bodies read, and did the tasks that read them deliver" -
// which is what these rows say, and `inspector dump --resources` says the same
// thing keyed on the task rather than on the file.
//
// The log outlives the table on purpose. A `failed` task is retired at the
// frame boundary after its result went out, so a run that ended up drawing its
// fallback would have nothing left in the table to name the file it could not
// read - which is the one thing whoever is watching most wants to know.
//
// `none` is a run whose bodies read nothing, which is now something only a run
// can say: nothing is declared in advance, so before the first step every game
// looks like that one.
function resourceLine (session) {
    if (! session.readLog.length) { return "none"; }

    return session.readLog.map (read =>
        `${read.name} ${read.failed ? "failed" : "resident"}`).join (", ");
}

// The task line: the leak report, which is the live table rather than the log.
//
// One row per id the game is still holding, with what it has become. A row
// reading `resident` long after its `finished` frame IS a block the game never
// released - and nothing warns, exactly as `console_tasks` warns about nothing,
// because the dump is for a reader who asked rather than a line on a run that
// did not.
function taskLine (session) {
    const table = session.taskTable ();

    if (! table.length) { return "none"; }

    return table.map (task =>
        `${task.id} ${task.name || "?"} ${task.state}`).join (", ");
}

// The controls line: what the game declared it reads, in the words the header
// uses for them. Beside the state size because it arrives through the same
// hand-mirrored offsets - so a mirror that has drifted shows up here as a need
// with no name rather than as a game that gets no input.
function controlsLine (session) {
    return `buttons ${NEED_NAMES [session.controls.buttons]}, `
        + `pointer ${NEED_NAMES [session.controls.pointer]}`;
}

// The keycap legends, one group per member of `Game_Controls` that the game
// says it reads.
//
// The row used to be written into the page's markup, so every game the player
// ever loaded was advertised as an arrow-key game with two buttons. That is
// advice a player of `games/klondike` cannot act on and advice a player of
// `games/minesweeper` cannot act on at all - the second declares
// `game_need_none` for the pad, which means the host hands it no button for the
// whole run, and the page was naming six of them.
//
// The label is what the CONSOLE calls the thing, not what the key does in the
// game: a page that has not inspected a game cannot say what `a` means in it,
// and a legend that guessed would be wrong per game rather than wrong once.
const LEGENDS = {
    buttons: [
        { keys: ["↑", "↓", "←", "→"], label: "move" },
        { keys: ["Z", "X"], label: "a / b" }
    ],

    // The one line of glyph vocabulary a pointer game needed and the page had
    // none of. An arrow rather than a mouse, because the input is a pointer
    // rather than a device: a finger produces one too, and every game here that
    // draws its own cursor draws this shape.
    pointer: [
        { keys: ["↖"], label: "point / click" }
    ]
};

// `fillLegends`: Fills a row with the legends for what a game reads.
//
// Parameters:
//
// - `row`: element whose children become the legends.
// - `controls`: the two `Game_Need`s the module declared.
// - `document`: the document `row` belongs to.
//
// Notes:
//
// - The required control goes first, and that ordering is the whole of how the
//   difference between required and optional is drawn. A game that plays
//   without a control and a game that cannot are different advice to a person
//   deciding whether to reach for a mouse, and the alternative spelling is an
//   adjective beside a glyph - "arrows (optional)" is longer than the legend it
//   qualifies and says less than its position does.
// - What a host may do with the device it actually has is deliberately not read
//   here. `interface/game.h` lets a host with no other way to reach the pad
//   satisfy `buttons` from a pointer, a tap standing in for a press, so the
//   honest legend on a phone depends on the device as well as on the
//   declaration. This is the declaration half, which is the half that is wrong
//   for every device; the page never asks what kind of device it is on, and a
//   keyboard legend on a phone is what remains wrong after this.
// - `document` is a parameter for the reason `composeRun` takes its roll and
//   its history: this file is the half of the player with no browser in it, and
//   a function reaching for a global would move it to the other side of that
//   line and out of reach of the case that reads it.

function fillLegends (row, controls, document) {
    // Sorted descending by need, so `game_need_required` leads
    // `game_need_optional`. `sort` is stable, so two controls a game needs
    // equally keep the pad-first order the page has always drawn them in.
    const parts = ["buttons", "pointer"]
        .filter (part => controls [part] !== NEED.none)
        .sort ((first, second) => controls [second] - controls [first]);

    const spans = [];

    for (const part of parts) {
        for (const legend of LEGENDS [part]) {
            const span = document.createElement ("span");

            span.className = "dim";

            for (const key of legend.keys) {
                const cap = document.createElement ("kbd");

                cap.textContent = key;

                span.appendChild (cap);
            }

            span.appendChild (document.createTextNode (` ${legend.label}`));

            spans.push (span);
        }
    }

    // Replaced rather than appended: `describe` runs once per session, and a
    // page that loaded a second game would otherwise carry the first one's
    // legends beside it.
    row.replaceChildren (...spans);
}

// The node door. `module` is undefined in a browser, so the page reads the
// declarations above out of the global lexical scope and never reaches this.

if (typeof module !== "undefined") {
    module.exports = {
        LAYOUT, CORE, NOTHING, LOADER, RUNNER,
        NAME_MAX, FORMAT_MAX, PATH_MAX,
        RESOURCE_FORMAT_OFFSET, RESOURCE_PATH_OFFSET, RESOURCE_BYTES,
        PAIR, PAGE_KEYS, SEED_KEY, DAY_KEY, FRAME_WIDTH,
        FRAME_HEIGHT,
        PALETTE_SIZE, FRAME_RATE, SAMPLE_RATE, SAMPLES_PER_FRAME, BUTTONS,
        POINTER_BUTTONS, RECORDED_BUTTONS, NEED, NEED_NAMES, KEYS, POINTER_KEYS,
        REPORT, WASM_MAGIC, MIN_SCALE,
        onRefusal, refuse, fetchModule, fetchTrampoline, fetchCore,
        installTrampoline, HostCore,
        Session, Consumer, freshDeliveries,
        SAVE_KEY_PREFIX, SAVE_PERIOD, saveHex, SaveStore, watchStore,
        dayNumber,
        resourceBase, composeRun, queryArguments, argumentList,
        runTaskBody, TaskRunner, sizeClass,
        Input, pointerPixel, canvasScale, gridSnap, pageZoom, layoutChange,
        halted, haltChange, Clock,
        WATCHDOG_MS, Watchdog, stallLine, RenderWatch, renderStallLine,
        markText, openRecord, growRecord,
        paint, paletteEntries, luminance, contrast, theme, resourceLine,
        taskLine, controlsLine, fillLegends,
        consolePcm, decodeResource, resourceReader, stringAt,
    };
}
