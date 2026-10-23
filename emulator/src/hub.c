/*
 * Pokémon Hub's mGBA WebAssembly glue (ADR-011, ADR-018).
 *
 * One module runs 1–4 GBA cores. With more than one, the cores are joined by
 * mGBA's own link-cable driver (GBASIOLockstep) and run in a single thread:
 * this file plays the part of the Qt frontend's MultiplayerController, but
 * where Qt parks a core's thread, we just stop calling that core's run loop
 * until it is woken. The order is fixed, so every browser that runs the same
 * games with the same inputs gets the same result — that is what network
 * lockstep relies on (ADR-012): only inputs travel, never the cable.
 *
 * A Game Boy page runs exactly one GB core. Its cable is a network driver
 * (below): only cable bytes cross the network, and each player runs only
 * their own game (ADR-020).
 *
 * The page (public/emulator/player.js) owns pacing, input and the game bytes.
 * This file never sees anything but memory buffers it is handed.
 *
 * This is a separate file linked against unmodified mGBA 0.10.5 (MPL-2.0).
 */
#include <emscripten/emscripten.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <mgba/core/blip_buf.h>
#include <mgba/core/core.h>
#include <mgba/core/interface.h>
#include <mgba/core/log.h>
#include <mgba/gb/core.h>
#include <mgba/gba/core.h>
#include <mgba/internal/gb/gb.h>
#include <mgba/internal/gb/io.h>
#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/io.h>
#include <mgba/internal/gba/sio/lockstep.h>
#include <mgba-util/vfs.h>

#define MAX_PLAYERS 4
#define WIDTH 240
#define HEIGHT 160
#define AUDIO_MAX 4096
// A core that gets nothing done for this many passes means the cable is stuck.
#define STALL_PASSES 200000

enum Platform { PLATFORM_GBA = 0, PLATFORM_GB = 1 };

struct Player {
	struct mCore* core;
	struct GBASIOLockstepNode node;
	color_t video[WIDTH * HEIGHT];
	unsigned width, height;
	void* rom;
	// Lockstep bookkeeping, as in mGBA's Qt MultiplayerController::Player.
	int awake;
	int32_t cyclesPosted;
	unsigned waitMask;
};

static struct Player players[MAX_PLAYERS];
static int count;
static enum Platform platform;
static struct GBASIOLockstep lockstep;
static int16_t audio[AUDIO_MAX * 2];
static int16_t audioScratch[AUDIO_MAX * 2];
static int audioPlayer;
static uint32_t stalls;

// ---------------------------------------------------------------- lockstep coordinator

static struct Player* player(int id) {
	return &players[id];
}

static bool _signal(struct mLockstep* ls, unsigned mask) {
	UNUSED(ls);
	struct Player* master = player(0);
	master->waitMask &= ~mask;
	if (!master->waitMask && master->awake < 1) {
		master->awake = 1;
		return true;
	}
	return false;
}

static bool _wait(struct mLockstep* ls, unsigned mask) {
	UNUSED(ls);
	struct Player* master = player(0);
	master->waitMask |= mask;
	if (master->awake > 0) {
		master->awake = 0;
		return true;
	}
	return false;
}

static void _addCycles(struct mLockstep* ls, int id, int32_t cycles) {
	UNUSED(ls);
	if (cycles < 0) {
		abort();
	}
	if (id) {
		player(id)->cyclesPosted += cycles;
		return;
	}
	for (int i = 1; i < count; ++i) {
		struct Player* p = player(i);
		if (p->node.d.p->mode > SIO_MULTI) {
			continue; // not on the cable right now: runs free, bounded by the frame
		}
		p->cyclesPosted += cycles;
		if (p->awake < 1) {
			p->node.nextEvent += p->cyclesPosted;
		}
		p->awake = 1;
	}
}

static int32_t _useCycles(struct mLockstep* ls, int id, int32_t cycles) {
	UNUSED(ls);
	struct Player* p = player(id);
	p->cyclesPosted -= cycles;
	if (p->cyclesPosted <= 0) {
		p->awake = 0;
	}
	return p->cyclesPosted;
}

static int32_t _unusedCycles(struct mLockstep* ls, int id) {
	UNUSED(ls);
	return player(id)->cyclesPosted;
}

static void _unload(struct mLockstep* ls, int id) {
	UNUSED(ls);
	if (id) {
		struct Player* p = player(id);
		p->cyclesPosted = 0;
		// Release the master if it was waiting for this GBA.
		struct Player* master = player(0);
		master->waitMask &= ~(1 << id);
		if (!master->waitMask && master->awake < 1) {
			master->awake = 1;
		}
		return;
	}
	for (int i = 1; i < count; ++i) {
		struct Player* p = player(i);
		p->cyclesPosted += lockstep.players[0]->eventDiff;
		if (p->awake < 1) {
			p->node.nextEvent += p->cyclesPosted;
			p->awake = 1;
		}
	}
}

// ---------------------------------------------------------------- setup

// mGBA logs every serial register write at debug level; keep only errors.
static void _log(struct mLogger* logger, int category, enum mLogLevel level, const char* format, va_list args) {
	UNUSED(logger);
	if (level & (mLOG_FATAL | mLOG_ERROR)) {
		fprintf(stderr, "mGBA %s: ", mLogCategoryName(category));
		vfprintf(stderr, format, args);
		fputc('\n', stderr);
	}
}

static struct mLogger logger = { .log = _log };

/**
 * Create `n` cores of `plat` (0 = GBA, 1 = GB; a GB page always has one core).
 * `rtcMode`: 0 = wall clock (solo), 1 = fixed start `rtcEpochMs`, advancing with emulated time (linked).
 */
EMSCRIPTEN_KEEPALIVE int hub_init(int plat, int n, int sampleRate, int rtcMode, double rtcEpochMs) {
	if (count || n < 1 || n > MAX_PLAYERS || (plat != PLATFORM_GBA && plat != PLATFORM_GB) || (plat == PLATFORM_GB && n != 1)) {
		return 0;
	}
	platform = plat;
	mLogSetDefaultLogger(&logger);
	if (n > 1) {
		GBASIOLockstepInit(&lockstep);
		mLockstepInit(&lockstep.d);
		lockstep.d.lock = NULL;
		lockstep.d.unlock = NULL;
		lockstep.d.signal = _signal;
		lockstep.d.wait = _wait;
		lockstep.d.addCycles = _addCycles;
		lockstep.d.useCycles = _useCycles;
		lockstep.d.unusedCycles = _unusedCycles;
		lockstep.d.unload = _unload;
	}
	for (int i = 0; i < n; ++i) {
		struct Player* p = player(i);
		memset(p, 0, sizeof(*p));
		p->awake = 1;
		p->core = plat == PLATFORM_GB ? GBCoreCreate() : GBACoreCreate();
		if (!p->core || !p->core->init(p->core)) {
			return 0;
		}
		mCoreInitConfig(p->core, NULL);
		// Idle-loop skipping changes when a core reaches the cable; keep linked cores exact.
		mCoreConfigSetDefaultValue(&p->core->config, "idleOptimization", n > 1 ? "ignore" : "remove");
		// This headless frontend has no mGBA config.ini to populate opts.volume.
		// Without an explicit value mCoreConfigMap leaves it at the zero-initialized
		// value, and _GBACoreLoadConfig sets GBA masterVolume to zero. The page
		// applies its own mute/volume controls to PCM, so keep the core at full gain.
		mCoreConfigSetOverrideValue(&p->core->config, "volume", "0x100");
		mCoreConfigSetOverrideValue(&p->core->config, "mute", "0");
		// Super Game Boy games would otherwise get a 256×224 border; keep the plain 160×144 screen.
		mCoreConfigSetOverrideValue(&p->core->config, "sgb.borders", "0");
		mCoreLoadConfig(p->core);
		p->core->desiredVideoDimensions(p->core, &p->width, &p->height);
		p->core->setVideoBuffer(p->core, p->video, p->width);
		p->core->setAudioBufferSize(p->core, AUDIO_MAX);
		blip_set_rates(p->core->getAudioChannel(p->core, 0), p->core->frequency(p->core), sampleRate);
		blip_set_rates(p->core->getAudioChannel(p->core, 1), p->core->frequency(p->core), sampleRate);
		if (rtcMode == 1) {
			p->core->rtc.override = RTC_FAKE_EPOCH;
			p->core->rtc.value = (int64_t) rtcEpochMs;
		}
	}
	count = n;
	return 1;
}

