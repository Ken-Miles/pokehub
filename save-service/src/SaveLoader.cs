using PKHeX.Core;

namespace SaveService;

public static class SaveLoader
{
    public const int Gen3Size = 0x20000;                // 128 KB flash
    public const int Gen3WithRtcFooter = Gen3Size + 16; // some emulators append RTC data

    // Exact sizes per platform; mirrors PLATFORMS in lib/games.ts.
    static readonly HashSet<int> AcceptedSizes =
    [
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
        return SaveUtil.TryGetSaveFile(raw, out var sav, null!) && Family(sav) is not null ? sav : null;
    }

    // Save formats the hub knows (SaveFamily in lib/games.ts). Exact types only, so
    // look-alikes such as the OR/AS demo, Let's Go or Battle Revolution stay out.
    static readonly Dictionary<Type, string> Families = new()
    {
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
    public static string? Family(SaveFile sav) => Families.GetValueOrDefault(sav.GetType());
}
