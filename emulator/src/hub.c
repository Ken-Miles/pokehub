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
#include <mgba/gba/core.h>
#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/sio/lockstep.h>
#include <mgba-util/vfs.h>

#define MAX_PLAYERS 4
#define WIDTH 240
#define HEIGHT 160
#define AUDIO_MAX 4096
// A core that gets nothing done for this many passes means the cable is stuck.
#define STALL_PASSES 200000

struct Player {
	struct mCore* core;
	struct GBASIOLockstepNode node;
	color_t video[WIDTH * HEIGHT];
	void* rom;
	// Lockstep bookkeeping, as in mGBA's Qt MultiplayerController::Player.
	int awake;
	int32_t cyclesPosted;
	unsigned waitMask;
};

static struct Player players[MAX_PLAYERS];
static int count;
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

/** Create `n` cores. `rtcMode`: 0 = wall clock (solo), 1 = fixed start `rtcEpochMs`, advancing with emulated time (linked). */
EMSCRIPTEN_KEEPALIVE int hub_init(int n, int sampleRate, int rtcMode, double rtcEpochMs) {
	if (count || n < 1 || n > MAX_PLAYERS) {
		return 0;
	}
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
		p->core = GBACoreCreate();
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
		mCoreLoadConfig(p->core);
		p->core->setVideoBuffer(p->core, p->video, WIDTH);
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
EMSCRIPTEN_KEEPALIVE int hub_run_frame(void) {
	if (count == 1) {
		player(0)->core->runFrame(player(0)->core);
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

/** Player `i`'s last frame as RGBA (mGBA leaves the alpha byte empty). */
EMSCRIPTEN_KEEPALIVE void* hub_video(int i) {
	color_t* px = player(i)->video;
	for (int j = 0; j < WIDTH * HEIGHT; ++j) {
		px[j] |= 0xFF000000;
	}
	return px;
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

/** FNV-1a over every GBA's work RAM: browsers in one session compare it to catch a desync. */
EMSCRIPTEN_KEEPALIVE uint32_t hub_hash(void) {
	uint32_t h = 2166136261u;
	for (int i = 0; i < count; ++i) {
		struct GBA* gba = player(i)->core->board;
		const uint8_t* blocks[2] = { (const uint8_t*) gba->memory.wram, (const uint8_t*) gba->memory.iwram };
		const size_t sizes[2] = { SIZE_WORKING_RAM, SIZE_WORKING_IRAM };
		for (int b = 0; b < 2; ++b) {
			for (size_t j = 0; j < sizes[b]; ++j) {
				h = (h ^ blocks[b][j]) * 16777619u;
			}
		}
	}
	return h;
}