/**
 * Load player `i`'s game (and optional patch, e.g. an approved ROM hack's BPS)
 * from memory. The buffers must stay allocated: mGBA maps the game in place.
 * The save is copied into an in-memory save file; nothing touches a disk.
 */
EMSCRIPTEN_KEEPALIVE int hub_load(int i, void* rom, int romSize, const void* save, int saveSize, const void* patch, int patchSize) {
	if (i < 0 || i >= count) {
		return 0;
	}
	struct Player* p = player(i);
	struct VFile* vf = VFileFromMemory(rom, romSize);
	if (!vf || !p->core->loadROM(p->core, vf)) {
		return 0;
	}
	p->rom = rom;
	if (patch && patchSize) {
		struct VFile* pvf = VFileFromConstMemory(patch, patchSize);
		if (!pvf || !p->core->loadPatch(p->core, pvf)) {
			return 0;
		}
	}
	p->core->loadSave(p->core, VFileMemChunk(save, save ? saveSize : 0));
	return 1;
}

/** Wire the cable (if linked) and power every GBA on. Call once all games are loaded. */
EMSCRIPTEN_KEEPALIVE void hub_start(int audioFrom) {
	audioPlayer = audioFrom;
	for (int i = 0; i < count; ++i) {
		struct Player* p = player(i);
		p->core->reset(p->core);
		if (count > 1) {
			struct GBA* gba = p->core->board;
			GBASIOLockstepNodeCreate(&p->node);
			GBASIOLockstepAttachNode(&lockstep, &p->node);
			GBASIOSetDriver(&gba->sio, &p->node.d, SIO_MULTI);
			GBASIOSetDriver(&gba->sio, &p->node.d, SIO_NORMAL_32);
		}
	}
}

// ---------------------------------------------------------------- running

EMSCRIPTEN_KEEPALIVE void hub_set_keys(int i, int keys) {
	if (i >= 0 && i < count) {
		player(i)->core->setKeys(player(i)->core, keys);
	}
}

static bool _onCable(struct Player* p) {
	return p->node.d.p && p->node.d.p->mode <= SIO_MULTI;
}

static void _drainAudio(void) {
	for (int i = 0; i < count; ++i) {
		struct mCore* core = player(i)->core;
		int16_t* out = i == audioPlayer ? audio : audioScratch;
		int avail = blip_samples_avail(core->getAudioChannel(core, 0));
		if (avail > AUDIO_MAX) {
			avail = AUDIO_MAX;
		}
		blip_read_samples(core->getAudioChannel(core, 0), out, avail, true);
		blip_read_samples(core->getAudioChannel(core, 1), out + 1, avail, true);
		if (i == audioPlayer) {
			EM_ASM({ Module.audioFrames = $0; }, avail);
		}
	}
}

/**
 * Advance one frame of player 0 (the cable's master). The others run
 * interleaved in small slices, each until mGBA's lockstep tells it to wait
 * for the rest; a GBA that isn't on the cable just keeps pace frame by frame.
 * Returns 0 if the cable deadlocked (counted in hub_stalls).
 */
static bool _netBeforeFrame(void);
static void _netAfterFrame(void);
static void _airFrame(void);

EMSCRIPTEN_KEEPALIVE int hub_run_frame(void) {
	if (count == 1) {
		if (!_netBeforeFrame()) {
			return 0; // the GBA cable's parent is waiting for its child: the frame stays due
		}
		player(0)->core->runFrame(player(0)->core);
		_netAfterFrame();
		_airFrame();
		_drainAudio();
		return 1;
	}
	struct Player* master = player(0);
	uint32_t start = master->core->frameCounter(master->core);
	int idle = 0;
	while (master->core->frameCounter(master->core) == start) {
		bool ran = false;
		for (int i = 0; i < count; ++i) {
			struct Player* p = player(i);
			if (!p->awake) {
				continue;
			}
			if (i && !_onCable(p) && p->core->frameCounter(p->core) > start) {
				continue; // a free-running GBA waits at the frame line for the master
			}
			p->core->runLoop(p->core);
			ran = true;
		}
		if (!ran && ++idle > STALL_PASSES) {
			// Every GBA is asleep: the driver lost a wake-up. Wake the master rather than hang the page.
			++stalls;
			master->waitMask = 0;
			master->awake = 1;
			idle = 0;
		}
	}
	for (int i = 1; i < count; ++i) {
		struct Player* p = player(i);
		while (!_onCable(p) && p->awake && p->core->frameCounter(p->core) <= start) {
			p->core->runLoop(p->core);
		}
	}
	_drainAudio();
	return 1;
}

EMSCRIPTEN_KEEPALIVE uint32_t hub_stalls(void) {
	return stalls;
}

/** Player `i`'s last frame as RGBA (mGBA leaves the alpha byte empty), hub_video_size() pixels. */
EMSCRIPTEN_KEEPALIVE void* hub_video(int i) {
	struct Player* p = player(i);
	for (unsigned j = 0; j < p->width * p->height; ++j) {
		p->video[j] |= 0xFF000000;
	}
	return p->video;
}

/** Player `i`'s screen as width << 16 | height: 240×160 for a GBA, 160×144 for a GB. */
EMSCRIPTEN_KEEPALIVE int hub_video_size(int i) {
	return (int) (player(i)->width << 16 | player(i)->height);
}

/** Interleaved stereo samples from the audible player's last frame; Module.audioFrames says how many. */
EMSCRIPTEN_KEEPALIVE void* hub_audio(void) {
	return audio;
}

// ---------------------------------------------------------------- saves and states

static void* saveBuffer;

/** Copy player `i`'s save RAM out. Returns its size; the bytes are at hub_save_data(). */
EMSCRIPTEN_KEEPALIVE int hub_save_read(int i) {
	free(saveBuffer);
	saveBuffer = NULL;
	return (int) player(i)->core->savedataClone(player(i)->core, &saveBuffer);
}

EMSCRIPTEN_KEEPALIVE void* hub_save_data(void) {
	return saveBuffer;
}

EMSCRIPTEN_KEEPALIVE int hub_state_size(int i) {
	return (int) player(i)->core->stateSize(player(i)->core);
}

/** Save states stay in the page's memory (ADR-016); the page refuses them while linked. */
EMSCRIPTEN_KEEPALIVE int hub_state_save(int i, void* out) {
	return player(i)->core->saveState(player(i)->core, out);
}

EMSCRIPTEN_KEEPALIVE int hub_state_load(int i, const void* in) {
	return player(i)->core->loadState(player(i)->core, in);
}

/** Read a word off player `i`'s bus — for tests and the link diagnostics panel. */
EMSCRIPTEN_KEEPALIVE uint32_t hub_read32(int i, uint32_t address) {
	return player(i)->core->busRead32(player(i)->core, address);
}

/** FNV-1a over every core's work RAM: browsers in one session compare it to catch a desync. */
EMSCRIPTEN_KEEPALIVE uint32_t hub_hash(void) {
	uint32_t h = 2166136261u;
	for (int i = 0; i < count; ++i) {
		const uint8_t* blocks[2];
		size_t sizes[2];
		if (platform == PLATFORM_GB) {
			struct GB* gb = player(i)->core->board;
			blocks[0] = gb->memory.wram;
			blocks[1] = gb->memory.hram;
			sizes[0] = GB_SIZE_WORKING_RAM;
			sizes[1] = GB_SIZE_HRAM;
		} else {
			struct GBA* gba = player(i)->core->board;
			blocks[0] = (const uint8_t*) gba->memory.wram;
			blocks[1] = (const uint8_t*) gba->memory.iwram;
			sizes[0] = SIZE_WORKING_RAM;
			sizes[1] = SIZE_WORKING_IRAM;
		}
		for (int b = 0; b < 2; ++b) {
			for (size_t j = 0; j < sizes[b]; ++j) {
				h = (h ^ blocks[b][j]) * 16777619u;
			}
		}
	}
	return h;
}

// ---------------------------------------------------------------- Game Boy network cable (ADR-020)
//
// The GB serial port moves one byte each way per transfer, clocked by one side.
// Over the network, each page tells the other what it is doing:
//   ready(byte): "I'm waiting (external clock) with this byte in SB"
//   clock(byte): "I'm clocking (internal clock) with this byte in SB"
// A clocking side finishes at once with the peer's ready byte if it is here,
// otherwise it holds the transfer (the game just waits, as on slow hardware)
// until one arrives. A waiting side finishes when the peer's clock arrives.
// Two clocking sides finish with each other's byte. A clock that arrives
// before this side is armed is kept for its next transfer. The CPU never stops;
// messages come in between frames (hub_cable_put) and go out via hub_cable_take.

