// Make per-bot Gen 3 saves from one base save (FR-36): bot<n> becomes male trainer
// T<nnnn> with TID = SID = n, and every Pokémon in the party, boxes and daycare that the
// player caught (OT = the original trainer) is re-stamped with that OT. Other Pokémon —
// events and in-game trades, whose fixed OT is part of their legality — keep their OT.
//
// --original names an unedited copy of the base save, used to tell whose each Pokémon
// is when the base has had its OTs edited; those Pokémon are restored from it.
// Needs .NET 10, so run it in Docker:
//
//   docker run --rm -v "$PWD":/w -v ~/Downloads/poke:/in:ro -w /w mcr.microsoft.com/dotnet/sdk:10.0 \
//     dotnet run scripts/bot-saves.cs -- "/in/Pokemon - Emerald Version (USA, Europe).sav" bots/saves 5 16 \
//     --original "/in/Pokemon - Emerald Version (USA, Europe).sav copy"
#:package PKHeX.Core@26.10.18
using PKHeX.Core;

var argv = args.ToList();
var o = argv.IndexOf("--original");
var originalPath = o < 0 ? argv.ElementAtOrDefault(0) : argv.ElementAtOrDefault(o + 1);
if (o >= 0) argv.RemoveRange(o, Math.Min(2, argv.Count - o));
if (argv.Count < 3 || originalPath is null) { Console.Error.WriteLine("Usage: bot-saves.cs <base.sav> <out-dir> <n> [<n> …] [--original <unedited.sav>]"); return 1; }
var baseBytes = File.ReadAllBytes(argv[0]);

SaveFile Load(byte[] data) => SaveUtil.TryGetSaveFile(data, out var s, null!) && s.Generation == 3
    ? s : throw new InvalidDataException("not a Gen 3 save");

// Every Pokémon in the save, with where it is and how to write it back.
IEnumerable<(string Where, PKM Pk, Action<PKM> Save)> Mons(SaveFile sav)
{
    foreach (var i in Enumerable.Range(0, sav.PartyCount))
        yield return ($"party {i + 1}", sav.GetPartySlotAtIndex(i), p => sav.SetPartySlotAtIndex(p, i, EntityImportSettings.None));
    foreach (var b in Enumerable.Range(0, sav.BoxCount))
        foreach (var s in Enumerable.Range(0, sav.BoxSlotCount))
        {
            var pk = sav.GetBoxSlotAtIndex(b, s);
            if (pk.Species != 0) yield return ($"box {b + 1} slot {s + 1}", pk, p => sav.SetBoxSlotAtIndex(p, b, s, EntityImportSettings.None));
        }
    if (sav is IDaycareStorage daycare)
        foreach (var i in Enumerable.Range(0, daycare.DaycareSlotCount).Where(daycare.IsDaycareOccupied))
        {
            var slot = daycare.GetDaycareSlot(i); // raw stored (encrypted) PK3 inside the save buffer
            yield return ($"daycare {i + 1}", sav.GetDecryptedPKM(slot.Span[..sav.SIZE_STORED].ToArray()), p => sav.SetSlotFormatStored(p, slot.Span[..sav.SIZE_STORED], EntityImportSettings.None));
        }
}

// Each Pokémon as it was in the original save, matched by PID + species so moved slots still match.
var original = Load(File.ReadAllBytes(originalPath));
var originals = Mons(original).Select(m => m.Pk).DistinctBy(p => (p.PID, p.Species)).ToDictionary(p => (p.PID, p.Species));
bool IsPlayers(PKM p) => p.OriginalTrainerName == original.OT && p.TID16 == original.TID16 && p.SID16 == original.SID16;
PKM? Original(PKM p) => originals.GetValueOrDefault((p.PID, p.Species));

Console.WriteLine($"Original trainer {original.OT} {original.TID16:00000}/{original.SID16:00000}. Kept with their own OT:");
foreach (var (where, pk, _) in Mons(Load((byte[])baseBytes.Clone())))
    if (Original(pk) is not { } orig) Console.WriteLine($"  {where}: {(Species)pk.Species} — not in the original save, left as is");
    else if (!IsPlayers(orig)) Console.WriteLine($"  {where}: {(Species)pk.Species} \"{pk.Nickname}\" Lv{pk.CurrentLevel} — OT {orig.OriginalTrainerName} {orig.TID16:00000}/{orig.SID16:00000}");

foreach (var n in argv.Skip(2).Select(int.Parse))
{
    if (n is < 1 or > 9999) throw new ArgumentException($"{n}: bot numbers are 1 … 9999");
    var sav = Load((byte[])baseBytes.Clone());

    var name = $"T{n:0000}";
    sav.OT = name;
    sav.TID16 = sav.SID16 = (ushort)n;
    sav.Gender = 0;

    int stamped = 0, kept = 0, shinyFlips = 0;
    foreach (var (_, pk, save) in Mons(sav))
    {
        var orig = Original(pk);
        if (orig is null) continue;
        if (!IsPlayers(orig)) { save(orig.Clone()); kept++; continue; }
        var wasShiny = orig.IsShiny;
        pk.OriginalTrainerTrash.Fill(0xFF); // the game pads names with 0xFF; leftovers of a longer name fail legality
        pk.OriginalTrainerName = name;
        pk.TID16 = pk.SID16 = (ushort)n;
        pk.OriginalTrainerGender = 0;
        pk.RefreshChecksum();
        save(pk);
        stamped++;
        if (pk.IsShiny != wasShiny) shinyFlips++; // Gen 3 shininess is PID ^ TID ^ SID
    }

    var outPath = Path.Combine(argv[1], $"bot{n}.sav");
    File.WriteAllBytes(outPath, sav.Write().ToArray());

    // Read it back: the trainer, the player's Pokémon carry the new OT, the rest their original one.
    var check = Load(File.ReadAllBytes(outPath));
    bool Ok(PKM p) => p.ChecksumValid && (Original(p) is not { } orig
        || (IsPlayers(orig) ? p.OriginalTrainerName == name && p.TID16 == n && p.SID16 == n && p.OriginalTrainerGender == 0
                            : p.OriginalTrainerName == orig.OriginalTrainerName && p.TID16 == orig.TID16 && p.SID16 == orig.SID16));
    if (check.OT != name || check.TID16 != n || check.SID16 != n || check.Gender != 0 || !Mons(check).All(m => Ok(m.Pk)))
        throw new InvalidDataException($"{outPath} didn't round-trip");

    Console.WriteLine($"{outPath}: {name} {n:00000}/{n:00000}, {stamped} Pokémon re-stamped, {kept} kept their OT, shininess changed on {shinyFlips}");
}
return 0;
