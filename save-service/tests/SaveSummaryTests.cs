using System.Buffers.Binary;
using PKHeX.Core;
using SaveService;
using Xunit;

public class SaveSummaryTests
{
    /// <summary>
    /// A minimal valid Emerald layout: two halves of 14 sectors with ids + signature,
    /// a non-zero security key at 0xAC and data past 0x890 in the small block —
    /// which is how PKHeX tells Emerald from Ruby/Sapphire.
    /// </summary>
    static byte[] RawEmerald()
    {
        var d = new byte[SaveLoader.Gen3Size];
        for (var half = 0; half < 2; half++)
        {
            for (var i = 0; i < 14; i++)
            {
                var o = ((half * 14) + i) * 0x1000;
                BinaryPrimitives.WriteUInt16LittleEndian(d.AsSpan(o + 0xFF4), (ushort)i);
                BinaryPrimitives.WriteUInt32LittleEndian(d.AsSpan(o + 0xFF8), 0x08012025);
                BinaryPrimitives.WriteUInt32LittleEndian(d.AsSpan(o + 0xFFC), (uint)(half + 1));
            }
            var small = half * 14 * 0x1000;
            BinaryPrimitives.WriteUInt32LittleEndian(d.AsSpan(small + 0xAC), 0x12345678);
            d[small + 0x900] = 1;
        }
        return d;
    }

    static byte[] MakeEmeraldSave(out PK3 mon)
    {
        var sav = new SAV3E(RawEmerald());
        mon = new PK3
        {
            Species = (ushort)Species.Pikachu,
            PID = 0x1234ABCD,
            TID16 = 12345,
            SID16 = 54321,
            OriginalTrainerName = "ASH",
            CurrentLevel = 5,
        };
        sav.SetBoxSlotAtIndex(mon, 0, 0);
        return sav.Write(BinaryExportSetting.None).ToArray();
    }

    [Fact]
    public void Parses_a_generated_emerald_save()
    {
        var bytes = MakeEmeraldSave(out var mon);
        Assert.Equal(SaveLoader.Gen3Size, bytes.Length);

        var sav = SaveLoader.Load(bytes);
        Assert.NotNull(sav);
        var summary = SaveSummary.From(sav!);

        Assert.Equal("E", summary.Family);
        // Trainer fields aren't asserted: PKHeX ignores OT/TID setters on a save built from
        // raw bytes. Add a real (anonymised) save fixture to cover them.
        var pika = Assert.Single(summary.Pokemon);
        Assert.Equal((int)Species.Pikachu, pika.Species);
        Assert.Equal(0, pika.Box);
        Assert.Equal(0, pika.Slot);
        Assert.Equal(32, pika.Fingerprint.Length);
    }

    [Fact]
    public void Accepts_rtc_footer_and_rejects_other_sizes()
    {
        var bytes = MakeEmeraldSave(out _);
        var withFooter = bytes.Concat(new byte[16]).ToArray();
        Assert.True(SaveLoader.IsAcceptedSize(withFooter.Length));
        Assert.NotNull(SaveLoader.Load(withFooter));
        Assert.False(SaveLoader.IsAcceptedSize(1024));
    }

    [Fact]
    public void Rejects_a_half_size_gba_dump_at_a_game_boy_size()
    {
        Assert.Null(SaveLoader.Load(MakeEmeraldSave(out _)[..0x10000]));
    }

    [Fact]
    public void Fingerprint_ignores_level_changes()
    {
        MakeEmeraldSave(out var mon);
        var before = SaveSummary.Fingerprint(mon);
        mon.CurrentLevel = 50; // EXP change rewrites the checksum
        Assert.Equal(before, SaveSummary.Fingerprint(mon));
    }

    [Fact]
    public void Rejects_garbage()
    {
        Assert.Null(SaveLoader.Load(new byte[SaveLoader.Gen3Size]));
    }
}

/// <summary>
/// Gen 4–7 are catalogued but not playable yet (ADR-013). These pin down that the
/// service already knows their formats, so switching a platform on is data only.
/// Blank saves from PKHeX stand in for real ones: Gen 5 round-trips fully; blank
/// Gen 4 saves can't be written and blank Gen 6–7 saves lack the markers PKHeX
/// detects, so those need real (anonymised) fixtures before their phase starts.
/// </summary>
public class LaterGenerationTests
{
    [Theory]
    [InlineData(GameVersion.D, "DP")]
    [InlineData(GameVersion.Pt, "Pt")]
    [InlineData(GameVersion.HG, "HGSS")]
    [InlineData(GameVersion.B, "BW")]
    [InlineData(GameVersion.B2, "B2W2")]
    [InlineData(GameVersion.X, "XY")]
    [InlineData(GameVersion.OR, "ORAS")]
    [InlineData(GameVersion.SN, "SM")]
    [InlineData(GameVersion.US, "USUM")]
    public void Knows_every_gen_4_to_7_format(GameVersion version, string family)
    {
        Assert.Equal(family, SaveLoader.Family(BlankSaveFile.Get(version, "ASH")));
    }