enum CableKind { CABLE_READY = 0, CABLE_CLOCK = 1 };
enum CableState { CABLE_IDLE, CABLE_WAITING, CABLE_HOLDING };
#define CABLE_QUEUE 256

static struct {
	struct GBSIODriver d;
	enum CableState state;
	int peerReady; // byte, or -1
	int peerClock; // byte, or -1
	int lastSent; // byte this armed transfer already announced, or -1
	uint32_t sentSeq, seenSeq;
	uint32_t out[1 + CABLE_QUEUE * 3]; // [count, (kind, byte, seq)…]
	uint32_t taken[1 + CABLE_QUEUE * 3];
} cable;

static void _cableSend(int kind, uint32_t byte) {
	uint32_t n = cable.out[0];
	if (n == CABLE_QUEUE) {
		// shortcut: the page takes the queue every frame and a game sends a few messages per frame at most; past that, drop.
		return;
	}
	cable.out[1 + n * 3] = kind;
	cable.out[2 + n * 3] = byte;
	cable.out[3 + n * 3] = ++cable.sentSeq;
	cable.out[0] = n + 1;
}

// Complete the transfer with `byte` through mGBA's own bit shifting (src/gb/sio.c): SB, then the serial interrupt.
static void _cableFinish(struct GBSIO* sio, uint8_t byte) {
	sio->pendingSB = byte;
	sio->remainingBits = 8;
	mTimingDeschedule(&sio->p->timing, &sio->event);
	mTimingSchedule(&sio->p->timing, &sio->event, sio->period * (2 - sio->p->doubleSpeed));
	cable.state = CABLE_IDLE;
	cable.lastSent = -1;
}

static void _cableWriteSB(struct GBSIODriver* driver, uint8_t value) {
	UNUSED(driver);
	UNUSED(value);
}

// Runs before mGBA stores SC, after it has scheduled an internal-clock transfer.
static uint8_t _cableWriteSC(struct GBSIODriver* driver, uint8_t value) {
	struct GBSIO* sio = driver->p;
	int sb = sio->p->memory.io[GB_REG_SB];
	if (!GBRegisterSCIsEnable(value)) {
		cable.state = CABLE_IDLE;
		cable.lastSent = -1;
		return value;
	}
	// Games re-arm in tight loops; tell the peer only when something changed.
	bool repeat = cable.lastSent == sb;
	if (GBRegisterSCIsShiftClock(value)) {
		repeat = repeat && cable.state == CABLE_HOLDING;
		int peer = cable.peerClock >= 0 ? cable.peerClock : cable.peerReady;
		cable.peerClock = cable.peerReady = -1;
		if (peer >= 0) {
			_cableFinish(sio, peer);
		} else {
			mTimingDeschedule(&sio->p->timing, &sio->event);
			cable.state = CABLE_HOLDING;
			cable.lastSent = sb;
		}
		if (!repeat) {
			_cableSend(CABLE_CLOCK, sb);
		}
	} else {
		repeat = repeat && cable.state == CABLE_WAITING;
		if (cable.peerClock >= 0) {
			_cableFinish(sio, cable.peerClock);
			cable.peerClock = -1;
		} else {
			cable.state = CABLE_WAITING;
			cable.lastSent = sb;
		}
		if (!repeat) {
			_cableSend(CABLE_READY, sb);
		}
	}
	return value;
}

static void _netPlug(int on, int seat, int delay);
static void _netPut(int kind, uint32_t value);

/**
 * Plug the network cable in (1) or out (0). Unplugged, a transfer reads "nobody there" as on hardware.
 * A GBA page also says its `seat` (0 = parent, 1 = child) and the parent's `delay` in frames (see _netPlug).
 */
EMSCRIPTEN_KEEPALIVE int hub_cable_plug(int on, int seat, int delay) {
	if (count != 1 || (platform == PLATFORM_GBA && (seat < 0 || seat > 1 || delay < 1 || delay > 30))) {
		return 0;
	}
	if (platform == PLATFORM_GBA) {
		_netPlug(on, seat, delay);
		return 1;
	}
	struct GB* gb = player(0)->core->board;
	GBSIOSetDriver(&gb->sio, NULL);
	memset(&cable, 0, sizeof(cable));
	cable.peerReady = cable.peerClock = cable.lastSent = -1;
	if (on) {
		cable.d.writeSB = _cableWriteSB;
		cable.d.writeSC = _cableWriteSC;
		GBSIOSetDriver(&gb->sio, &cable.d);
	}
	return 1;
}

/**
 * A message from the peer. GB: `kind` 0 = ready, 1 = clock, `value` a byte. GBA: see _netPut.
 * Anything at or below the last `seq` seen is a duplicate.
 */
EMSCRIPTEN_KEEPALIVE void hub_cable_put(int kind, uint32_t value, uint32_t seq) {
	if (seq <= cable.seenSeq) {
		return;
	}
	if (platform == PLATFORM_GBA) {
		cable.seenSeq = seq;
		_netPut(kind, value);
		return;
	}
	int byte = value;
	if (!cable.d.p || value > 0xFF) {
		return;
	}
	cable.seenSeq = seq;
	struct GBSIO* sio = cable.d.p;
	if (kind == CABLE_CLOCK) {
		cable.peerReady = -1; // the peer's earlier ready is spent
		if (cable.state != CABLE_IDLE) {
			_cableFinish(sio, byte);
		} else {
			cable.peerClock = byte;
		}
	} else if (cable.state == CABLE_HOLDING) {
		_cableFinish(sio, byte);
	} else {
		cable.peerReady = byte;
	}
}

/** Messages for the peer since the last call, as uint32s: [count, (kind, value, seq)…]. */
EMSCRIPTEN_KEEPALIVE uint32_t* hub_cable_take(void) {
	memcpy(cable.taken, cable.out, sizeof(uint32_t) * (1 + cable.out[0] * 3));
	cable.out[0] = 0;
	return cable.taken;
}

// ---------------------------------------------------------------- GBA network cable (ADR-021)
//
// A GBA multiplayer transfer gives every GBA the same words at once, so a
// faithful relay needs a network round trip per transfer (9 per frame in
// Gen 3: far too slow, ADR-012). Instead the child's words reach the parent's
// game `delay` frames late, and both games see exactly the same transfers:
//   parent: runs its game, starting transfers as usual. Transfer j of frame f
//           completes at once with the child's word from transfer j of frame
//           f - delay (the frame waits if that hasn't arrived). It sends each
//           pair it delivered (pair), then the frame's end (end).
//   child:  delivers each parent frame's pairs, as they were, into one of its
//           own frames, spaced out so its serial interrupt keeps up, and
//           answers each with the word its game had ready (word).
// The child's game only ever sees its own words late, which Gen 3's queued
// link protocol (pokeemerald src/link.c) tolerates. One exception: transfer 0
// of each 9-transfer block carries each GBA's checksum of the previous block.
// Both games saw the same block, so the parent's checksum is the right value
// for both slots; the child's own one would be `delay` frames stale.

enum NetKind { NET_PAIR = 2, NET_END = 3, NET_WORD = 4 };
#define NET_FRAMES 64 // parent frames remembered; more than the largest delay
#define NET_RING 4096 // transfers remembered (words at the parent, pairs at the child)
#define NET_GAP 12288 // cycles between transfers delivered to the child
#define GEN3_BLOCK 9 // transfers per Gen 3 block: the checksum, then 8 data words

static struct {
	struct GBASIODriver d;
	struct mTimingEvent event;
	int seat, delay;
	// parent
	uint32_t frame; // frames run since plugged
	uint32_t index; // transfers so far in this frame
	uint32_t total; // transfers since plugged
	uint8_t counts[NET_FRAMES];
	uint32_t firsts[NET_FRAMES];
	uint16_t sent; // SIOMLT_SEND latched at the start of the transfer in flight
	bool busy;
	uint16_t words[NET_RING]; // the child's word per transfer, by `total`
	uint32_t wordsIn;
	// child
	uint32_t pairs[NET_RING];
	uint32_t pairsIn, pairsDone, batchEnd;
	uint32_t ends[NET_FRAMES]; // pairsIn at each parent frame end
	uint32_t endsIn, endsDone;
} net;

static struct GBA* _gba(void) {
	return player(0)->core->board;
}

static bool _netActive(void) {
	struct GBASIO* sio = &_gba()->sio;
	return sio->mode == SIO_MULTI && sio->activeDriver == &net.d;
}

