using PKHeX.Core;

namespace SaveService;

public sealed record LegalityReport(bool Ok, int Box, int Slot, string Fingerprint, bool Valid, string Report);

public static class Legality
{
    public static LegalityReport? Check(SaveFile sav, int box, int slot)
    {
        if (box < 0 || box >= sav.BoxCount || slot < 0 || slot >= sav.BoxSlotCount) return null;
        var pk = sav.GetBoxSlotAtIndex(box, slot);
        if (pk.Species == 0) return null;
        var la = new LegalityAnalysis(pk);
        return new LegalityReport(true, box, slot, SaveSummary.Fingerprint(pk), la.Valid, la.Report());
    }
}
