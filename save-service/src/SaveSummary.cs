using System.Security.Cryptography;
using System.Text;
using PKHeX.Core;

namespace SaveService;

public sealed record TrainerInfo(string Name, int Tid, int Sid);

public sealed record PokemonInfo(
    int Box,        // -1 = party
    int Slot,
    string Fingerprint,
    int Species,
    string SpeciesName,
    string Nickname,
    int Level,
    bool IsEgg,
    bool IsShiny,
    string OtName,
    int Tid,
    int Sid);

public sealed record SaveSummary(
    bool Ok,
    int Generation,
    string Family,
    TrainerInfo Trainer,
    int PlaySeconds,
    IReadOnlyList<PokemonInfo> Pokemon)
{
    public static SaveSummary From(SaveFile sav)
    {
        var list = new List<PokemonInfo>();
        for (var i = 0; i < sav.PartyCount; i++)
            Add(list, sav.GetPartySlotAtIndex(i), -1, i);
        for (var b = 0; b < sav.BoxCount; b++)
            for (var s = 0; s < sav.BoxSlotCount; s++)
                Add(list, sav.GetBoxSlotAtIndex(b, s), b, s);

        var seconds = (sav.PlayedHours * 3600) + (sav.PlayedMinutes * 60) + sav.PlayedSeconds;
        return new SaveSummary(
            true,
            sav.Generation,
            SaveLoader.Family(sav)!,
            new TrainerInfo(sav.OT, sav.TID16, sav.SID16),
            seconds,
            list);
    }

    static void Add(List<PokemonInfo> list, PKM pk, int box, int slot)
    {
        if (pk.Species == 0) return;
        list.Add(new PokemonInfo(
            box, slot,
            Fingerprint(pk),
            pk.Species,
            SpeciesName.GetSpeciesName(pk.Species, (int)LanguageID.English),
            pk.Nickname,
            pk.CurrentLevel,
            pk.IsEgg,
            pk.IsShiny,
            pk.OriginalTrainerName,
            pk.TID16,
            pk.SID16));
    }

    /// <summary>
    /// Stable identity for clone detection (FR-20): PID + TID + SID + OT name.
    /// Never includes the checksum — that changes on every EXP gain.
    /// </summary>
    public static string Fingerprint(PKM pk)
    {
        var key = $"g3:{pk.PID:X8}:{pk.TID16:D5}:{pk.SID16:D5}:{pk.OriginalTrainerName}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(key));
        return Convert.ToHexStringLower(hash)[..32];
    }
}