static void _netComplete(uint16_t parentWord, uint16_t childWord) {
	struct GBASIO* sio = &_gba()->sio;
	uint16_t* io = _gba()->memory.io;
	io[REG_SIOMULTI0 >> 1] = parentWord;
	io[REG_SIOMULTI1 >> 1] = childWord;
	io[REG_SIOMULTI2 >> 1] = 0xFFFF;
	io[REG_SIOMULTI3 >> 1] = 0xFFFF;
	sio->rcnt |= 1;
	sio->siocnt = GBASIOMultiplayerClearBusy(sio->siocnt);
	sio->siocnt = GBASIOMultiplayerSetId(sio->siocnt, net.seat);
	if (GBASIOMultiplayerIsIrq(sio->siocnt)) {
		GBARaiseIRQ(_gba(), GBA_IRQ_SIO, 0);
	}
}

static void _netParentFinish(void) {
	uint32_t j = net.index++;
	uint16_t child = j ? 0 : 0xFFFF; // nothing from the child yet: "no GBA", then empty data words
	if (net.frame >= (uint32_t) net.delay) {
		uint32_t then = (net.frame - net.delay) % NET_FRAMES;
		if (j < net.counts[then]) {
			child = net.words[(net.firsts[then] + j) % NET_RING];
		}
	}
	if (j == 0 && net.frame && net.counts[(net.frame - 1) % NET_FRAMES] >= GEN3_BLOCK) {
		child = net.sent; // a block's checksum slot (see above)
	}
	net.busy = false;
	++net.total;
	_netComplete(net.sent, child);
	_cableSend(NET_PAIR, net.sent | (uint32_t) child << 16);
}

static void _netChildFinish(void) {
	uint32_t pair = net.pairs[net.pairsDone++ % NET_RING];
	uint16_t word = 0xFFFF; // not in multiplayer mode: not on the cable
	if (_netActive()) {
		word = _gba()->memory.io[REG_SIOMLT_SEND >> 1];
		_netComplete(pair, pair >> 16);
	}
	_cableSend(NET_WORD, word);
}

static void _netEvent(struct mTiming* timing, void* context, uint32_t cyclesLate) {
	UNUSED(context);
	UNUSED(cyclesLate);
	if (net.seat == 0) {
		_netParentFinish();
		return;
	}
	_netChildFinish();
	if (net.pairsDone < net.batchEnd) {
		mTimingSchedule(timing, &net.event, NET_GAP);
	}
}

static uint16_t _netWriteRegister(struct GBASIODriver* driver, uint32_t address, uint16_t value) {
	struct GBASIO* sio = driver->p;
	if (address != REG_SIOCNT) {
		return value;
	}
	sio->siocnt = GBASIOMultiplayerSetSlave(sio->siocnt, net.seat);
	sio->siocnt = GBASIOMultiplayerFillReady(sio->siocnt);
	if (net.seat == 0 && (value & 0x0080) && !net.busy) {
		net.busy = true;
		net.sent = sio->p->memory.io[REG_SIOMLT_SEND >> 1];
		mTimingDeschedule(&sio->p->timing, &net.event);
		mTimingSchedule(&sio->p->timing, &net.event, GBASIOCyclesPerTransfer[GBASIOMultiplayerGetBaud(value)][1]);
	}
	value &= 0xFF03;
	value |= sio->siocnt & 0x007C;
	return net.busy ? value | 0x0080 : value;
}

static bool _netLoad(struct GBASIODriver* driver) {
	struct GBASIO* sio = driver->p;
	sio->siocnt = GBASIOMultiplayerSetSlave(sio->siocnt, net.seat);
	sio->siocnt = GBASIOMultiplayerFillReady(sio->siocnt);
	sio->rcnt = net.seat ? sio->rcnt | 4 : sio->rcnt & ~4;
	return true;
}

static void _netPlug(int on, int seat, int delay) {
	struct GBA* gba = _gba();
	GBASIOSetDriver(&gba->sio, NULL, SIO_MULTI);
	mTimingDeschedule(&gba->timing, &net.event);
	memset(&net, 0, sizeof(net));
	memset(&cable, 0, sizeof(cable));
	if (!on) {
		return;
	}
	net.seat = seat;
	net.delay = delay;
	net.event.name = "Hub GBA network cable";
	net.event.callback = _netEvent;
	net.event.priority = 0x80;
	net.d.load = _netLoad;
	net.d.writeRegister = _netWriteRegister;
	GBASIOSetDriver(&gba->sio, &net.d, SIO_MULTI);
}

/**
 * GBA cable messages: 2 = pair (to the child; value = parent word | child word << 16),
 * 3 = end of a parent frame that had transfers (to the child), 4 = word (to the parent: the child's word for the next pair).
 */
static void _netPut(int kind, uint32_t value) {
	if (!net.d.p) {
		return;
	}
	if (net.seat == 0 && kind == NET_WORD) {
		net.words[net.wordsIn++ % NET_RING] = value;
	} else if (net.seat == 1 && kind == NET_PAIR) {
		net.pairs[net.pairsIn++ % NET_RING] = value;
	} else if (net.seat == 1 && kind == NET_END) {
		net.ends[net.endsIn++ % NET_FRAMES] = net.pairsIn;
	}
}

static bool _netBeforeFrame(void) {
	if (platform != PLATFORM_GBA || !net.d.p) {
		return true;
	}
	if (net.seat == 0) {
		if (net.frame >= (uint32_t) net.delay) {
			uint32_t then = (net.frame - net.delay) % NET_FRAMES;
			if (net.wordsIn < net.firsts[then] + net.counts[then]) {
				return false;
			}
		}
		net.index = 0;
		net.firsts[net.frame % NET_FRAMES] = net.total;
		return true;
	}
	// Child: one parent frame per frame, two when behind, like the parent's own pace.
	if (net.pairsDone == net.batchEnd && net.endsDone < net.endsIn) {
		net.batchEnd = net.ends[net.endsDone++ % NET_FRAMES];
		if (net.endsIn - net.endsDone > 2) {
			net.batchEnd = net.ends[net.endsDone++ % NET_FRAMES];
		}
		mTimingSchedule(&_gba()->timing, &net.event, NET_GAP);
	}
	return true;
}

static void _netAfterFrame(void) {
	if (platform != PLATFORM_GBA || !net.d.p || net.seat != 0) {
		return;
	}
	// shortcut: a transfer still in flight at the frame line counts for the next frame; Gen 3 finishes its block early in the frame.
	net.counts[net.frame % NET_FRAMES] = net.index > 255 ? 255 : net.index;
	if (net.index) {
		_cableSend(NET_END, 0);
	}
	++net.frame;
}

// ---------------------------------------------------------------- GBA Wireless Adapter (ADR-022)
//
// FireRed, LeafGreen and Emerald talk to the Wireless Adapter through the
// serial port in normal 32-bit mode, using Nintendo's librfu (public in the
// pret/pokeemerald decompilation: librfu_sio32id.c, librfu_stwi.c,
// librfu_intr.c, librfu_rfu.c). This emulates the adapter itself:
//   wire:    the login exchange, then `0x9966LLCC` commands and their replies
//            word by word, with the ready handshake librfu polls on SI after
//            every word; after a "change" command the adapter holds the clock
//            and wakes the game when something happens.
//   adapter: hosting, searching, connecting, sending and receiving, as
//            documented by afska (gba-link-connection docs/wireless_adapter.md).
//            Received packets queue up and the game reads one per sender at a
//            time: the network delivers in bursts, and the games number every
//            packet and give up after a few go missing.
//   air:     what adapters say to each other goes to the page as messages
//            (hub_air_take) and comes back from the room (hub_air_put). Only
//            adapters in the same room hear each other; the network is just
//            a slower radio, which librfu already retries and waits for.

enum AirOp { AIR_BEACON = 1, AIR_BEACON_OFF = 2, AIR_JOIN = 3, AIR_ACCEPT = 4, AIR_REJECT = 5, AIR_DATA = 6, AIR_LEAVE = 7 };
enum AirState { RFU_IDLE = 0, RFU_HOST_CLOSED = 1, RFU_HOST_OPEN = 2, RFU_SEARCHING = 3, RFU_CONNECTING = 4, RFU_CLIENT = 5 };
#define AIR_SEATS 16 // adapters in range (a site room, ADR-024); a link is still a host and at most 4 children
#define AIR_ALL 0xFF
#define AIR_WORDS 24 // largest message payload: a host packet (87 bytes) and its length
#define AIR_QUEUE 2048 // uint32s of outgoing messages between two takes
#define RFU_MASTER_CYCLES 256 // a 32-bit transfer at 2 MHz
#define RFU_SLAVE_CYCLES 1024 // the adapter's own clock is slower
#define RFU_BEACON_FRAMES 30 // a host repeats its beacon this often
#define RFU_BEACON_LOST 180 // and is forgotten after this long without one, as on hardware
#define RFU_PACKET 90 // bytes buffered per packet (host packets are at most 87)
#define RFU_QUEUE 32 // packets held per sender: half a second at one a frame
#define AIR_TRACE 64 // recent adapter events kept for hub_air_trace