    [Theory]
    [InlineData(GameVersion.GP)] // Let's Go: Switch, out of scope
    [InlineData(GameVersion.SW)] // Sword: Switch, out of scope
    public void Refuses_switch_formats(GameVersion version)
    {
        Assert.Null(SaveLoader.Family(BlankSaveFile.Get(version, "ASH")));
    }

    [Theory]
    [InlineData(GameVersion.B)]
    [InlineData(GameVersion.B2)]
    [InlineData(GameVersion.X)]
    [InlineData(GameVersion.OR)]
    [InlineData(GameVersion.SN)]
    [InlineData(GameVersion.US)]
    public void Accepts_each_formats_real_size(GameVersion version)
    {
        var bytes = BlankSaveFile.Get(version, "ASH").Write(BinaryExportSetting.None).ToArray();
        Assert.True(SaveLoader.IsAcceptedSize(bytes.Length), $"{version}: 0x{bytes.Length:X}");
    }

    [Fact]
    public void Parses_a_gen_5_save_end_to_end()
    {
        var blank = (SAV5)BlankSaveFile.Get(GameVersion.B2, "ASH");
        var mon = new PK5 { Species = (ushort)Species.Snivy, PID = 0xCAFE1234, TID16 = 111, SID16 = 222, OriginalTrainerName = "ASH", CurrentLevel = 5 };
        blank.SetBoxSlotAtIndex(mon, 0, 0);

        var sav = SaveLoader.Load(blank.Write(BinaryExportSetting.None).ToArray());
        Assert.NotNull(sav);
        var summary = SaveSummary.From(sav!);
        Assert.Equal(5, summary.Generation);
        Assert.Equal("B2W2", summary.Family);
        Assert.Equal("B2", summary.Version);
        Assert.Equal((int)Species.Snivy, Assert.Single(summary.Pokemon).Species);
    }

    [Fact]
    public void Gen_3_fingerprint_is_unchanged()
    {
        var g3 = new PK3 { Species = (ushort)Species.Pikachu, PID = 0x1234ABCD, TID16 = 12345, SID16 = 54321, OriginalTrainerName = "ASH" };
        // sha256("pk1:1234ABCD:12345:54321:ASH")[..32] — clone registry rows depend on it.
        Assert.Equal("e852b6b564fc4edd943205413f8260ff", SaveSummary.Fingerprint(g3));
    }

    [Fact]
    public void Fingerprint_is_the_same_across_generations()
    {
        var g3 = new PK3 { Species = (ushort)Species.Pikachu, PID = 0x1234ABCD, TID16 = 12345, SID16 = 54321, OriginalTrainerName = "ASH" };
        var g4 = new PK4 { Species = (ushort)Species.Pikachu, PID = 0x1234ABCD, TID16 = 12345, SID16 = 54321, OriginalTrainerName = "ASH" };
        Assert.Equal(SaveSummary.Fingerprint(g3), SaveSummary.Fingerprint(g4));
    }
}

public class Gen1Tests
{
    static PK1 Mon(Species species, ushort dv16, bool japanese = false) => new(japanese)
    {
        Species = (ushort)species, DV16 = dv16, TID16 = 4242, OriginalTrainerName = japanese ? "サトシ" : "ASH", CurrentLevel = 20,
    };

    static SaveSummary RoundTrip(GameVersion version, LanguageID language, string ot)
    {
        var blank = (SAV1)BlankSaveFile.Get(version, ot, language);
        var japanese = language == LanguageID.Japanese;
        blank.SetPartySlotAtIndex(Mon(Species.Kadabra, 0xA5C3, japanese), 0);
        blank.SetBoxSlotAtIndex(Mon(Species.Pikachu, 0x1234, japanese), 0, 0);
        blank.SetBoxSlotAtIndex(Mon(Species.Bulbasaur, 0xFFFF, japanese), 0, 1);

        var bytes = blank.Write(BinaryExportSetting.None).ToArray();
        Assert.Equal(0x8000, bytes.Length);
        var sav = SaveLoader.Load(bytes);
        Assert.NotNull(sav);
        return SaveSummary.From(sav!);
    }

    [Fact]
    public void Parses_an_international_red_save()
    {
        var summary = RoundTrip(GameVersion.RD, LanguageID.English, "ASH");
        Assert.Equal(1, summary.Generation);
        Assert.Equal("RBY", summary.Family);
        Assert.False(summary.Japanese);
        Assert.Equal(
            [(-1, (int)Species.Kadabra), (0, (int)Species.Pikachu), (0, (int)Species.Bulbasaur)],
            summary.Pokemon.Select(p => (p.Box, p.Species)));
        Assert.All(summary.Pokemon, p => Assert.Equal(32, p.Fingerprint.Length));
    }

