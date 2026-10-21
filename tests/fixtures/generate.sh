#!/bin/sh
# Regenerates the synthetic save fixtures used by tests/integration. They are built
# from scratch by PKHeX.Core (same version as the save service) and contain no
# player data. Run from the repo root: sh tests/fixtures/generate.sh
set -e
docker run --rm -v "$PWD/tests/fixtures":/out mcr.microsoft.com/dotnet/sdk:10.0 sh -c '
cd /tmp && dotnet new console -o gen >/dev/null && cd gen &&
dotnet add package PKHeX.Core --version 26.10.18 >/dev/null &&
cat > Program.cs <<CS
using System.Buffers.Binary;
using PKHeX.Core;

// Minimal valid Emerald layout (same as save-service/tests): sector ids, signature,
// a security key and data past 0x890 so PKHeX reads it as Emerald.
static byte[] RawEmerald()
{
    var d = new byte[0x20000];
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

static byte[] Emerald(byte level)
{
    var sav = new SAV3E(RawEmerald());
    sav.SetBoxSlotAtIndex(new PK3 { Species = (ushort)Species.Pikachu, PID = 0x1234ABCD, TID16 = 12345, SID16 = 54321, OriginalTrainerName = "ASH", CurrentLevel = level }, 0, 0);
    return sav.Write(BinaryExportSetting.None).ToArray();
}

File.WriteAllBytes("/out/synthetic-emerald-lv5.sav", Emerald(5));
File.WriteAllBytes("/out/synthetic-emerald-lv6.sav", Emerald(6)); // same Pikachu, one level later

var b2 = (SAV5)BlankSaveFile.Get(GameVersion.B2, "ASH");
b2.SetBoxSlotAtIndex(new PK5 { Species = (ushort)Species.Snivy, PID = 0xCAFE1234, TID16 = 111, SID16 = 222, OriginalTrainerName = "ASH", CurrentLevel = 5 }, 0, 0);
File.WriteAllBytes("/out/synthetic-black2.sav", b2.Write(BinaryExportSetting.None).ToArray());
CS
dotnet run'
ls -l tests/fixtures/*.sav