struct AirBeacon {
	bool on;
	uint16_t id;
	uint32_t game[6]; // the host's GameConfig: serial, game name, checksum, player name
	uint32_t seen; // frame of the last beacon
};

struct AirPacket {
	uint8_t bytes[RFU_PACKET];
	int length; // 0 = nothing new
};

struct AirQueue {
	struct AirPacket packets[RFU_QUEUE];
	int head, count;
};

static struct {
	struct GBASIODriver d;
	struct mTimingEvent event;
	int seat;
	uint16_t id; // derived from the seat: unique in the room, never 0
	uint32_t frame;
	// wire: the word the adapter shifts out next, and SI
	uint32_t out;
	bool si;
	bool busy;
	bool commands; // the login exchange is over
	bool reset; // the game is resetting the adapter (RCNT through GPIO mode)
	uint16_t idSend, idRecv, idCount, idLast; // the adapter's side of librfu's Sio32ID exchange
	uint32_t req[AIR_WORDS + 2];
	int reqCmd, reqLen, reqHave; // reqLen -1 = waiting for a header
	uint32_t ack[AIR_WORDS + 4];
	int ackLen, ackNext;
	bool change; // the command being answered hands the clock to the adapter
	bool clockSlave; // the adapter holds the clock
	uint32_t wake[3]; // a wake-up command the adapter is clocking in, then its final word
	int wakeLen, wakeNext;
	uint32_t waited; // frames the game has waited for a wake-up
	bool hostAck; // a host's send-and-wait: wake it at once with who received
	// adapter
	enum AirState state;
	uint32_t config; // SystemConfig: bits 0–7 = wait timeout in frames
	uint32_t game[6];
	struct AirBeacon beacons[AIR_SEATS];
	int scanFrom; // the seat the next search poll starts at
	// host: children by slot
	int childSeat[4]; // -1 = free
	uint16_t childId[4];
	struct AirQueue fromChild[4];
	struct AirPacket lastSent; // for "resume retransmit"
	// client
	int hostSeat, slot;
	uint16_t hostId;
	int joining; // 0 = not, 1 = waiting for the host, 2 = accepted, 3 = refused
	struct AirQueue fromHost;
	// pending disconnect wake-up: slots | reason << 8
	int lost;
	// to the room
	uint32_t outbox[AIR_QUEUE];
	uint32_t taken[AIR_QUEUE + 1];
	int outLen, outCount;
	uint32_t inbox[AIR_WORDS];
	// trace: (frame, what, state, detail) per event, a ring; dump = a reason to print it
	uint32_t trace[AIR_TRACE][4];
	int traceNext, traceCount;
	bool traceDump;
	uint32_t traced[1 + AIR_TRACE * 4];
	// out of the room (hub_air_plug 2): still plugged in, with nobody in range
	bool leaving;
} air;

// `what` is a command, or 0x100 + an AirOp from the room; `detail` is the reply's first word or the sender's seat.
static void _airTrace(int what, int state, uint32_t detail) {
	uint32_t* e = air.trace[air.traceNext];
	e[0] = air.frame;
	e[1] = what;
	e[2] = state;
	e[3] = detail;
	air.traceNext = (air.traceNext + 1) % AIR_TRACE;
	if (air.traceCount < AIR_TRACE) {
		++air.traceCount;
	}
}

static void _airSend(int op, int to, const uint32_t* words, int n) {
	if (air.leaving) {
		return;
	}
	if (air.outLen + 3 + n > AIR_QUEUE) {
		return; // shortcut: the page takes the queue every frame; a full queue drops, like the radio
	}
	air.outbox[air.outLen++] = op;
	air.outbox[air.outLen++] = to;
	air.outbox[air.outLen++] = n;
	for (int i = 0; i < n; ++i) {
		air.outbox[air.outLen++] = words[i];
	}
	++air.outCount;
}

static void _airBeacon(void) {
	uint32_t words[7] = { air.id };
	memcpy(&words[1], air.game, sizeof(air.game));
	_airSend(AIR_BEACON, AIR_ALL, words, 7);
}

static int _airChildren(void) {
	int mask = 0;
	for (int s = 0; s < 4; ++s) {
		if (air.childSeat[s] >= 0) {
			mask |= 1 << s;
		}
	}
	return mask;
}

// Packets travel as a byte count, then the bytes packed little-endian into words.
static void _airPackBytes(const uint8_t* bytes, int n, uint32_t* words) {
	memset(words, 0, ((n + 3) / 4) * 4);
	for (int i = 0; i < n; ++i) {
		words[i / 4] |= (uint32_t) bytes[i] << (8 * (i % 4));
	}
}

static void _airUnpackBytes(const uint32_t* words, int n, uint8_t* bytes) {
	for (int i = 0; i < n; ++i) {
		bytes[i] = words[i / 4] >> (8 * (i % 4));
	}
}

static void _airQueuePush(struct AirQueue* q, const uint32_t* words, int bytes) {
	if (q->count == RFU_QUEUE) {
		// shortcut: a game that stops reading (paused page) loses its oldest packet; the link breaks soon anyway.
		q->head = (q->head + 1) % RFU_QUEUE;
		--q->count;
	}
	struct AirPacket* packet = &q->packets[(q->head + q->count++) % RFU_QUEUE];
	packet->length = bytes;
	_airUnpackBytes(words, bytes, packet->bytes);
}

static const struct AirPacket* _airQueuePop(struct AirQueue* q) {
	if (!q->count) {
		return NULL;
	}
	const struct AirPacket* packet = &q->packets[q->head];
	q->head = (q->head + 1) % RFU_QUEUE;
	--q->count;
	return packet;
}

static void _airSendPacket(int to, const struct AirPacket* packet) {
	uint32_t words[1 + (RFU_PACKET + 3) / 4] = { packet->length };
	_airPackBytes(packet->bytes, packet->length, &words[1]);
	_airSend(AIR_DATA, to, words, 1 + (packet->length + 3) / 4);
}

static void _airDropConnections(void) {
	for (int s = 0; s < 4; ++s) {
		if (air.childSeat[s] >= 0) {
			_airSend(AIR_LEAVE, air.childSeat[s], NULL, 0);
		}
		air.childSeat[s] = -1;
		air.fromChild[s].count = 0;
	}
	if (air.hostSeat >= 0) {
		_airSend(AIR_LEAVE, air.hostSeat, NULL, 0);
	}
	air.hostSeat = -1;
	air.joining = 0;
	air.fromHost.count = 0;
}

static void _airResetAdapter(void) {
	if (air.state == RFU_HOST_OPEN) {
		_airSend(AIR_BEACON_OFF, AIR_ALL, NULL, 0);
	}
	_airDropConnections();
	air.state = RFU_IDLE;
	air.config = 0;
	memset(air.game, 0, sizeof(air.game));
	air.lost = 0;
	air.hostAck = false;
	air.lastSent.length = 0;
}

// ---- commands

static void _airReply(int cmd, const uint32_t* words, int n) {
	air.ack[0] = 0x99660000 | n << 8 | (cmd + 0x80);
	for (int i = 0; i < n; ++i) {
		air.ack[1 + i] = words[i];
	}
	air.ackLen = 1 + n;
	air.ackNext = 0;
}

static void _airRefuse(int code) {
	uint32_t word = code;
	_airReply(0x6E, &word, 1); // 0x996601EE
}

// A packet from the game: [header, bytes…]. A host's header is its byte count; a client's is shifted to its slot.
static bool _airPacketFromGame(struct AirPacket* packet) {
	if (air.reqLen < 1) {
		return false;
	}
	int n = air.state == RFU_CLIENT ? (air.req[0] >> (8 + 5 * air.slot)) & 0x1F : air.req[0] & 0x7F;
	if (n > (air.reqLen - 1) * 4 || n > RFU_PACKET) {
		n = (air.reqLen - 1) * 4 < RFU_PACKET ? (air.reqLen - 1) * 4 : RFU_PACKET;
	}
	packet->length = n;
	_airUnpackBytes(&air.req[1], n, packet->bytes);
	return true;
}

