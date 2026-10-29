// Pokémon Hub's DS emulator glue: melonDS (GPL-3.0, access point renamed in Dockerfile) built to WebAssembly
// (ADR-011, Phase 4 spike). This file is ours and is published with the build, as the
// GPL requires. It is the melonDS "frontend": the Platform functions plus a small C API
// for the page. Single-threaded: no JIT, software 3D, no OpenGL.
//
// FR-38: the DS's Wi-Fi reaches the page as Ethernet frames. melonDS's built-in access
// point (WifiAP) turns 802.11 into Ethernet and calls Net_SendPacket / Net_RecvPacket;
// we hand those frames to JS (Module.onNetSend) and queue frames JS pushes back.

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <deque>
#include <memory>
#include <vector>
#include <emscripten.h>

#include "NDS.h"
#include "NDSCart.h"
#include "Platform.h"
#include "Savestate.h"
#include "SPI_Firmware.h"
#include "WifiAP.h"

using namespace melonDS;

static std::unique_ptr<NDS> nds;
static bool saveWritten = false; // like mGBA: no save to report until the game writes one (a blank one isn't readable)
static std::deque<std::vector<u8>> netIn;
static u32 rgba[2][256 * 192];

namespace melonDS::Platform
{
void SignalStop(StopReason, void*) {}

// Files: only reached by features we don't use (SD cards, DSi NAND). stdio over MEMFS.
std::string GetLocalFilePath(const std::string& f) { return f; }
FileHandle* OpenFile(const std::string& path, FileMode mode)
{
    const char* m = (mode & FileMode::Write) ? ((mode & FileMode::Preserve) ? "r+b" : "w+b") : "rb";
    return reinterpret_cast<FileHandle*>(fopen(path.c_str(), m));
}
FileHandle* OpenLocalFile(const std::string& path, FileMode mode) { return OpenFile(path, mode); }
static FILE* F(FileHandle* f) { return reinterpret_cast<FILE*>(f); }
bool FileExists(const std::string& name) { FILE* f = fopen(name.c_str(), "rb"); if (f) fclose(f); return f; }
bool LocalFileExists(const std::string& name) { return FileExists(name); }
bool CheckFileWritable(const std::string&) { return false; }
bool CheckLocalFileWritable(const std::string&) { return false; }
bool CloseFile(FileHandle* f) { return fclose(F(f)) == 0; }
bool IsEndOfFile(FileHandle* f) { return feof(F(f)); }
bool FileReadLine(char* s, int n, FileHandle* f) { return fgets(s, n, F(f)); }
u64 FilePosition(FileHandle* f) { return ftell(F(f)); }
bool FileSeek(FileHandle* f, s64 off, FileSeekOrigin o)
{
    return fseek(F(f), off, o == FileSeekOrigin::Start ? SEEK_SET : o == FileSeekOrigin::Current ? SEEK_CUR : SEEK_END) == 0;
}
void FileRewind(FileHandle* f) { rewind(F(f)); }
u64 FileRead(void* d, u64 s, u64 c, FileHandle* f) { return fread(d, s, c, F(f)); }
bool FileFlush(FileHandle* f) { return fflush(F(f)) == 0; }
u64 FileWrite(const void* d, u64 s, u64 c, FileHandle* f) { return fwrite(d, s, c, F(f)); }
u64 FileWriteFormatted(FileHandle* f, const char* fmt, ...)
{
    va_list a; va_start(a, fmt); int n = vfprintf(F(f), fmt, a); va_end(a);
    return n < 0 ? 0 : n;
}
u64 FileLength(FileHandle* f) { long p = ftell(F(f)); fseek(F(f), 0, SEEK_END); long n = ftell(F(f)); fseek(F(f), p, SEEK_SET); return n; }

void Log(LogLevel level, const char* fmt, ...)
{
    if (level == LogLevel::Debug) return;
    va_list a; va_start(a, fmt); vprintf(fmt, a); va_end(a);
}

// One thread: nothing in the core creates threads without the JIT or threaded 3D.
Thread* Thread_Create(std::function<void()>) { Log(LogLevel::Error, "hub: threads are not supported\n"); abort(); }
void Thread_Free(Thread*) {}
void Thread_Wait(Thread*) {}
Semaphore* Semaphore_Create() { return reinterpret_cast<Semaphore*>(1); }
void Semaphore_Free(Semaphore*) {}
void Semaphore_Reset(Semaphore*) {}
void Semaphore_Wait(Semaphore*) {}
bool Semaphore_TryWait(Semaphore*, int) { return true; }
void Semaphore_Post(Semaphore*, int) {}
Mutex* Mutex_Create() { return reinterpret_cast<Mutex*>(1); }
void Mutex_Free(Mutex*) {}
void Mutex_Lock(Mutex*) {}
void Mutex_Unlock(Mutex*) {}
bool Mutex_TryLock(Mutex*) { return true; }
void Sleep(u64) {}
u64 GetMSCount() { return (u64)emscripten_get_now(); }
u64 GetUSCount() { return (u64)(emscripten_get_now() * 1000); }

void WriteNDSSave(const u8*, u32, u32, u32, void*) { saveWritten = true; EM_ASM({ Module.onSave && Module.onSave(); }); }
void WriteGBASave(const u8*, u32, u32, u32, void*) {}
// FR-39: the DS wrote its Wi-Fi settings (incl. its Nintendo WFC user ID); the page keeps them per account.
void WriteFirmware(const Firmware&, u32, u32, void*) { EM_ASM({ Module.onFirmware && Module.onFirmware(); }); }
void WriteDateTime(int, int, int, int, int, int, void*) {}

// Local wireless (FR-43) is not built: no other DS is ever in range.
void MP_Begin(void*) {}
void MP_End(void*) {}
int MP_SendPacket(u8*, int len, u64, void*) { return len; }
int MP_RecvPacket(u8*, u64*, void*) { return 0; }
int MP_SendCmd(u8*, int len, u64, void*) { return len; }
int MP_SendReply(u8*, int len, u64, u16, void*) { return len; }
int MP_SendAck(u8*, int len, u64, void*) { return len; }
int MP_RecvHostPacket(u8*, u64*, void*) { return 0; }
u16 MP_RecvReplies(u8*, u64, u16, void*) { return 0; }

int Net_SendPacket(u8* data, int len, void*)
{
    EM_ASM({ Module.onNetSend && Module.onNetSend($0, $1); }, data, len);
    return len;
}
int Net_RecvPacket(u8* data, void*)
{
    if (netIn.empty()) return 0;
    std::vector<u8>& f = netIn.front();
    int len = (int)f.size();
    memcpy(data, f.data(), len);
    netIn.pop_front();
    return len;
}

void Camera_Start(int, void*) {}
void Camera_Stop(int, void*) {}
void Camera_CaptureFrame(int, u32*, int, int, bool, void*) {}
void Mic_Start(void*) {}
void Mic_Stop(void*) {}
int Mic_ReadInput(s16*, int, void*) { return 0; }
AACDecoder* AAC_Init() { return nullptr; }
void AAC_DeInit(AACDecoder*) {}
bool AAC_Configure(AACDecoder*, int, int) { return false; }
bool AAC_DecodeFrame(AACDecoder*, const void*, int, void*, int) { return false; }
bool Addon_KeyDown(KeyType, void*) { return false; }
void Addon_RumbleStart(u32, void*) {}
void Addon_RumbleStop(void*) {}
float Addon_MotionQuery(MotionQueryType, void*) { return 0; }
DynamicLibrary* DynamicLibrary_Load(const char*) { return nullptr; }
void DynamicLibrary_Unload(DynamicLibrary*) {}
void* DynamicLibrary_LoadFunction(DynamicLibrary*, const char*) { return nullptr; }
}

