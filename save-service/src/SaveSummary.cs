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
    string Version, // game the save was made in (E, FR, OR, US…): how 3DS slots identify their game
    bool Japanese,  // Game Boy Japanese, Korean and international carts can't link, so their saves must never mix
    bool Korean,
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
            sav.Version.ToString(),
            sav.Language == (int)LanguageID.Japanese,
            sav.Language == (int)LanguageID.Korean,
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
    /// Never includes the checksum — that changes on every EXP gain. The same for
    /// every generation, because Pal Park, Poké Transfer and Bank keep all four,
    /// so a Pokémon keeps its identity if moving it up a generation is ever allowed.
    /// Game Boy (Gen 1–2) Pokémon have no PID or SID, so they use the evolution line's
    /// base species + DVs instead (base species, so evolving — trade evolutions
    /// included — keeps it). Gen 2's tree for both, so a Pikachu keeps its identity
    /// through the Time Capsule even though Gen 2 adds Pichu.
    /// </summary>
    public static string Fingerprint(PKM pk)
    {
        var key = pk is GBPKM gb
            ? $"gb1:{BaseSpeciesGB(gb.Species)}:{gb.DV16:X4}:{gb.TID16:D5}:{gb.OriginalTrainerName}"
            : $"pk1:{pk.PID:X8}:{pk.TID16:D5}:{pk.SID16:D5}:{pk.OriginalTrainerName}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(key));
        return Convert.ToHexStringLower(hash)[..32];
    }

    static ushort BaseSpeciesGB(ushort species)
    {
        // Gen 1–2 lines never branch backwards, so the first pre-evolution is the only one.
        while (EvolutionTree.Evolves2.Reverse.GetPreEvolutions(species, 0).FirstOrDefault() is { Item1: > 0 } pre)
            species = pre.Item1;
        return species;
    }
}