static void _airTransmit(void) {
	struct AirPacket packet;
	if (air.state == RFU_CLIENT) {
		if (_airPacketFromGame(&packet) && packet.length) {
			_airSendPacket(air.hostSeat, &packet);
		}
		return;
	}
	if (air.reqLen >= 1 && _airPacketFromGame(&packet)) {
		air.lastSent = packet;
	}
	for (int s = 0; s < 4; ++s) {
		if (air.childSeat[s] >= 0) {
			_airSendPacket(air.childSeat[s], &air.lastSent);
		}
	}
}

static void _airReceive(void) {
	uint32_t words[AIR_WORDS + 1] = { 0 };
	uint8_t bytes[RFU_PACKET * 4];
	int n = 0;
	const struct AirPacket* packet;
	if (air.state == RFU_CLIENT) {
		if ((packet = _airQueuePop(&air.fromHost))) {
			n = packet->length;
			memcpy(bytes, packet->bytes, n);
			words[0] = n;
		}
	} else {
		for (int s = 0; s < 4; ++s) {
			if (!(packet = _airQueuePop(&air.fromChild[s]))) {
				continue;
			}
			int len = packet->length > 0x1F ? 0x1F : packet->length;
			memcpy(&bytes[n], packet->bytes, len);
			n += len;
			words[0] |= (uint32_t) len << (8 + 5 * s);
		}
	}
	if (!n) {
		_airReply(0x26, NULL, 0);
		return;
	}
	if (n > AIR_WORDS * 4) {
		n = AIR_WORDS * 4;
	}
	_airPackBytes(bytes, n, &words[1]);
	_airReply(0x26, words, 1 + (n + 3) / 4);
}

static void _airCommand(int cmd) {
	uint32_t words[AIR_WORDS];
	int n = 0;
	bool host = air.state == RFU_HOST_OPEN || air.state == RFU_HOST_CLOSED;
	air.change = false;
	switch (cmd) {
	case 0x10: // reset
		_airResetAdapter();
		break;
	case 0x11: // link status: signal per slot
		if (air.state == RFU_CLIENT) {
			words[n++] = 0xFFu << (8 * air.slot);
		} else {
			words[0] = 0;
			for (int s = 0; s < 4; ++s) {
				if (air.childSeat[s] >= 0) {
					words[0] |= 0xFFu << (8 * s);
				}
			}
			n = 1;
		}
		break;
	case 0x12: // version
		words[n++] = 8585495;
		break;
	case 0x13: // system status
		words[n++] = (air.state ? air.id : 0) | (air.state == RFU_CLIENT ? 1 << (16 + air.slot) : 0) | (uint32_t) air.state << 24;
		break;
	case 0x14: { // slot status: the next free slot, then the children
		int next = 0xFF;
		for (int s = 3; s >= 0; --s) {
			if (air.childSeat[s] < 0 && air.state == RFU_HOST_OPEN) {
				next = s;
			}
		}
		words[n++] = next;
		for (int s = 0; s < 4; ++s) {
			if (air.childSeat[s] >= 0) {
				words[n++] = air.childId[s] | s << 16;
			}
		}
		break;
	}
	case 0x15: // config status
		memcpy(words, host ? air.game : (uint32_t[6]) { 0 }, sizeof(air.game));
		n = 6;
		if (host) {
			words[n++] = air.config;
		}
		words[n++] = 257;
		break;
	case 0x16: // game config: what a host broadcasts
		memcpy(air.game, air.req, sizeof(air.game));
		if (air.state == RFU_HOST_OPEN) {
			_airBeacon();
		}
		break;
	case 0x17: // system config
		air.config = air.req[0];
		break;
	case 0x19: // host: start (open the room)
		if (air.state != RFU_IDLE && !host) {
			{ _airRefuse(1); return; }
		}
		air.state = RFU_HOST_OPEN;
		_airBeacon();
		break;
	case 0x1A: // host: poll children
	case 0x1B: // host: end (close the room, keep children)
		if (!host) {
			{ _airRefuse(1); return; }
		}
		for (int s = 0; s < 4; ++s) {
			if (air.childSeat[s] >= 0) {
				words[n++] = air.childId[s] | s << 16;
			}
		}
		if (cmd == 0x1B && air.state == RFU_HOST_OPEN) {
			_airSend(AIR_BEACON_OFF, AIR_ALL, NULL, 0);
			air.state = _airChildren() ? RFU_HOST_CLOSED : RFU_IDLE;
		}
		break;
	case 0x1C: // search: start
		if (air.state != RFU_IDLE && air.state != RFU_SEARCHING) {
			{ _airRefuse(1); return; }
		}
		air.state = RFU_SEARCHING;
		break;
	case 0x1D: { // search: poll, up to 4 hosts, 7 words each
		if (air.state != RFU_SEARCHING) {
			{ _airRefuse(1); return; }
		}
		// With more than 4 hosts in range, each poll carries on from where the last one stopped, so
		// every host gets heard (the games keep their own list of who's around). 4 or fewer: all, every poll.
		int seat = air.scanFrom;
		for (int k = 0; k < AIR_SEATS && n < 28; ++k) {
			seat = (air.scanFrom + k) % AIR_SEATS;
			struct AirBeacon* b = &air.beacons[seat];
			if (b->on && seat != air.seat) {
				words[n++] = b->id;
				memcpy(&words[n], b->game, sizeof(b->game));
				n += 6;
			}
		}
		air.scanFrom = (seat + 1) % AIR_SEATS;
		break;
	}
	case 0x1E: // search: end
		if (air.state == RFU_SEARCHING) {
			air.state = RFU_IDLE;
		}
		break;
	case 0x1F: { // connect to a host by ID
		int seat = 0;
		while (seat < AIR_SEATS && !(air.beacons[seat].on && air.beacons[seat].id == (uint16_t) air.req[0])) {
			++seat;
		}
		if (seat == AIR_SEATS || (air.state != RFU_IDLE && air.state != RFU_SEARCHING)) {
			{ _airRefuse(1); return; }
		}
		air.state = RFU_CONNECTING;
		air.hostSeat = seat;
		air.hostId = air.beacons[seat].id;
		air.joining = 1;
		uint32_t me = air.id;
		_airSend(AIR_JOIN, seat, &me, 1);
		break;
	}
	case 0x20: // connect: poll
	case 0x21: // connect: end
		if (air.state != RFU_CONNECTING && air.state != RFU_CLIENT) {
			{ _airRefuse(1); return; }
		}
		if (air.joining == 1) {
			words[n++] = cmd == 0x20 ? 0x01000000 : 0x02000000 | air.id; // waiting / gave up
			if (cmd == 0x21) {
				_airDropConnections();
				air.state = RFU_IDLE;
			}
		} else if (air.joining == 2) {
			words[n++] = air.id | air.slot << 16;
			if (cmd == 0x21) {
				air.state = RFU_CLIENT;
			}
		} else {
			words[n++] = 0x02000000 | air.id; // refused (status byte nonzero)
			if (cmd == 0x21) {
				air.hostSeat = -1;
				air.joining = 0;
				air.state = RFU_IDLE;
			}
		}
		break;
	case 0x24: // send
	case 0x25: // send, then wait
	case 0x37: // host: send the last packet again, then wait
		if (!host && air.state != RFU_CLIENT) {
			{ _airRefuse(1); return; }
		}
		if (cmd == 0x37) {
			air.reqLen = 0;
		}
		_airTransmit();
		air.change = cmd != 0x24;
		air.hostAck = air.change && host;
		break;
	case 0x26: // receive
		if (!host && air.state != RFU_CLIENT) {
			{ _airRefuse(1); return; }
		}
		_airReceive();
		return;
	case 0x27: // wait
	case 0x35:
		air.change = true;
		break;
	case 0x30: { // disconnect slots
		int mask = air.req[0];
		if (air.state == RFU_CLIENT || air.state == RFU_CONNECTING) {
			_airDropConnections();
			air.state = RFU_IDLE;
			break;
		}
		for (int s = 0; s < 4; ++s) {
			if ((mask >> s) & 1 && air.childSeat[s] >= 0) {
				_airSend(AIR_LEAVE, air.childSeat[s], NULL, 0);
				air.childSeat[s] = -1;
				air.fromChild[s].count = 0;
			}
		}
		if (air.state == RFU_HOST_CLOSED && !_airChildren()) {
			air.state = RFU_IDLE;
		}
		break;
	}
	case 0x32: // reconnect: not offered (the room keeps everyone connected)
	case 0x34:
		break;
	case 0x33:
		words[n++] = 2; // failed
		break;
	case 0x3D: // stop
		_airResetAdapter();
		break;
	default:
		{ _airRefuse(2); return; }
	}
	_airReply(cmd, words, n);
}