    [Fact]
    public void Flags_a_japanese_green_save()
    {
        var summary = RoundTrip(GameVersion.GN, LanguageID.Japanese, "サトシ");
        Assert.Equal("RBY", summary.Family);
        Assert.True(summary.Japanese);
        Assert.Equal(3, summary.Pokemon.Count);
    }

    [Fact]
    public void Fingerprint_survives_evolution_including_trade_evolution()
    {
        var abra = SaveSummary.Fingerprint(Mon(Species.Abra, 0xA5C3));
        Assert.Equal(abra, SaveSummary.Fingerprint(Mon(Species.Kadabra, 0xA5C3)));
        Assert.Equal(abra, SaveSummary.Fingerprint(Mon(Species.Alakazam, 0xA5C3)));
        Assert.Equal(
            SaveSummary.Fingerprint(Mon(Species.Bulbasaur, 0x1111)),
            SaveSummary.Fingerprint(Mon(Species.Venusaur, 0x1111)));
    }

    [Fact]
    public void Fingerprint_differs_by_dvs_and_line()
    {
        var a = SaveSummary.Fingerprint(Mon(Species.Abra, 0xA5C3));
        Assert.NotEqual(a, SaveSummary.Fingerprint(Mon(Species.Abra, 0xA5C4)));
        Assert.NotEqual(a, SaveSummary.Fingerprint(Mon(Species.Pikachu, 0xA5C3)));
    }
}

public class Gen2Tests
{
    static PK2 Mon(Species species, ushort dv16, bool japanese = false) => new(japanese)
    {
        Species = (ushort)species, DV16 = dv16, TID16 = 4242, OriginalTrainerName = japanese ? "サトシ" : "ASH", CurrentLevel = 20,
    };

    static byte[] Save(GameVersion version, LanguageID language)
    {
        var japanese = language == LanguageID.Japanese;
        var blank = (SAV2)BlankSaveFile.Get(version, japanese ? "サトシ" : "ASH", language);
        blank.SetPartySlotAtIndex(Mon(Species.Pikachu, 0xA5C3, japanese), 0);
        blank.SetBoxSlotAtIndex(Mon(Species.Cyndaquil, 0x1234, japanese), 0, 0);
        return blank.Write(BinaryExportSetting.None).ToArray();
    }

    [Theory]
    [InlineData(GameVersion.GD, LanguageID.English, "GS", false, false)]
    [InlineData(GameVersion.SI, LanguageID.Japanese, "GS", true, false)]
    [InlineData(GameVersion.GD, LanguageID.Korean, "GS", false, true)]
    [InlineData(GameVersion.C, LanguageID.English, "C", false, false)]
    [InlineData(GameVersion.C, LanguageID.Japanese, "C", true, false)]
    public void Parses_gold_silver_and_crystal(GameVersion version, LanguageID language, string family, bool japanese, bool korean)
    {
        var sav = SaveLoader.Load(Save(version, language));
        Assert.NotNull(sav);
        var summary = SaveSummary.From(sav!);
        Assert.Equal(2, summary.Generation);
        Assert.Equal(family, summary.Family);
        Assert.Equal(japanese, summary.Japanese);
        Assert.Equal(korean, summary.Korean);
        Assert.Equal([(int)Species.Pikachu, (int)Species.Cyndaquil], summary.Pokemon.Select(p => p.Species));
    }

    [Theory]
    [InlineData(0x8000)]
    [InlineData(0x8010)]
    [InlineData(0x802C)]
    [InlineData(0x8030)]
    [InlineData(0x10000)]
    [InlineData(0x10010)]
    [InlineData(0x1002C)]
    [InlineData(0x10030)]
    public void Accepts_32k_and_64k_with_or_without_rtc_footer(int length)
    {
        var bytes = new byte[length];
        Save(GameVersion.C, LanguageID.English).AsSpan(0, Math.Min(length, 0x10000)).CopyTo(bytes);
        Assert.True(SaveLoader.IsAcceptedSize(length));
        Assert.Equal("C", SaveLoader.Family(SaveLoader.Load(bytes)!));
    }

    [Fact]
    public void Fingerprint_is_the_same_through_the_time_capsule()
    {
        foreach (var species in new[] { Species.Pikachu, Species.Raichu, Species.Clefairy, Species.Jynx, Species.Electabuzz, Species.Hitmonlee, Species.Alakazam })
        {
            var g1 = new PK1 { Species = (ushort)species, DV16 = 0xA5C3, TID16 = 4242, OriginalTrainerName = "ASH" };
            var g2 = Mon(species, 0xA5C3);
            Assert.Equal(SaveSummary.Fingerprint(g1), SaveSummary.Fingerprint(g2));
        }
        // Baby and adult share a line in Gen 2.
        Assert.Equal(SaveSummary.Fingerprint(Mon(Species.Pichu, 1)), SaveSummary.Fingerprint(Mon(Species.Raichu, 1)));
    }
}
