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
    public void Fingerprint_is_the_same_across_generations()
    {
        var g3 = new PK3 { Species = (ushort)Species.Pikachu, PID = 0x1234ABCD, TID16 = 12345, SID16 = 54321, OriginalTrainerName = "ASH" };
        var g4 = new PK4 { Species = (ushort)Species.Pikachu, PID = 0x1234ABCD, TID16 = 12345, SID16 = 54321, OriginalTrainerName = "ASH" };
        Assert.Equal(SaveSummary.Fingerprint(g3), SaveSummary.Fingerprint(g4));
    }
}