// ---- wire

// The adapter's side of librfu's Sio32ID login (AgbRFU_checkID): the same algorithm as the game's, as clock slave.
static void _airLogin(uint32_t word) {
	static const uint16_t nintendo[4] = { 0x494E, 0x544E, 0x4E45, 0x4F44 };
	uint16_t echo = word >> 16;
	uint16_t theirs = word;
	if (!air.idLast) {
		if (echo == air.idRecv) {
			if (air.idCount < 4) {
				if (air.idRecv == (uint16_t) ~air.idSend && theirs == (uint16_t) ~air.idRecv) {
					++air.idCount;
				}
			} else {
				// Logged in: the game's next word is a command header, which librfu needs answered 0x80000000.
				air.idLast = theirs;
				air.out = 0x80000000;
				return;
			}
		} else {
			air.idCount = 0;
		}
	}
	air.idSend = air.idCount < 4 ? nintendo[air.idCount] : 0x8001; // RFU_ID
	air.idRecv = ~theirs;
	air.out = (uint32_t) air.idSend << 16 | air.idRecv;
}

// The game clocked a word in; choose the adapter's next one.
static void _airMasterWord(uint32_t word) {
	if (!air.commands) {
		// Commands start only after a full login: librfu's login first clocks out whatever SIODATA32
		// still holds, often the reply to its last command (0x9966…).
		if (word >> 16 != 0x9966 || air.idCount < 4) {
			_airLogin(word);
			return;
		}
		air.commands = true;
		air.reqLen = -1;
	}
	if (air.ackLen && word >> 16 == 0x9966) {
		air.ackLen = 0; // the game gave up on the reply and starts a new command
		air.reqLen = -1;
	}
	if (air.ackLen) {
		// Sending a reply: the game sends 0x80000000 and takes the next word.
		if (++air.ackNext < air.ackLen) {
			air.out = air.ack[air.ackNext];
			return;
		}
		air.ackLen = 0;
		air.out = 0x80000000;
		air.reqLen = -1;
		if (air.change && air.ack[0] != 0x996601EE) {
			air.clockSlave = true;
			air.waited = 0;
		}
		return;
	}
	if (air.reqLen < 0) {
		if (word >> 16 != 0x9966) {
			air.out = 0x80000000;
			return;
		}
		air.reqCmd = word & 0xFF;
		air.reqLen = (word >> 8) & 0xFF;
		air.reqHave = 0;
		if (air.reqLen > AIR_WORDS + 2) {
			air.reqLen = AIR_WORDS + 2;
		}
	} else {
		air.req[air.reqHave++] = word;
	}
	if (air.reqHave < air.reqLen) {
		air.out = 0x80000000;
		return;
	}
	int state = air.state;
	_airCommand(air.reqCmd);
	air.out = air.ack[0];
	bool refused = air.ack[0] == 0x996601EE;
	// Data, wait and link-status commands run every frame and would push everything else out.
	bool everyFrame = air.reqCmd == 0x11 || (air.reqCmd >= 0x24 && air.reqCmd <= 0x27) || air.reqCmd == 0x35 || air.reqCmd == 0x37;
	if (refused || !everyFrame) {
		_airTrace(refused ? 0xEE00 | air.reqCmd : air.reqCmd, state, air.ackLen > 1 ? air.ack[1] : 0);
	}
	// The game stops the adapter when it leaves wireless play, link errors included.
	air.traceDump |= refused || air.reqCmd == 0x3D;
}

// What wakes a waiting game: a host's own send at once, a disconnect, new data, or the configured timeout.
static bool _airWakeReady(void) {
	if (air.hostAck) {
		air.hostAck = false;
		air.wake[0] = 0x99660128;
		air.wake[1] = _airChildren();
		air.wakeLen = 2;
	} else if (air.lost) {
		_airTrace(0x29, air.state, air.lost);
		air.wake[0] = 0x99660129;
		air.wake[1] = air.lost;
		air.wakeLen = 2;
		air.lost = 0;
	} else if (air.state == RFU_CLIENT ? air.fromHost.count > 0 : (air.fromChild[0].count | air.fromChild[1].count | air.fromChild[2].count | air.fromChild[3].count) > 0) {
		air.wake[0] = 0x99660028;
		air.wakeLen = 1;
	} else if ((air.config & 0xFF) && air.waited >= (air.config & 0xFF)) {
		air.wake[0] = 0x99660027;
		air.wakeLen = 1;
	} else {
		return false;
	}
	air.wake[air.wakeLen++] = 0x80000000; // the game's reply comes back on this one
	air.wakeNext = 0;
	return true;
}

static bool _airArmedSlave(void) {
	uint16_t siocnt = _gba()->sio.siocnt;
	return (siocnt & 0x0080) && !(siocnt & 0x0001);
}

static void _airMaybeClock(void) {
	if (!air.clockSlave || air.busy || !_airArmedSlave()) {
		return;
	}
	if (!air.wakeLen && !_airWakeReady()) {
		return;
	}
	air.busy = true;
	mTimingDeschedule(&_gba()->timing, &air.event);
	mTimingSchedule(&_gba()->timing, &air.event, RFU_SLAVE_CYCLES);
}

static void _airEvent(struct mTiming* timing, void* context, uint32_t cyclesLate) {
	UNUSED(timing);
	UNUSED(context);
	UNUSED(cyclesLate);
	struct GBA* gba = _gba();
	struct GBASIO* sio = &gba->sio;
	uint16_t* io = gba->memory.io;
	air.busy = false;
	if (sio->activeDriver != &air.d) {
		return;
	}
	uint32_t theirs = io[REG_SIODATA32_LO >> 1] | (uint32_t) io[REG_SIODATA32_HI >> 1] << 16;
	uint32_t mine;
	if (air.clockSlave) {
		mine = air.wake[air.wakeNext++];
		if (air.wakeNext == air.wakeLen) {
			air.wakeLen = 0; // the game answered: the clock goes back to it
			air.clockSlave = false;
			air.out = 0x80000000;
			air.reqLen = -1;
		}
		air.si = false;
	} else {
		mine = air.out;
		_airMasterWord(theirs);
		air.si = true;
	}
	io[REG_SIODATA32_LO >> 1] = mine;
	io[REG_SIODATA32_HI >> 1] = mine >> 16;
	sio->siocnt = (sio->siocnt & ~0x0084) | (air.si ? 0x0004 : 0);
	if (sio->siocnt & 0x4000) {
		GBARaiseIRQ(gba, GBA_IRQ_SIO, 0);
	}
}

// librfu waits on SI after every word: SI goes up after a transfer, and the adapter answers the game's SO.
static uint16_t _airWriteRegister(struct GBASIODriver* driver, uint32_t address, uint16_t value) {
	struct GBASIO* sio = driver->p;
	if (address != REG_SIOCNT) {
		return value;
	}
	bool so = value & 0x0008;
	if (value & 0x0001) {
		if (so) {
			air.si = false; // ready for the next word
		}
	} else {
		air.si = so;
	}
	value = (value & ~0x0004) | (air.si ? 0x0004 : 0);
	if ((value & 0x0080) && !air.busy) {
		if (value & 0x0001) {
			air.busy = true; // the game clocks: the word is exchanged after the transfer time
			mTimingDeschedule(&sio->p->timing, &air.event);
			mTimingSchedule(&sio->p->timing, &air.event, RFU_MASTER_CYCLES);
		} else {
			sio->siocnt = value;
			_airMaybeClock();
		}
	}
	return air.busy ? value | 0x0080 : value;
}

// librfu flips between 8- and 32-bit mode between commands; a reset (RCNT through GPIO mode) restarts the adapter.
// So does leaving normal mode: after "stop" librfu parks the port in multiplayer mode and pulses the reset from
// there, where this driver doesn't see it (mGBA has already set the new mode bits when it unloads us).
static bool _airUnload(struct GBASIODriver* driver) {
	if ((driver->p->rcnt & 0x8000) || (driver->p->siocnt & 0x2000)) {
		air.reset = true;
	}
	return true;
}

static bool _airLoad(struct GBASIODriver* driver) {
	UNUSED(driver);
	if (!air.reset) {
		return true;
	}
	air.reset = false;
	mTimingDeschedule(&_gba()->timing, &air.event);
	air.busy = false;
	air.commands = false;
	air.idSend = air.idRecv = air.idCount = air.idLast = 0;
	air.out = 0;
	air.si = false;
	air.ackLen = 0;
	air.reqLen = -1;
	air.clockSlave = false;
	air.wakeLen = 0;
	_airResetAdapter();
	return true;
}