extern "C" {

// FR-07: the same C API as our mGBA core (emulator/src/hub.c), so the product player
// (public/emulator/player.js) drives both. One DS per page: `core` is always 0.
static int sampleRate = 48000;
static double rtcEpochMs = 0; // 0 = the wall clock
static s16 audio[2 * 4096];

/** Boots `rom` (copied; the page's buffer is freed here) with `save`, `mac` and `wifi` copied (any may be null). */
static int boot(u8* rom, u32 romLen, const u8* save, u32 saveLen, const u8* mac, const u8* wifi);

EMSCRIPTEN_KEEPALIVE int hub_init(int, int n, int rate, int rtcMode, double epochMs)
{
    if (n != 1) return 0;
    sampleRate = rate > 0 ? rate : 48000;
    rtcEpochMs = rtcMode ? epochMs : 0;
    return 1;
}

/** Built-in BIOS and generated firmware (nothing of Nintendo's, NFR-01). Takes ownership of `rom`; the page frees `save`. */
EMSCRIPTEN_KEEPALIVE int hub_load(int, u8* rom, int romLen, const u8* save, int saveLen, const void*, int)
{
    return boot(rom, romLen, save, saveLen, nullptr, nullptr);
}

EMSCRIPTEN_KEEPALIVE void hub_start(int) {}

/**
 * The spike's boot (spikes/ds-wifi, /emulator/ds/spike.html): `mac` is the site account's
 * DS MAC (6 bytes, FR-39), or null for the default. `wifi` is the account's saved Wi-Fi
 * settings (HUB_WIFI_BYTES, from hub_wifi_settings in an earlier session), or null for
 * fresh ones. Takes ownership of `rom` and `save` (malloc'd by the page).
 */
#define HUB_WIFI_BYTES (3 * 256) // the three access point blocks; the WFC user ID lives there
EMSCRIPTEN_KEEPALIVE int hub_boot(u8* rom, u32 romLen, u8* save, u32 saveLen, const u8* mac, const u8* wifi)
{
    int ok = boot(rom, romLen, save, saveLen, mac, wifi);
    free(save);
    return ok;
}

static int boot(u8* rom, u32 romLen, const u8* save, u32 saveLen, const u8* mac, const u8* wifi)
{
    NDSArgs args;
    args.JIT = std::nullopt;
    if (mac)
    {
        auto& header = args.Firmware.GetHeader();
        memcpy(header.MacAddr.data(), mac, 6);
        header.MacAddr[0] &= 0xFE; // never a multicast MAC; keeps the locally administered bit the gateway expects
        header.UpdateChecksum();
    }
    if (wifi) memcpy(args.Firmware.GetWifiAccessPointPosition(), wifi, HUB_WIFI_BYTES);
    // Connections saved for the access point's old names (melonDS presets connection 1 to
    // "melonAP") point at its name in this build, so new and existing accounts both find it.
    for (auto& ap : args.Firmware.GetAccessPoints())
        if (!strncmp(ap.SSID, "melonAP", sizeof(ap.SSID)) || !strncmp(ap.SSID, "PokemonHub5G", sizeof(ap.SSID)))
        {
            memset(ap.SSID, 0, sizeof(ap.SSID));
            strncpy(ap.SSID, WifiAP::APName, sizeof(ap.SSID));
            if (ap.SSIDLength) ap.SSIDLength = strlen(WifiAP::APName);
        }
    args.Firmware.UpdateChecksums();
    nds = std::make_unique<NDS>(std::move(args), nullptr);
    nds->SPU.SetOutputSampleRate(sampleRate);

    NDSCart::NDSCartArgs cartArgs;
    saveWritten = save && saveLen;
    if (save && saveLen)
    {
        cartArgs.SRAM = std::make_unique<u8[]>(saveLen);
        memcpy(cartArgs.SRAM.get(), save, saveLen);
        cartArgs.SRAMLength = saveLen;
    }
    // shortcut: briefly holds the game twice (512 MB for B2W2); hand melonDS the page's buffer if heaps run out.
    auto romCopy = std::make_unique<u8[]>(romLen);
    memcpy(romCopy.get(), rom, romLen);
    free(rom);
    auto cart = NDSCart::ParseROM(std::move(romCopy), romLen, nullptr, std::move(cartArgs));
    if (!cart) { nds.reset(); return 0; }

    nds->SetNDSCart(std::move(cart));
    nds->Reset();
    nds->SetupDirectBoot("game.nds"); // the built-in BIOS can only direct-boot
    // The DS clock: Gen 4–5 use it for day/night and seasons.
    time_t t = rtcEpochMs ? (time_t)(rtcEpochMs / 1000) : time(nullptr);
    tm* lt = localtime(&t);
    nds->RTC.SetDateTime(lt->tm_year + 1900, lt->tm_mon + 1, lt->tm_mday, lt->tm_hour, lt->tm_min, lt->tm_sec);
    nds->Start();
    netIn.clear();
    return 1;
}

/** Pressed buttons, bit per button: A B Select Start Right Left Up Down R L X Y. */
EMSCRIPTEN_KEEPALIVE void hub_set_keys(int, u32 pressed) { nds->SetKeyMask(~pressed & 0xFFF); }
/** The bottom screen, 0–255 × 0–191. */
EMSCRIPTEN_KEEPALIVE void hub_touch(int x, int y) { nds->TouchScreen(x, y); }
EMSCRIPTEN_KEEPALIVE void hub_release() { nds->ReleaseScreen(); }

/**
 * FR-39, ADR-027: the DS signs in at https://nas.nintendowifi.net, and no certificate of
 * ours passes its check without Nintendo's keys. Like AltWFC's nossl patch, rewrite the
 * URL to http:// in RAM once the game has unpacked its Wi-Fi code (it's compressed in the
 * game file). The game file itself is never changed. Returns the number of rewrites.
 */
static int nosslPatches = 0;
static void patchNasUrl()
{
    static const char https[] = "https://nas";
    u8* ram = nds->MainRAM;
    u32 size = nds->MainRAMMask + 1;
    for (u8* p = ram; (p = (u8*)memmem(p, ram + size - p, https, sizeof(https) - 1)); )
    {
        u8* end = (u8*)memchr(p, 0, ram + size - p);
        if (!end) break;
        memmove(p + 4, p + 5, end - (p + 5) + 1); // drop the 's', NUL included
        nosslPatches++;
    }
}

/**
 * Runs one frame. Both screens are then at hub_video(0) as one 256×384 RGBA image, top
 * screen first, and the frame's sound at hub_audio() (Module.audioFrames stereo samples).
 */
EMSCRIPTEN_KEEPALIVE int hub_run_frame()
{
    nds->RunFrame();
    // Overlays come and go, so look again twice a second (~0.5 ms over 4 MB).
    static u32 frame = 0;
    if (++frame % 30 == 0) patchNasUrl();
    int fb = nds->GPU.FrontBuffer;
    for (int s = 0; s < 2; s++)
    {
        const u32* src = nds->GPU.Framebuffer[fb][s].get();
        if (!src) continue;
        // melonDS writes 0xAARRGGBB words; canvas wants R, G, B, A bytes.
        for (int i = 0; i < 256 * 192; i++)
        {
            u32 p = src[i];
            rgba[s][i] = 0xFF000000 | ((p & 0xFF) << 16) | (p & 0xFF00) | ((p >> 16) & 0xFF);
        }
    }
    int n = nds->SPU.ReadOutput(audio, 4096);
    while (nds->SPU.ReadOutput(audio + 2 * 4000, 96) > 0); // more than a frame's worth: drop it
    EM_ASM({ Module.audioFrames = $0; }, n);
    return 1;
}
EMSCRIPTEN_KEEPALIVE u32* hub_video(int) { return &rgba[0][0]; }
EMSCRIPTEN_KEEPALIVE int hub_video_size(int) { return 256 << 16 | 384; }
EMSCRIPTEN_KEEPALIVE s16* hub_audio() { return audio; }
EMSCRIPTEN_KEEPALIVE u32 hub_stalls() { return 0; }
EMSCRIPTEN_KEEPALIVE u32 hub_hash() { return 0; } // only linked pages ask, and DS pages are never linked

/** The save memory's size (512 KB for Gen 4–5), or 0 before there is a save; the bytes are at hub_save_data(). */
EMSCRIPTEN_KEEPALIVE int hub_save_read(int) { return saveWritten && nds->GetNDSSave() ? nds->GetNDSSaveLength() : 0; }
EMSCRIPTEN_KEEPALIVE u8* hub_save_data() { return nds->GetNDSSave(); }

/** Save states stay in the page's memory (ADR-016). hub_state_size makes the state; hub_state_save copies it out. */
static std::unique_ptr<Savestate> state;
EMSCRIPTEN_KEEPALIVE int hub_state_size(int)
{
    state = std::make_unique<Savestate>();
    if (state->Error || !nds->DoSavestate(state.get()) || state->Error) { state.reset(); return 0; }
    state->Finish();
    return state->Length();
}
EMSCRIPTEN_KEEPALIVE int hub_state_save(int, void* out)
{
    if (!state) return 0;
    memcpy(out, state->Buffer(), state->Length());
    state.reset();
    return 1;
}
EMSCRIPTEN_KEEPALIVE int hub_state_load(int, void* in, int len)
{
    Savestate s(in, len, false);
    return !s.Error && nds->DoSavestate(&s) && !s.Error;
}

EMSCRIPTEN_KEEPALIVE int hub_nossl_patches() { return nosslPatches; }
EMSCRIPTEN_KEEPALIVE u8* hub_main_ram() { return nds->MainRAM; }
/** The DS's current Wi-Fi settings, HUB_WIFI_BYTES long; read after Module.onFirmware. */
EMSCRIPTEN_KEEPALIVE u8* hub_wifi_settings() { return nds->GetFirmware().GetWifiAccessPointPosition(); }

/** A frame from the network tunnel, for the DS (FR-38). Copied; the page frees `data`. */
EMSCRIPTEN_KEEPALIVE void hub_net_push(const u8* data, int len)
{
    if (len <= 0 || len > 2048 || netIn.size() >= 256) return; // WifiAP's buffer is 2048; drop floods
    netIn.emplace_back(data, data + len);
}

}
