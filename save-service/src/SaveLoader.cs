using PKHeX.Core;

namespace SaveService;

public static class SaveLoader
{
    public const int Gen3Size = 0x20000;                // 128 KB flash
    public const int Gen3WithRtcFooter = Gen3Size + 16; // some emulators append RTC data

    // Exact sizes per platform; mirrors PLATFORMS in lib/games.ts.
    static readonly HashSet<int> AcceptedSizes =
    [
        // Game Boy (Gen 1–2): 32 KB, or 64 KB for Gen 2, each optionally with an
        // emulator RTC footer (PKHeX's SaveHandlerFooterRTC strips those).
        0x8000, 0x8010, 0x802C, 0x8030,
        0x10000, 0x10010, 0x1002C, 0x10030,
        Gen3Size, Gen3WithRtcFooter, // GBA
        0x80000,                     // DS (Gen 4–5)
        0x65600, 0x76000,            // 3DS: X/Y, Omega Ruby/Alpha Sapphire
        0x6BE00, 0x6CC00,            // 3DS: Sun/Moon, Ultra Sun/Ultra Moon
    ];

    public static readonly int MaxSaveBytes = AcceptedSizes.Max();

    public static string PkhexVersion =>
        typeof(SaveFile).Assembly.GetName().Version?.ToString() ?? "unknown";

    public static bool IsAcceptedSize(int length) => AcceptedSizes.Contains(length);

    /// <summary>Parse a save; null when PKHeX doesn't recognise it or it isn't a game the hub knows.</summary>
    public static SaveFile? Load(byte[] data)
    {
        var raw = data.Length == Gen3WithRtcFooter ? data[..Gen3Size] : data;
        if (!SaveUtil.TryGetSaveFile(raw, out var sav, null!) || Family(sav) is null) return null;
        // Game Boy sizes are for Game Boy saves only, not e.g. a half-size GBA flash dump.
        return raw.Length < Gen3Size && sav.Generation > 2 ? null : sav;
    }

    // Save formats the hub knows (SaveFamily in lib/games.ts). Exact types only, so
    // look-alikes such as the OR/AS demo, Let's Go or Battle Revolution stay out.
    static readonly Dictionary<Type, string> Families = new()
    {
        [typeof(SAV1)] = "RBY",
        [typeof(SAV3RS)] = "RS",
        [typeof(SAV3E)] = "E",
        [typeof(SAV3FRLG)] = "FRLG",
        [typeof(SAV4DP)] = "DP",
        [typeof(SAV4Pt)] = "Pt",
        [typeof(SAV4HGSS)] = "HGSS",
        [typeof(SAV5BW)] = "BW",
        [typeof(SAV5B2W2)] = "B2W2",
        [typeof(SAV6XY)] = "XY",
        [typeof(SAV6AO)] = "ORAS",
        [typeof(SAV7SM)] = "SM",
        [typeof(SAV7USUM)] = "USUM",
    };

    /// <summary>Game family as stored in the save. Paired versions (Ruby/Sapphire…) share a format.</summary>
    public static string? Family(SaveFile sav) => sav is SAV2
        ? (sav.Version == GameVersion.C ? "C" : "GS") // Gold/Silver and Crystal share SAV2
        : Families.GetValueOrDefault(sav.GetType());
}