static void _airFrame(void) {
	if (platform != PLATFORM_GBA || !air.d.p) {
		return;
	}
	++air.frame;
	for (int seat = 0; seat < AIR_SEATS; ++seat) {
		if (air.beacons[seat].on && air.frame - air.beacons[seat].seen > RFU_BEACON_LOST) {
			air.beacons[seat].on = false;
		}
	}
	if (air.state == RFU_HOST_OPEN && air.frame % RFU_BEACON_FRAMES == 0) {
		_airBeacon();
	}
	if (air.clockSlave && !air.wakeLen) {
		++air.waited;
	}
	_airMaybeClock();
}

EMSCRIPTEN_KEEPALIVE void hub_air_put(int op, int from, int n);

/**
 * Turn the wireless adapter on (1) or off (0) for room seat `seat` (0–4), or take it out of the room (2):
 * it stays plugged in and everyone else goes out of range, as if they walked away. Pulling it from a game
 * that's using it is a link error, and the games check for it at the Union Room desk and log in again on
 * the way in. On again (1) rejoins a room without restarting it under the game. GBA, one game per page.
 */
EMSCRIPTEN_KEEPALIVE int hub_air_plug(int on, int seat) {
	if (platform != PLATFORM_GBA || count != 1 || seat < 0 || seat >= AIR_SEATS) {
		return 0;
	}
	if (on == 2) {
		if (!air.d.p || air.leaving) {
			return 1;
		}
		if (air.state == RFU_HOST_OPEN) {
			_airSend(AIR_BEACON_OFF, AIR_ALL, NULL, 0);
		}
		for (int from = 0; from < AIR_SEATS; ++from) {
			bool linked = from == air.hostSeat;
			for (int s = 0; s < 4; ++s) {
				linked |= air.childSeat[s] == from;
			}
			if (linked) {
				_airSend(AIR_LEAVE, from, NULL, 0);
			}
			if (from != air.seat) {
				hub_air_put(AIR_BEACON_OFF, from, 0);
				hub_air_put(AIR_LEAVE, from, 0);
			}
		}
		air.leaving = true;
		return 1;
	}
	if (on && air.d.p) {
		air.leaving = false;
		air.seat = seat;
		air.id = 0x2000 | (seat + 1) << 8 | 0xA5; // shortcut: a game that read the old ID keeps it until it next starts wireless play; fine unless the seat changed mid-Union Room
		return 1;
	}
	struct GBA* gba = _gba();
	if (air.d.p) {
		_airResetAdapter(); // says goodbye to anyone connected
	}
	GBASIOSetDriver(&gba->sio, NULL, SIO_NORMAL_32);
	mTimingDeschedule(&gba->timing, &air.event);
	uint32_t outLen = air.outLen, outCount = air.outCount;
	uint32_t goodbye[AIR_QUEUE];
	memcpy(goodbye, air.outbox, sizeof(uint32_t) * outLen);
	memset(&air, 0, sizeof(air));
	memcpy(air.outbox, goodbye, sizeof(uint32_t) * outLen);
	air.outLen = outLen;
	air.outCount = outCount;
	air.hostSeat = -1;
	for (int s = 0; s < 4; ++s) {
		air.childSeat[s] = -1;
	}
	if (!on) {
		return 1;
	}
	air.seat = seat;
	air.id = 0x2000 | (seat + 1) << 8 | 0xA5;
	air.event.name = "Hub wireless adapter";
	air.event.callback = _airEvent;
	air.event.priority = 0x80;
	air.d.load = _airLoad;
	air.d.unload = _airUnload;
	air.d.writeRegister = _airWriteRegister;
	air.reqLen = -1;
	air.reset = true;
	GBASIOSetDriver(&gba->sio, &air.d, SIO_NORMAL_32);
	return 1;
}

/** Where the page writes a message's words before hub_air_put (up to 24). */
EMSCRIPTEN_KEEPALIVE uint32_t* hub_air_inbox(void) {
	return air.inbox;
}

/** A message from another adapter in the room: `op` (AirOp) from room seat `from`, `n` words in hub_air_inbox(). */
EMSCRIPTEN_KEEPALIVE void hub_air_put(int op, int from, int n) {
	if (!air.d.p || air.leaving || from < 0 || from >= AIR_SEATS || from == air.seat || n < 0 || n > AIR_WORDS) {
		return;
	}
	const uint32_t* w = air.inbox;
	if (op != AIR_BEACON && op != AIR_DATA) {
		_airTrace(0x100 + op, air.state, from);
	}
	switch (op) {
	case AIR_BEACON:
		if (n == 7) {
			struct AirBeacon* b = &air.beacons[from];
			b->on = true;
			b->id = w[0];
			memcpy(b->game, &w[1], sizeof(b->game));
			b->seen = air.frame;
		}
		break;
	case AIR_BEACON_OFF:
		air.beacons[from].on = false;
		break;
	case AIR_JOIN: {
		int slot = -1;
		for (int s = 0; s < 4 && air.state == RFU_HOST_OPEN; ++s) {
			if (air.childSeat[s] == from) {
				slot = s; // asked again: same slot
				break;
			}
			if (slot < 0 && air.childSeat[s] < 0) {
				slot = s;
			}
		}
		if (slot < 0 || n < 1) {
			_airSend(AIR_REJECT, from, NULL, 0);
			break;
		}
		air.childSeat[slot] = from;
		air.childId[slot] = w[0];
		uint32_t word = slot;
		_airSend(AIR_ACCEPT, from, &word, 1);
		break;
	}
	case AIR_ACCEPT:
		if (air.joining == 1 && from == air.hostSeat && n == 1) {
			air.slot = w[0] & 3;
			air.joining = 2;
		}
		break;
	case AIR_REJECT:
		if (air.joining == 1 && from == air.hostSeat) {
			air.joining = 3;
		}
		break;
	case AIR_DATA: {
		int bytes = n ? (int) w[0] : 0;
		if (bytes > (n - 1) * 4 || bytes > RFU_PACKET) {
			break;
		}
		struct AirQueue* queue = NULL;
		if (air.state == RFU_CLIENT && from == air.hostSeat) {
			queue = &air.fromHost;
		}
		for (int s = 0; s < 4; ++s) {
			if (air.childSeat[s] == from && air.state != RFU_CLIENT) {
				queue = &air.fromChild[s];
			}
		}
		if (queue && bytes) {
			_airQueuePush(queue, &w[1], bytes);
		}
		break;
	}
	case AIR_LEAVE:
		if (air.hostSeat == from && (air.state == RFU_CLIENT || air.state == RFU_CONNECTING)) {
			air.hostSeat = -1;
			air.joining = air.joining == 1 ? 3 : 0;
			if (air.state == RFU_CLIENT) {
				air.lost = 1 << air.slot; // reason 0: disconnected
				air.state = RFU_IDLE;
			}
		}
		for (int s = 0; s < 4; ++s) {
			if (air.childSeat[s] == from) {
				air.childSeat[s] = -1;
				air.fromChild[s].count = 0;
				air.lost |= 1 << s;
			}
		}
		break;
	}
	_airMaybeClock();
}

/**
 * Real games aren't proven against this adapter yet (ADR-022). When the game has
 * stopped the adapter or it refused a command since the last call: the recent
 * events, oldest first, as [count, (frame, what, state, detail)…]; else NULL.
 * `what` = command (0xEE00 | command when refused), 0x29 = disconnect wake-up,
 * 0x100 + AirOp = room message.
 */
EMSCRIPTEN_KEEPALIVE uint32_t* hub_air_trace(void) {
	if (!air.traceDump) {
		return NULL;
	}
	air.traceDump = false;
	air.traced[0] = air.traceCount;
	for (int i = 0; i < air.traceCount; ++i) {
		memcpy(&air.traced[1 + i * 4], air.trace[(air.traceNext - air.traceCount + i + AIR_TRACE) % AIR_TRACE], sizeof(air.trace[0]));
	}
	return air.traced;
}

/** Messages for the room since the last call, as uint32s: [count, (op, to seat or 255 = all, n, n words)…]. */
EMSCRIPTEN_KEEPALIVE uint32_t* hub_air_take(void) {
	air.taken[0] = air.outCount;
	memcpy(&air.taken[1], air.outbox, sizeof(uint32_t) * air.outLen);
	air.outLen = 0;
	air.outCount = 0;
	return air.taken;
}
