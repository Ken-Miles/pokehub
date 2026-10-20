using PKHeX.Core;

namespace SaveService;

public static class SaveLoader
{
    public const int Gen3Size = 0x20000;           // 128 KB flash
    public const int Gen3WithRtcFooter = Gen3Size + 16; // some emulators append RTC data
    public const int MaxSaveBytes = 512 * 1024;   // largest DS save (phase 4)

    public static string PkhexVersion =>
        typeof(SaveFile).Assembly.GetName().Version?.ToString() ?? "unknown";

    public static bool IsAcceptedSize(int length) => length is Gen3Size or Gen3WithRtcFooter;

    /// <summary>Parse a save; null when PKHeX doesn't recognise it or it isn't a supported game.</summary>
    public static SaveFile? Load(byte[] data)
    {
        var raw = data.Length == Gen3WithRtcFooter ? data[..Gen3Size] : data;
        return SaveUtil.TryGetSaveFile(raw, out var sav, null!) && sav is SAV3 ? sav : null;
    }

    /// <summary>Game family as stored in the save. Ruby and Sapphire share a format.</summary>
    public static string? Family(SaveFile sav) => sav switch
    {
        SAV3E => "E",
        SAV3RS => "RS",
        SAV3FRLG => "FRLG",
        _ => null,
    };
}
